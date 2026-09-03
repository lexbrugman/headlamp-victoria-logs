import {
  DEFAULT_RANGE,
  jobFilter,
  nodeFilter,
  quote,
  RANGES,
  replicaSetFilter,
  vmuiUrl,
  workloadFilter,
} from './query';

describe('quote', () => {
  it('wraps a plain value', () => {
    expect(quote('hesk')).toBe('"hesk"');
  });

  it('escapes the characters that would end the literal early', () => {
    expect(quote('a"b')).toBe('"a\\"b"');
    expect(quote('a\\b')).toBe('"a\\\\b"');
  });
});

describe('workloadFilter', () => {
  it('matches a workload within its namespace', () => {
    expect(workloadFilter('apps', 'hesk')).toBe('namespace:"apps" workload:"hesk"');
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
      'namespace:"apps" job_name:"nightly-29797794"'
    );
    expect(jobFilter('apps', 'nightly-29797794')).not.toContain('workload');
  });
});

describe('replicaSetFilter', () => {
  it('matches the pods named after the replica set', () => {
    expect(replicaSetFilter('apps', 'siteapp-74bbfb5f4c')).toBe(
      'namespace:"apps" pod:"siteapp-74bbfb5f4c-"*'
    );
  });

  // The wildcard has to sit outside the literal, or it is matched as a
  // character rather than read as a prefix.
  it('keeps the wildcard out of the quoted value', () => {
    expect(replicaSetFilter('apps', 'siteapp-74bbfb5f4c')).toMatch(/pod:"[^"]+"\*$/);
  });
});

describe('nodeFilter', () => {
  it('scopes to the node and to Talos', () => {
    expect(nodeFilter('a-node')).toBe('source:"talos" node:"a-node"');
  });
});

describe('vmuiUrl', () => {
  it('routes through the cluster proxy and puts the query after the hash', () => {
    const url = vmuiUrl({ cluster: 'main', filter: 'namespace:"apps" workload:"hesk"' });
    const [path, hash] = url.split('#');
    expect(path).toBe(
      '/clusters/main/api/v1/namespaces/logging/services/victoria-logs:9428/proxy/select/vmui/?'
    );
    expect(hash).toContain('query=namespace%3A%22apps%22+workload%3A%22hesk%22');
    expect(hash).toContain(`g0.relative_time=${DEFAULT_RANGE.relative}`);
  });

  it('carries the chosen window', () => {
    const week = RANGES[RANGES.length - 1];
    const url = vmuiUrl({ cluster: 'main', filter: 'x', range: week });
    expect(url).toContain(`g0.relative_time=${week.relative}`);
    expect(url).toContain(`g0.range_input=${week.input}`);
  });

  it('ands free text onto the filter', () => {
    const url = vmuiUrl({ cluster: 'main', filter: 'workload:"hesk"', search: 'error' });
    // Parsed rather than string-matched: the encoder spells a space as `+`,
    // which only a query-string parser reads back as one.
    const params = new URLSearchParams(url.split('?#/?')[1]);
    expect(params.get('query')).toBe('workload:"hesk" error');
  });

  // A cluster name reaches the path, not the hash, so it is the one part of
  // this URL that a stray character could break.
  it('escapes the cluster name into the path', () => {
    expect(vmuiUrl({ cluster: 'a/b', filter: 'x' })).toContain('/clusters/a%2Fb/');
  });
});
