import {
  DEFAULT_ENDPOINT,
  DEFAULT_RANGE,
  escapeRegex,
  exact,
  filterFor,
  jobFilter,
  nodeFilter,
  podPattern,
  quote,
  RANGES,
  replicaSetFilter,
  Schema,
  vmuiUrl,
  workloadFilter,
} from './query';

/** The pattern as the store will apply it, so a case can assert on pod names. */
function matcher(kind: string, name: string): RegExp {
  const pattern = podPattern(kind, name);
  if (!pattern) {
    throw new Error(`no pattern for ${kind}`);
  }
  return new RegExp(pattern);
}

describe('quote', () => {
  it('wraps a plain value', () => {
    expect(quote('hesk')).toBe('"hesk"');
  });

  it('escapes the characters that would end the literal early', () => {
    expect(quote('a"b')).toBe('"a\\"b"');
    expect(quote('a\\b')).toBe('"a\\\\b"');
  });
});

describe('exact', () => {
  // Plain `field:value` matches by word and a hyphen separates words, so a
  // filter for one workload would sweep in every sibling sharing its prefix.
  it('compares the whole value rather than a word of it', () => {
    expect(exact('workload', 'cambase')).toBe('workload:="cambase"');
    expect(exact('workload', 'cambase')).not.toBe('workload:"cambase"');
  });
});

describe('workloadFilter', () => {
  it('matches a workload within its namespace', () => {
    expect(workloadFilter('apps', 'hesk')).toBe('namespace:="apps" workload:="hesk"');
  });

  // The collector resolves a CronJob's executions to the CronJob's own name,
  // so one filter covers every run rather than one pod.
  it('does not name a pod', () => {
    expect(workloadFilter('apps', 'cambase-admin')).not.toContain('pod');
  });
});

describe('jobFilter', () => {
  // A cron job's execution reports the cron job as its workload, so filtering
  // on that field would return every run rather than this one.
  it('matches one execution rather than its schedule', () => {
    expect(jobFilter('apps', 'nightly-29797794')).toBe(
      'namespace:="apps" job_name:="nightly-29797794"'
    );
    expect(jobFilter('apps', 'nightly-29797794')).not.toContain('workload');
  });
});

describe('replicaSetFilter', () => {
  it('matches the pods named after the replica set', () => {
    expect(replicaSetFilter('apps', 'siteapp-74bbfb5f4c')).toBe(
      'namespace:="apps" pod:="siteapp-74bbfb5f4c-"*'
    );
  });

  // The wildcard has to sit outside the literal, or it is matched as a
  // character rather than read as a prefix.
  it('keeps the wildcard out of the quoted value', () => {
    expect(replicaSetFilter('apps', 'siteapp-74bbfb5f4c')).toMatch(/pod:="[^"]+"\*$/);
  });
});

describe('nodeFilter', () => {
  it('scopes to the node and to whichever source names machine logs', () => {
    expect(nodeFilter('a-node', 'talos')).toBe('source:="talos" node:="a-node"');
    expect(nodeFilter('a-node', 'journald')).toBe('source:="journald" node:="a-node"');
  });
});

describe('vmuiUrl', () => {
  const at = DEFAULT_ENDPOINT;

  it('routes through the cluster proxy and puts the query after the hash', () => {
    const url = vmuiUrl({
      cluster: 'main',
      endpoint: at,
      filter: 'namespace:="apps" workload:="hesk"',
    });
    const [path, hash] = url.split('#');
    expect(path).toBe(
      '/clusters/main/api/v1/namespaces/logging/services/victoria-logs:9428/proxy/select/vmui/?'
    );
    expect(hash).toContain('query=namespace%3A%3D%22apps%22+workload%3A%3D%22hesk%22');
    expect(hash).toContain(`g0.relative_time=${DEFAULT_RANGE.relative}`);
  });

  // The whole point of discovering the service: another deployment's name and
  // namespace reach the path without anything being rebuilt.
  it('addresses whichever service was found', () => {
    const url = vmuiUrl({
      cluster: 'main',
      endpoint: { namespace: 'observability', service: 'vlogs-single-server', port: 9428 },
      filter: 'x',
    });
    expect(url).toContain(
      '/api/v1/namespaces/observability/services/vlogs-single-server:9428/proxy/select/vmui/'
    );
  });

  it('carries the chosen window', () => {
    const week = RANGES[RANGES.length - 1];
    const url = vmuiUrl({ cluster: 'main', endpoint: at, filter: 'x', range: week });
    expect(url).toContain(`g0.relative_time=${week.relative}`);
    expect(url).toContain(`g0.range_input=${week.input}`);
  });

  it('ands free text onto the filter', () => {
    const url = vmuiUrl({
      cluster: 'main',
      endpoint: at,
      filter: 'workload:="hesk"',
      search: 'error',
    });
    // Parsed rather than string-matched: the encoder spells a space as `+`,
    // which only a query-string parser reads back as one.
    const params = new URLSearchParams(url.split('?#/?')[1]);
    expect(params.get('query')).toBe('workload:="hesk" error');
  });

  // A cluster name reaches the path, not the hash, so it is the one part of
  // this URL that a stray character could break.
  it('escapes the cluster name into the path', () => {
    expect(vmuiUrl({ cluster: 'a/b', endpoint: at, filter: 'x' })).toContain('/clusters/a%2Fb/');
  });
});

