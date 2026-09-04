import { findEndpoint, listValues, machineSource, readStats, recognises, SourceStats } from './schema';

/** A service as the apiserver lists it, trimmed to what discovery reads. */
function service(namespace: string, name: string, ...ports: number[]) {
  return { metadata: { name, namespace }, spec: { ports: ports.map(port => ({ port })) } };
}

describe('findEndpoint', () => {
  it('recognises a store by the port rather than by its name', () => {
    expect(
      findEndpoint({ items: [service('observability', 'vlogs-victoria-logs-single-server', 9428)] })
    ).toEqual({ namespace: 'observability', service: 'vlogs-victoria-logs-single-server', port: 9428 });
  });

  it('passes over services that serve something else', () => {
    expect(
      findEndpoint({
        items: [service('apps', 'hesk', 80), service('obs', 'vl', 9428), service('apps', 'db', 3306)],
      })
    ).toEqual({ namespace: 'obs', service: 'vl', port: 9428 });
  });

  it('reads a port among several a service exposes', () => {
    expect(findEndpoint({ items: [service('obs', 'vl', 8428, 9428)] })).toEqual({
      namespace: 'obs',
      service: 'vl',
      port: 9428,
    });
  });

  // Two stores mean no way to tell which was meant, and reading the wrong one
  // would look like working rather than like a mistake.
  it('declines when more than one could be it', () => {
    expect(
      findEndpoint({ items: [service('a', 'vl', 9428), service('b', 'vl', 9428)] })
    ).toBeNull();
  });

  it('treats an answer it cannot read as nothing found', () => {
    expect(findEndpoint(null)).toBeNull();
    expect(findEndpoint({ items: [{ metadata: { name: 'x' } }] })).toBeNull();
    expect(findEndpoint({ items: [service('a', 'vl')] })).toBeNull();
  });
});

describe('recognises', () => {
  it('needs a field a resource can actually be matched by', () => {
    expect(recognises(['namespace', 'pod', '_msg'])).toBe(true);
    expect(recognises(['namespace', 'workload'])).toBe(true);
  });

  // Another collector's schema: nothing here can build a filter, and saying so
  // beats naming a way of matching that would return nothing.
  it('rejects a schema none of these queries fit', () => {
    expect(recognises(['kubernetes_pod_name', 'kubernetes_namespace_name'])).toBe(false);
    expect(recognises([])).toBe(false);
  });
});

/** The classification, which no longer decides the tier on its own. */
function classify(stats: SourceStats[]) {
  return {
    tier: stats.some(entry => entry.withWorkload > 0) ? 'exact' : 'derived',
    nodeSource: machineSource(stats),
  };
}

/** The shape a store answers a per-source stats query with. */
function stats(source: string, total: number, withPod: number, withWorkload: number): SourceStats {
  return { source, total, withPod, withWorkload };
}

describe('listValues', () => {
  it('reads the values out of a field-values answer', () => {
    expect(
      listValues({
        values: [
          { value: 'talos', hits: 7669647 },
          { value: 'kubernetes', hits: 5527850 },
        ],
      })
    ).toEqual(['talos', 'kubernetes']);
  });

  // A store that cannot be reached, or answers with something unexpected, must
  // read as absence rather than throwing inside a details page.
  it('treats an unusable answer as nothing found', () => {
    expect(listValues(null)).toEqual([]);
    expect(listValues({})).toEqual([]);
    expect(listValues({ values: 'talos' })).toEqual([]);
    expect(listValues({ values: [{ hits: 1 }] })).toEqual([]);
  });
});

describe('readStats', () => {
  // The store spells counts as strings, and omits a column it counted nothing
  // for rather than reporting a zero.
  it('reads counts however they are spelled', () => {
    expect(readStats('talos', { total: '7669439', with_pod: '31', with_workload: '0' })).toEqual(
      stats('talos', 7669439, 31, 0)
    );
    expect(readStats('talos', {})).toEqual(stats('talos', 0, 0, 0));
    expect(readStats('talos', null)).toEqual(stats('talos', 0, 0, 0));
  });
});

describe('classify', () => {
  // The measured shape of a cluster: every container record names a pod, and
  // a handful of the node's own records quote one because the kubelet logs
  // about pods.
  const measured = [
    stats('kubernetes', 5527814, 5527814, 5527814),
    stats('talos', 7669439, 31, 0),
  ];

  it('reads the workload field where a collector records one', () => {
    expect(classify(measured).tier).toBe('exact');
  });

  it('names the source that carries machine logs', () => {
    expect(classify(measured).nodeSource).toBe('talos');
  });

  // The whole point of classifying the source rather than testing each record:
  // those 31 kubelet lines are a node's own logs and must not be excluded from
  // its history just because they mention a pod.
  it('is not disturbed by the node component that quotes a pod', () => {
    expect(classify([stats('kubernetes', 100, 100, 100), stats('talos', 100000, 900, 0)]).nodeSource).toBe(
      'talos'
    );
  });

  // The reason this works without a collector: nothing here reads `workload`.
  it('still names the machine source where no workload field exists', () => {
    const derived = [stats('kubernetes', 5527814, 5527814, 0), stats('talos', 7669439, 31, 0)];
    expect(classify(derived)).toEqual({ tier: 'derived', nodeSource: 'talos' });
  });

  it('declines when there is nothing to tell apart', () => {
    expect(classify([stats('kubernetes', 100, 100, 100)]).nodeSource).toBeNull();
    expect(classify([]).nodeSource).toBeNull();
  });

  // Two machine-like sources leave nothing to choose between, so neither is
  // offered rather than guessing at one.
  it('declines when more than one source looks like machine logs', () => {
    expect(
      classify([
        stats('kubernetes', 1000, 1000, 1000),
        stats('talos', 1000, 0, 0),
        stats('journald', 1000, 0, 0),
      ]).nodeSource
    ).toBeNull();
  });

  it('ignores a source that has recorded nothing at all', () => {
    expect(
      classify([stats('kubernetes', 1000, 1000, 1000), stats('talos', 1000, 0, 0), stats('idle', 0, 0, 0)])
        .nodeSource
    ).toBe('talos');
  });

  // A source with a handful of records scores a perfect zero on no evidence,
  // and would otherwise outrank the one that has actually been measured.
  it('does not let a barely-used source win on noise', () => {
    expect(
      classify([
        stats('kubernetes', 100000, 100000, 100000),
        stats('talos', 100000, 31, 0),
        stats('newcomer', 3, 0, 0),
      ]).nodeSource
    ).toBe('talos');
  });

  // The separation is what identifies machine logs, not the level: a collector
  // that leaves some container records unlabelled is still one this can read.
  it('recognises a container source that does not label everything', () => {
    expect(classify([stats('other', 100000, 70000, 0), stats('journald', 100000, 4, 0)]).nodeSource).toBe(
      'journald'
    );
  });

  // Close together means neither is distinctive, however they are ordered.
  it('declines when the two are merely different rather than far apart', () => {
    expect(classify([stats('a', 100000, 60000, 0), stats('b', 100000, 40000, 0)]).nodeSource).toBeNull();
    expect(classify([stats('a', 100000, 5000, 0), stats('b', 100000, 500, 0)]).nodeSource).toBeNull();
  });
});
