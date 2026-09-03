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

| Page | Query |
| --- | --- |
| Deployment, StatefulSet, DaemonSet, CronJob | `namespace:=<ns> workload:=<name>` |
| Job | `namespace:=<ns> job_name:=<name>` |
| ReplicaSet | `namespace:=<ns> pod:=<name>-*` |
| Node | `source:="talos" node:=<name>` |

The terms are exact (`:=`) rather than LogsQL's default word match, which
treats a hyphen as a separator — under that, a filter for `cambase` also
returns `cambase-admin` and `cambase-home`.

A CronJob's page covers every execution, because the collector resolves each
one back to the schedule that created it. A Job's page covers only itself, for
the same reason — its workload field names the schedule, so the job name is
what distinguishes one run.

A ReplicaSet narrows to the pods it created rather than reporting its
Deployment's whole history, which is what makes one generation of a rollout
comparable with the one it replaced.

## The log schema (published interface)

This plugin builds queries; it does not ingest anything. Whatever ships logs
into VictoriaLogs must label them with these fields, or the queries match
nothing:

| Field | Meaning |
| --- | --- |
| `namespace` | the workload's namespace |
| `workload` | the workload's own name — **not** the pod's, and stable across pod incarnations |
| `pod` | the pod that wrote the record |
| `job_name` | the job a record came from, where one did |
| `node` | the node the record came from |
| `source` | `kubernetes` for container logs, `talos` for node logs |

`workload` is the load-bearing one. A collector that records only the pod name
cannot answer "show me this Deployment's logs", because the pod that wrote them
is usually gone. Deriving it at ingestion — from the pod's owner reference, and
from an explicit label where the owner chain does not reach far enough — is what
makes the history queryable.

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

The namespace and service VictoriaLogs answers on are constants at the top of
[`src/query.ts`](src/query.ts). A deployment that puts it elsewhere changes those
two lines.

## Installing

Releases are published to Artifact Hub, so Headlamp's plugin manager installs
this the same way it installs any other plugin:

```yaml
plugins:
  - name: headlamp_victoria_logs
    source: https://artifacthub.io/packages/headlamp/<repository>/headlamp_victoria_logs
    version: <version>
```

The installer verifies the archive against the checksum published with each
version.

## Development

The build stage of the [Dockerfile](Dockerfile) is the toolchain, so a checkout
needs no Node of its own and the pinned version is stated in one place:

```
podman build --target build -t headlamp-victoria-logs-dev .
podman run --rm -v "$PWD:/src:z" headlamp-victoria-logs-dev \
    sh -c 'npm ci && npm run tsc && npm run lint && npm test'
```

The query builders in `src/query.ts` are pure functions and carry the tests; the
component around them is a form and a link, so the part that can break quietly
is the part under test.