describe('escapeRegex', () => {
  it('makes a dot match only a dot', () => {
    expect(escapeRegex('a.b')).toBe('a\\.b');
  });

  it('leaves a hyphen alone, which is not special outside a character class', () => {
    expect(escapeRegex('a-b')).toBe('a-b');
  });
});

describe('podPattern', () => {
  it('matches the pods a deployment generates', () => {
    expect(matcher('Deployment', 'cambase').test('cambase-58d5457dc8-nkspw')).toBe(true);
  });

  // The reason the suffix alphabet is spelled out rather than [a-z0-9]: the
  // sibling's name segment contains vowels, which a generated suffix never
  // does, so it cannot be read as one.
  it('rejects a sibling whose name merely starts the same', () => {
    const cambase = matcher('Deployment', 'cambase');
    expect(cambase.test('cambase-admin-7d9f4b2c6x-2tcjd')).toBe(false);
    expect(cambase.test('cambase-admin-2tcjd')).toBe(false);
    expect(cambase.test('cambase-admin-29807399-2tcjd')).toBe(false);
  });

  it('matches every execution of a cron job', () => {
    const nightly = matcher('CronJob', 'cambase-admin');
    expect(nightly.test('cambase-admin-29807399-2tcjd')).toBe(true);
    expect(nightly.test('cambase-admin-29808727-86975')).toBe(true);
  });

  it('matches a stateful set by ordinal rather than by hash', () => {
    const db = matcher('StatefulSet', 'db');
    expect(db.test('db-0')).toBe(true);
    expect(db.test('db-11')).toBe(true);
    expect(db.test('db-backup-0')).toBe(false);
  });

  it('has nothing to say about a kind whose pods it cannot name', () => {
    expect(podPattern('Node', 'k8s-cp-pa')).toBeNull();
    expect(podPattern('Service', 'headlamp')).toBeNull();
  });
});

describe('filterFor', () => {
  const at = DEFAULT_ENDPOINT;
  const exactly: Schema = { tier: 'exact', nodeSource: 'talos', endpoint: at };
  const derived: Schema = { tier: 'derived', nodeSource: 'journald', endpoint: at };
  const blind: Schema = { tier: 'derived', nodeSource: null, endpoint: at };

  it('reads the workload field where the store records one', () => {
    expect(filterFor('Deployment', 'hesk', 'apps', exactly)).toBe(
      'namespace:="apps" workload:="hesk"'
    );
  });

  it('falls back to the generated pod names where it does not', () => {
    expect(filterFor('Deployment', 'hesk', 'apps', derived)).toBe(
      'namespace:="apps" pod:~"^hesk-[bcdfghjklmnpqrstvwxz2456789]{5,10}-[bcdfghjklmnpqrstvwxz2456789]{5}$"'
    );
  });

  // Node logs turn on the source having been identified, not on the tier: no
  // generated name separates a node's own records from the containers that ran
  // on it, but nothing about that needs a workload field either.
  it('offers node logs whenever the machine source is known', () => {
    expect(filterFor('Node', 'k8s-cp-pa', undefined, exactly)).toBe(
      'source:="talos" node:="k8s-cp-pa"'
    );
    expect(filterFor('Node', 'k8s-cp-pa', undefined, derived)).toBe(
      'source:="journald" node:="k8s-cp-pa"'
    );
    expect(filterFor('Node', 'k8s-cp-pa', undefined, blind)).toBeNull();
  });

  it('says nothing about a kind it does not cover', () => {
    expect(filterFor('Service', 'headlamp', 'headlamp', exactly)).toBeNull();
    expect(filterFor('Service', 'headlamp', 'headlamp', derived)).toBeNull();
  });

  it('needs a namespace for everything but a node', () => {
    expect(filterFor('Deployment', 'hesk', undefined, exactly)).toBeNull();
  });
});
