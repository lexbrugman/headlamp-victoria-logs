/**
 * What the VictoriaLogs on the other end actually is, and holds.
 *
 * Where it answers, how workloads are named in it, and which of its records
 * belong to a machine rather than a container are all properties of somebody
 * else's deployment. Each is asked for once rather than configured.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { useEffect, useState } from 'react';
import {
  DEFAULT_ENDPOINT,
  Endpoint,
  quote,
  Schema,
  servicePath,
  VICTORIA_LOGS_PORT,
} from './query';

/**
 * `checking` and `unavailable` are distinct on purpose: an empty view means
 * something different while the answer is still unknown than it does once the
 * store has been asked and could not answer. `unrecognised` is the third — the
 * store answered, and holds nothing these queries can be built from.
 */
export type Detection = 'checking' | 'workload' | 'pods' | 'unrecognised' | 'unavailable';

export interface Detected extends Schema {
  detection: Detection;
}

/** What one `source` value's records look like. */
export interface SourceStats {
  source: string;
  total: number;
  withPod: number;
  withWorkload: number;
}

/** The `value` of each entry a field-values answer lists. */
export function listValues(payload: unknown): string[] {
  const values = (payload as { values?: unknown })?.values;
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map(entry => (entry as { value?: unknown })?.value)
    .filter((value): value is string => typeof value === 'string');
}

/**
 * The service a VictoriaLogs answers on, recognised by the port rather than by
 * a name or a namespace, both of which belong to whoever deployed it.
 *
 * Null unless exactly one matches: several mean there is no way to tell which
 * was intended, and guessing at one would silently read the wrong store.
 */
export function findEndpoint(payload: unknown): Endpoint | null {
  const items = (payload as { items?: unknown })?.items;
  if (!Array.isArray(items)) {
    return null;
  }
  const found: Endpoint[] = [];
  for (const item of items) {
    const meta = (item as { metadata?: { name?: unknown; namespace?: unknown } })?.metadata;
    const ports = (item as { spec?: { ports?: unknown } })?.spec?.ports;
    if (typeof meta?.name !== 'string' || typeof meta?.namespace !== 'string') {
      continue;
    }
    const serves =
      Array.isArray(ports) &&
      ports.some(port => (port as { port?: unknown })?.port === VICTORIA_LOGS_PORT);
    if (serves) {
      found.push({ namespace: meta.namespace, service: meta.name, port: VICTORIA_LOGS_PORT });
    }
  }
  return found.length === 1 ? found[0] : null;
}

