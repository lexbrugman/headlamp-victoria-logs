# headlamp-victoria-logs

Persistent workload logs in [Headlamp](https://headlamp.dev), served from
[VictoriaLogs](https://docs.victoriametrics.com/victorialogs/).

Headlamp's built-in log view streams from the kubelet, so it can only show pods
that still exist. A Deployment that has rolled, a Job whose pods were reaped, a
CronJob execution from yesterday — none of them have logs to stream any more.
This plugin adds a section to those pages that opens the same workload's logs in
VictoriaLogs, with the query already built from the resource on screen.

It does not replace the built-in view. Pod logs stay where they are; this covers
the workload above them, which outlives its pods.

## Where it attaches

Deployment, StatefulSet, DaemonSet and CronJob pages get the workload's whole
history. A Job page gets that execution alone; a ReplicaSet page gets the pods
that one generation created, which is what makes two sides of a rollout
comparable. A Node page gets the node's own records, where the store keeps them
apart from the containers that ran on it.

## How it matches

Nothing has to be configured for this to work, and nothing needs to be
configured to make it better either. On first use against a cluster the plugin
asks VictoriaLogs what it holds, and identifies workloads in one of two ways
depending on the answer. **The section states which one it used**, because an
empty result means something different under each.

### A recorded `workload` field

The precise route. Each record already names the workload it belongs to, so a
query is an exact term and nothing is inferred:

```
namespace:="apps" workload:="hesk"
```

Terms are exact (`:=`) rather than LogsQL's default word match, which treats a
hyphen as a separator — under that, a filter for `cambase` also returns
`cambase-admin` and `cambase-home`.

### Generated pod names

The fallback, used when no such field is recorded. Kubernetes names a pod after
the thing that created it, so the pod name can be matched against the shape its
kind produces:

```
namespace:="apps" pod:~"^hesk-[bcdfghjklmnpqrstvwxz2456789]{5,10}-[bcdfghjklmnpqrstvwxz2456789]{5}$"
```

That alphabet is not decoration. Kubernetes draws generated suffixes from a
vowel-free set, so a sibling called `cambase-admin` cannot be read as `cambase`
plus a suffix — `admin` is not a string the generator can produce. Together with
the anchors, that keeps a workload's pods apart from those of a longer-named
neighbour.

What differs between the two:

| | `workload` field | generated pod names |
| --- | --- | --- |
| Deployment, StatefulSet, DaemonSet | yes | yes |
| CronJob, across every execution | yes | yes |
| Job, ReplicaSet | yes | yes |
| Pods named outside the usual pattern | yes | no |
| Controllers the plugin has never heard of | yes | no |
| Asks anything of your collector | yes | no |

The last three rows are the reason to record the field. Pod-name shapes are a
convention, not a guarantee: a long workload name gets truncated when the
generated name is built, a custom controller may name pods however it likes, and
either way the fallback returns nothing while looking exactly like a workload
that has simply been quiet.

### Neither

A store recording neither `pod` nor `workload` holds nothing these queries can
be built from — its collector labels records some other way entirely. The
section then says so instead of naming a way of matching that would return
nothing, and offers no link, since the view behind it would be empty by
construction.

## Recording a workload field

The plugin builds queries; it ingests nothing. To take the precise route, ship
logs with these fields — `workload` is the one that matters, the rest sharpen
particular pages:

| Field | Meaning | Used for |
| --- | --- | --- |
| `namespace` | the workload's namespace | every query |
| `workload` | the workload's own name — **not** the pod's, and stable across pod incarnations | the precise route |
| `pod` | the pod that wrote the record | the fallback, and ReplicaSet pages |
| `job_name` | the job a record came from, where one did | telling one execution from its schedule |
| `node` | the node the record came from | Node pages |
| `source` | what produced the record, e.g. `kubernetes` for containers | separating node logs from container logs |

Resolve `workload` at ingestion from the pod's owner reference, walking up to
the controller that owns it: a ReplicaSet's Deployment, a Job's CronJob. Doing
it there rather than at query time is what makes the history answerable, because
the pod that wrote a record is usually gone by the time anyone asks. Where the
owner chain does not reach far enough, an explicit label on the pod is the
escape hatch — the fallback has no equivalent, which is why an unusual
controller is the case it cannot serve.

Node logs need `source` for a different reason, described next.

## Node logs

A node's own logs and the logs of the containers that ran on it both carry
`node`, so something has to tell them apart. That something is `source` — but
which of its values means "the machine itself" is the collector's choice, so
the plugin works it out rather than assuming a name.

It compares how often each source's records name a pod. Container logs name one
every time; machine logs essentially never do, so the source that hardly ever
does is the machine one. Whatever it happens to be called — `talos`, `journald`,
`systemd` — Node pages work without configuration, and they work under either of
the two ways of matching above, because nothing in this reads `workload`.

The comparison is deliberately made per source rather than per record. A node
runs components that log *about* pods — the kubelet reports on containers by
name — so a handful of genuine machine records do carry a pod. Excluding records
individually would drop exactly those lines from a node's history; classifying
the source keeps them.

Where no single source stands out — none look like machine logs, or several do —
Node pages are left out rather than answered with a guess.

## Access model

VictoriaLogs is reached through the Kubernetes apiserver's service proxy, which
Headlamp's backend fronts with the viewer's own session:

```
/clusters/<cluster>/api/v1/namespaces/<ns>/services/<service>:<port>/proxy/select/vmui/
```

So VictoriaLogs needs no ingress, no separate credential and no public exposure,
and the viewer signs in once — to Headlamp. Reaching it this way requires
permission to proxy to services in that namespace.

The query travels in the URL fragment, after the `#`, so it never reaches either
the apiserver or Headlamp's backend; only the browser and VictoriaLogs' own UI
ever parse it.

## Configuration

None. VictoriaLogs is found by looking for a service exposing port `9428`,
whatever it is called and wherever it lives, since the name and the namespace
belong to whoever deployed it.

Two cases fall back to `logging/victoria-logs`: more than one service exposes
that port, so there is no way to tell which was meant; or the viewer is not
allowed to list services, which is more than a details page otherwise needs and
so may well be denied.

## Installing

Releases are published to Artifact Hub, so Headlamp's plugin manager installs
this the same way it installs any other plugin:

```yaml
plugins:
  - name: headlamp_victoria_logs
    source: https://artifacthub.io/packages/headlamp/headlamp-victoria-logs/headlamp_victoria_logs
    version: <version>
```

The installer verifies the archive against the checksum published with each
version.

## Development

The [Dockerfile](Dockerfile) is the toolchain, so a checkout needs no Node of
its own and the pinned version is stated in one place:

```
podman build -t headlamp-victoria-logs-dev .
podman run --rm -v "$PWD:/src:z" headlamp-victoria-logs-dev \
    sh -c 'npm ci && npm run tsc && npm run lint && npm test'
```

The query builders in `src/query.ts` are pure functions and carry the tests; the
component around them is a form and a link, so the part that can break quietly
is the part under test.
