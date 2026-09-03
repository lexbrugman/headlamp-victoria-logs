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
 * A LogsQL string literal. Kubernetes names cannot contain either character
 * escaped here, so this guards the field values that are not names — a free
 * text filter a user typed — rather than the ones that are.
 */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The filter for one workload's logs, across every pod that has ever served
 * it. `workload` is the collector's own field, resolved at ingestion from the
 * pod's owner reference, so this matches incarnations that no longer exist —
 * which is the whole reason to look here rather than at the pod log endpoint.
 */
export function workloadFilter(namespace: string, workload: string): string {
  return `namespace:${quote(namespace)} workload:${quote(workload)}`;
}

/**
 * The filter for one node's own logs. Container logs carry `node` too, so the
 * source discriminator is what keeps this to Talos' service and kernel
 * streams rather than everything that ran on the box.
 */
export function nodeFilter(node: string): string {
  return `source:${quote('talos')} node:${quote(node)}`;
}

/**
 * Where VictoriaLogs answers. Stated once because a deployment that puts it
 * elsewhere changes only these two lines.
 */
export const SERVICE_NAMESPACE = 'logging';
export const SERVICE_PORT = 'victoria-logs:9428';

export interface LinkOptions {
  /** The name Headlamp knows this cluster by, which routes the proxy below. */
  cluster: string;
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
export function vmuiUrl({ cluster, filter, range = DEFAULT_RANGE, search }: LinkOptions): string {
  const base =
    `/clusters/${encodeURIComponent(cluster)}/api/v1/namespaces/` +
    `${SERVICE_NAMESPACE}/services/${SERVICE_PORT}/proxy/select/vmui/`;
  const query = search ? `${filter} ${search}` : filter;
  const params = new URLSearchParams({
    query,
    'g0.relative_time': range.relative,
    'g0.range_input': range.input,
    limit: '500',
  });
  return `${base}?#/?${params.toString()}`;
}