/** Counts arrive as strings, and a missing one means none rather than NaN. */
function count(payload: unknown, key: string): number {
  const raw = (payload as Record<string, unknown> | null)?.[key];
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function readStats(source: string, payload: unknown): SourceStats {
  return {
    source,
    total: count(payload, 'total'),
    withPod: count(payload, 'with_pod'),
    withWorkload: count(payload, 'with_workload'),
  };
}

/**
 * Enough records for a proportion to be a measurement rather than noise. A
 * source that names no pod in its first handful of lines has not said anything
 * yet; one that names none in a hundred, while another names one in most of a
 * hundred, has.
 */
const ENOUGH = 100;

/**
 * How much more often the next source must name a pod. This is a ratio rather
 * than a level because the level is the collector's business: what matters is
 * that the two are far apart, not where either sits.
 */
const SEPARATION = 100;

/**
 * And a floor under that next source, since naming pods *often* is what makes
 * a source container logs at all. Deliberately weak — a majority, not a near
 * certainty — so a collector that leaves some container records unlabelled is
 * still recognised.
 */
const MOST = 0.5;

/**
 * The source naming machine logs.
 *
 * Container records name a pod; machine records do not, save for the handful
 * where a node component quotes one — the kubelet logs about pods, so a few of
 * its own lines carry the key. That is why this reads as a proportion rather
 * than as an absence: a per-record test excludes exactly those lines from a
 * node's own history, while classifying the source keeps them.
 */
export function machineSource(stats: SourceStats[]): string | null {
  const rated = stats
    .filter(entry => entry.total >= ENOUGH)
    .map(entry => ({ source: entry.source, pods: entry.withPod / entry.total }))
    .sort((a, b) => a.pods - b.pods);

  // Nothing to compare against, so nothing to conclude.
  if (rated.length < 2) {
    return null;
  }
  const [candidate, rival] = rated;
  const separated = rival.pods >= MOST && candidate.pods * SEPARATION <= rival.pods;
  return separated ? candidate.source : null;
}

/**
 * Which fields have to be there for anything to be answerable. Without them
 * every query returns nothing, and saying so beats naming a way of matching
 * that cannot work.
 */
export function recognises(fields: string[]): boolean {
  return fields.includes('pod') || fields.includes('workload');
}

/**
 * A week, so a store that has only just started collecting still answers, and
 * a field that stopped being produced days ago no longer counts.
 */
const WINDOW = '_time:7d';

/**
 * A store reporting many sources is not one this can reason about, and each
 * costs a request; separating machine logs from container logs needs two.
 */
const MAX_SOURCES = 4;

function ask(cluster: string, endpoint: Endpoint, path: string): Promise<unknown> {
  return ApiProxy.clusterRequest(servicePath(endpoint, `select/logsql/${path}`), { cluster });
}

function statsFor(cluster: string, endpoint: Endpoint, source: string): Promise<SourceStats> {
  const query = `${WINDOW} source:=${quote(source)} | stats count() total, count(pod) with_pod, count(workload) with_workload`;
  return ask(cluster, endpoint, `query?query=${encodeURIComponent(query)}`).then(payload =>
    readStats(source, payload)
  );
}

/**
 * Listing services is more than a details page needs, so a viewer may well not
 * be allowed to. That is not a failure: it means the deployment has to be the
 * expected one, which is what it was before anything was discovered.
 */
async function locate(cluster: string): Promise<Endpoint> {
  const services = await ApiProxy.clusterRequest('/api/v1/services', { cluster }).catch(() => null);
  return findEndpoint(services) ?? DEFAULT_ENDPOINT;
}

async function inspect(cluster: string): Promise<Detected> {
  const endpoint = await locate(cluster);
  const fields = listValues(
    await ask(cluster, endpoint, `field_names?query=${encodeURIComponent(WINDOW)}`)
  );
  if (!recognises(fields)) {
    return { tier: 'derived', nodeSource: null, endpoint, detection: 'unrecognised' };
  }
  const tier = fields.includes('workload') ? 'exact' : 'derived';
  const detection: Detection = tier === 'exact' ? 'workload' : 'pods';

  const sources = listValues(
    await ask(
      cluster,
      endpoint,
      `field_values?field=source&query=${encodeURIComponent(WINDOW)}`
    ).catch(() => null)
  );
  if (sources.length === 0 || sources.length > MAX_SOURCES) {
    return { tier, nodeSource: null, endpoint, detection };
  }
  const stats = await Promise.all(sources.map(source => statsFor(cluster, endpoint, source)));
  return { tier, nodeSource: machineSource(stats), endpoint, detection };
}

/**
 * One probe per cluster, shared by every page: what it learns is a property of
 * the store, not of the resource being viewed, and detail pages would otherwise
 * ask again on each navigation.
 */
const probes = new Map<string, Promise<Detected>>();

function probe(cluster: string): Promise<Detected> {
  const existing = probes.get(cluster);
  if (existing) {
    return existing;
  }
  const started = inspect(cluster).catch(
    (): Detected => ({
      tier: 'derived',
      nodeSource: null,
      endpoint: DEFAULT_ENDPOINT,
      detection: 'unavailable',
    })
  );
  probes.set(cluster, started);
  return started;
}

const CHECKING: Detected = {
  tier: 'derived',
  nodeSource: null,
  endpoint: DEFAULT_ENDPOINT,
  detection: 'checking',
};

export function useSchema(cluster: string | null | undefined): Detected {
  const [schema, setSchema] = useState<Detected>(CHECKING);

  useEffect(() => {
    if (!cluster) {
      return undefined;
    }
    let live = true;
    setSchema(CHECKING);
    probe(cluster).then(result => {
      if (live) {
        setSchema(result);
      }
    });
    return () => {
      live = false;
    };
  }, [cluster]);

  return schema;
}
