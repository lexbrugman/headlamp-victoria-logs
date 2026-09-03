import type { DetailsViewSectionProps } from '@kinvolk/headlamp-plugin/lib';
import { K8s, registerDetailsViewSection } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import {
  DEFAULT_RANGE,
  jobFilter,
  nodeFilter,
  Range,
  RANGES,
  replicaSetFilter,
  vmuiUrl,
  workloadFilter,
} from './query';

/**
 * Kinds whose pods come and go while the thing itself persists. Headlamp's
 * own log view reads the kubelet, so it can only show pods that still exist;
 * these are the pages where that difference is felt.
 */
const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'];

/** The filter for a resource, or null where this plugin has nothing to add. */
function filterFor(resource: any): string | null {
  const kind: string | undefined = resource?.kind;
  const name: string | undefined = resource?.metadata?.name;
  if (!kind || !name) {
    return null;
  }
  if (kind === 'Node') {
    return nodeFilter(name);
  }
  const namespace: string | undefined = resource?.metadata?.namespace;
  if (!namespace) {
    return null;
  }
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

function PersistentLogs({ resource }: DetailsViewSectionProps) {
  const cluster = K8s.useCluster();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [search, setSearch] = useState('');

  const filter = filterFor(resource);
  if (!filter || !cluster) {
    return null;
  }

  const href = vmuiUrl({ cluster, filter, range, search: search.trim() || undefined });

  return (
    <SectionBox title="Persistent logs">
      <Typography variant="body2" sx={{ mb: 2 }}>
        Logs kept beyond the lifetime of the pods that wrote them, including
        incarnations Kubernetes has already removed.
      </Typography>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField
          select
          size="small"
          label="Range"
          value={range.relative}
          onChange={event =>
            setRange(RANGES.find(r => r.relative === event.target.value) ?? DEFAULT_RANGE)
          }
        >
          {RANGES.map(option => (
            <MenuItem key={option.relative} value={option.relative}>
              {option.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="Contains"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        {/* Opened rather than embedded: the log viewer on the other end is
            maintained upstream, and reaching it through the cluster proxy
            carries the session the viewer already has. */}
        <Button variant="contained" href={href} target="_blank" rel="noopener noreferrer">
          Open logs
        </Button>
      </Box>
    </SectionBox>
  );
}

registerDetailsViewSection(PersistentLogs);
