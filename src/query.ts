/**
 * Deep links into VictoriaLogs' own UI, built from the resource on screen.
 *
 * Every function here is pure so the link this plugin produces is testable
 * without a browser or a cluster: the component is a form around a string
 * these functions return.
 */

/** A relative window, spelled the two ways vmui reads it from the URL. */
export interface Range {
  label: string;
  /** vmui's named window, `g0.relative_time`. */
  relative: string;
  /** The same window as a duration, `g0.range_input`. */
  input: string;
}

export const RANGES: Range[] = [
  { label: 'Last 15 minutes', relative: 'last_15_minutes', input: '15m' },
  { label: 'Last hour', relative: 'last_1_hour', input: '1h' },
  { label: 'Last 6 hours', relative: 'last_6_hours', input: '6h' },
  { label: 'Last 24 hours', relative: 'last_24_hours', input: '24h' },
  { label: 'Last 3 days', relative: 'last_3_days', input: '3d' },
  { label: 'Last 7 days', relative: 'last_7_days', input: '7d' },
];

export const DEFAULT_RANGE = RANGES[1];

/**
 * How a workload's records are recognised.
 *
 * `exact` reads a `workload` field the collector resolved from the pod's owner
 * chain. `derived` has no such field and matches the pod names Kubernetes
 * generates for the kind instead — everything the plugin offers except node
 * logs, without asking anything of the collector.
 */
export type Tier = 'exact' | 'derived';

/**
 * A LogsQL string literal. Kubernetes names cannot contain either character
 * escaped here, so this guards the field values that are not names — a free
 * text filter a user typed — rather than the ones that are.
 */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A term matching a field's whole value. LogsQL's plain `field:value` matches
 * by word and treats a hyphen as a separator, so `workload:"cambase"` also
 * matches `cambase-admin` and `cambase-home` — sibling workloads whose logs
 * must not be mixed into one another's. `:=` compares the value entire.
 */
export function exact(field: string, value: string): string {
  return `${field}:=${quote(value)}`;
}

/**
 * The alphabet Kubernetes draws generated name suffixes from. It omits every
 * vowel, which is what lets a pattern tell a hash from a word: a sibling named
 * `cambase-admin` cannot be read as `cambase` plus a suffix, because `admin`
 * is not a string this alphabet can produce.
 */
const SUFFIX = '[bcdfghjklmnpqrstvwxz2456789]';

/** A name as a regex literal, so a `.` in it cannot match anything else. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A term matching a field against a regular expression. */
export function matches(field: string, pattern: string): string {
  return `${field}:~${quote(pattern)}`;
}

/**
 * The pod names Kubernetes generates for a workload of each kind, anchored so
 * a longer sibling name cannot satisfy the pattern: its pods carry an extra
 * segment and the anchors reject them.
 *
 * Returns null for a kind whose pods this cannot identify, which is what keeps
 * the plugin silent rather than wrong.
 */
export function podPattern(kind: string, name: string): string | null {
  const n = escapeRegex(name);
  switch (kind) {
    // A replica set hash and then the pod's own suffix.
    case 'Deployment':
      return `^${n}-${SUFFIX}{5,10}-${SUFFIX}{5}$`;
    // A stable ordinal rather than a random suffix.
    case 'StatefulSet':
      return `^${n}-[0-9]+$`;
    case 'DaemonSet':
    case 'Job':
    case 'ReplicaSet':
      return `^${n}-${SUFFIX}{5}$`;
    // The schedule names each job for the minute it fired, and the job names
    // its pods, so both segments appear.
    case 'CronJob':
      return `^${n}-[0-9]{8,12}-${SUFFIX}{5}$`;
    default:
      return null;
  }
}

/**
 * The filter for one workload's logs, across every pod that has ever served
 * it. `workload` is the collector's own field, resolved at ingestion from the
 * pod's owner reference, so this matches incarnations that no longer exist —
 * which is the whole reason to look here rather than at the pod log endpoint.
 */
export function workloadFilter(namespace: string, workload: string): string {
  return `${exact('namespace', namespace)} ${exact('workload', workload)}`;
}

/**
 * The filter for one job's logs — its own execution, not the schedule it came
 * from. A job created by a cron job reports the cron job as its workload, so
 * that field would name the wrong thing here; the job name is on every job's
 * pods either way, whether a schedule created them or a person did.
 */
export function jobFilter(namespace: string, job: string): string {
  return `${exact('namespace', namespace)} ${exact('job_name', job)}`;
}

