import type { DetailsViewSectionProps } from '@kinvolk/headlamp-plugin/lib';
import { K8s, registerDetailsViewSection } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { DEFAULT_RANGE, filterFor, Range, RANGES, vmuiUrl } from './query';
import { Detection, useSchema } from './schema';

/**
 * What each answer was matched on, and what that costs. An empty result is
 * otherwise unreadable: a quiet workload, a filter that matched nothing and a
 * store that was never reached all look identical.
 */
const BASIS: Record<Exclude<Detection, 'checking'>, string> = {
  workload:
    'Matched on the workload field this store records, so every pod that has ever served this resource is included.',
  pods: 'No workload field is recorded, so this is matched on the pod names Kubernetes generates. A pod named outside the usual pattern will not appear.',
  unrecognised:
    'This store records neither a pod nor a workload field, so there is nothing here to match a resource by. Its collector labels records differently from what this expects.',
  unavailable:
    'This store could not be reached to see what it records, so this is matched on the pod names Kubernetes generates.',
};

function PersistentLogs({ resource }: DetailsViewSectionProps) {
  const cluster = K8s.useCluster();
  const schema = useSchema(cluster);
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [search, setSearch] = useState('');

  const filter = filterFor(
    resource?.kind,
    resource?.metadata?.name,
    resource?.metadata?.namespace,
    schema
  );
  // Nothing is shown until the schema is known: which resources this can speak
  // for is one of the things the answer decides.
  if (!filter || !cluster || schema.detection === 'checking') {
    return null;
  }

  // A store whose records cannot be matched gets the explanation and nothing
  // else — a button here would open a view that is empty by construction.
  const usable = schema.detection !== 'unrecognised';
  const href = usable
    ? vmuiUrl({
        cluster,
        endpoint: schema.endpoint,
        filter,
        range,
        search: search.trim() || undefined,
      })
    : undefined;

  return (
    <SectionBox title="Persistent logs">
      <Typography variant="body2" sx={{ mb: 1 }}>
        Logs kept beyond the lifetime of the pods that wrote them, including
        incarnations Kubernetes has already removed.
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        {BASIS[schema.detection]}
      </Typography>
      {usable && (
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
      )}
    </SectionBox>
  );
}

registerDetailsViewSection(PersistentLogs);