/**
 * The filter for one replica set's logs. The collector resolves a pod's owner
 * chain up to the deployment, so no field names the replica set itself — but
 * its pods are named after it, which is enough to tell one generation of a
 * rollout from another.
 */
export function replicaSetFilter(namespace: string, replicaSet: string): string {
  return `${exact('namespace', namespace)} pod:=${quote(`${replicaSet}-`)}*`;
}

/**
 * The filter for one node's own logs. Container logs carry `node` too, so a
 * discriminator is what keeps this to the machine's own streams rather than
 * everything that ran on it. Which value that is belongs to the collector, so
 * it is discovered rather than assumed.
 */
export function nodeFilter(node: string, source: string): string {
  return `${exact('source', source)} ${exact('node', node)}`;
}

/** Where VictoriaLogs answers, as the apiserver proxy addresses it. */
export interface Endpoint {
  namespace: string;
  service: string;
  port: number;
}

/**
 * The port VictoriaLogs serves on. A service exposing it is how an install is
 * recognised, since its name and namespace are the deployer's to choose.
 */
export const VICTORIA_LOGS_PORT = 9428;

/** Where to look before anything has been found, and if nothing is. */
export const DEFAULT_ENDPOINT: Endpoint = {
  namespace: 'logging',
  service: 'victoria-logs',
  port: VICTORIA_LOGS_PORT,
};

/** What the store on the other end turned out to hold. */
export interface Schema {
  tier: Tier;
  /**
   * The `source` value naming machine logs, or null where they cannot be told
   * apart from the container logs sharing a node.
   */
  nodeSource: string | null;
  endpoint: Endpoint;
}

/**
 * Kinds whose pods come and go while the thing itself persists. Headlamp's
 * own log view reads the kubelet, so it can only show pods that still exist;
 * these are the pages where that difference is felt.
 */
export const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'];

/**
 * The filter for a resource, or null where this plugin has nothing to add.
 *
 * Only the exact tier reads a field per kind — a job by its own name, a replica
 * set by its pods' prefix. The derived tier has one mechanism for all of them,
 * because a generated pod name is the only thing it can tell them apart by.
 */
export function filterFor(
  kind: string | undefined,
  name: string | undefined,
  namespace: string | undefined,
  schema: Schema
): string | null {
  const { tier } = schema;
  if (!kind || !name) {
    return null;
  }
  if (kind === 'Node') {
    return schema.nodeSource ? nodeFilter(name, schema.nodeSource) : null;
  }
  if (!namespace) {
    return null;
  }
  if (tier === 'exact') {
    // A replica set is one generation of a deployment, so it narrows to its own
    // pods rather than reporting the deployment's whole history.
    if (kind === 'ReplicaSet') {
      return replicaSetFilter(namespace, name);
    }
    if (kind === 'Job') {
      return jobFilter(namespace, name);
    }
    if (WORKLOAD_KINDS.includes(kind)) {
      return workloadFilter(namespace, name);
    }
    return null;
  }
  const pattern = podPattern(kind, name);
  return pattern ? `${exact('namespace', namespace)} ${matches('pod', pattern)}` : null;
}

/** The path the apiserver proxies to VictoriaLogs, without a leading cluster. */
export function servicePath(endpoint: Endpoint, suffix: string): string {
  const { namespace, service, port } = endpoint;
  return `/api/v1/namespaces/${namespace}/services/${service}:${port}/proxy/${suffix}`;
}

export interface LinkOptions {
  /** The name Headlamp knows this cluster by, which routes the proxy below. */
  cluster: string;
  endpoint: Endpoint;
  filter: string;
  range?: Range;
  /** Free text the user added, ANDed onto the filter. */
  search?: string;
}

/**
 * VictoriaLogs is reachable only inside the cluster, so the link goes through
 * the apiserver's service proxy, which Headlamp's backend fronts with the
 * viewer's own session — no second credential, and nothing exposed publicly.
 *
 * The parameters sit after the `#`, where they stay in the browser: neither
 * Headlamp nor the apiserver ever parses a LogsQL query out of this path.
 */
export function vmuiUrl({
  cluster,
  endpoint,
  filter,
  range = DEFAULT_RANGE,
  search,
}: LinkOptions): string {
  const base = `/clusters/${encodeURIComponent(cluster)}${servicePath(endpoint, 'select/vmui/')}`;
  const query = search ? `${filter} ${search}` : filter;
  const params = new URLSearchParams({
    query,
    'g0.relative_time': range.relative,
    'g0.range_input': range.input,
    limit: '500',
  });
  return `${base}?#/?${params.toString()}`;
}
