import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import type { ActionItem } from '@tradeflow/contracts';
import { type ReactNode, useId } from 'react';
import { Link as RouterLink } from 'react-router';
import { formatInstant } from '../../../shared/lib/format';
import { recordLinkPath } from '../../voyages/navigation/record-link';
import {
  ACTION_TYPE_LABELS,
  describeRecord,
  describeRequiredAction,
  openLabel,
} from '../domain/action-items';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Typography component="dt" variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </div>
  );
}

/** When the action's record came about: what each kind of action is waiting since. */
function SourceFacts({ item }: { item: ActionItem }) {
  switch (item.type) {
    case 'ACKNOWLEDGE_NOTICE':
      return (
        <>
          <Fact label="Acknowledge by">
            {formatInstant(item.acknowledgementDueAt)}
            {item.overdue && ' (overdue)'}
          </Fact>
          <Fact label="Issued">{formatInstant(item.issuedAt)}</Fact>
        </>
      );
    case 'ACKNOWLEDGE_INSTRUCTIONS':
      return <Fact label="Given">{formatInstant(item.revisionCreatedAt)}</Fact>;
    case 'REVIEW_DOCUMENT':
      return <Fact label="Uploaded">{formatInstant(item.uploadedAt)}</Fact>;
    case 'REPLACE_REJECTED_DOCUMENT':
      return (
        <>
          <Fact label="Uploaded">{formatInstant(item.uploadedAt)}</Fact>
          <Fact label="Rejected">{formatInstant(item.rejectedAt)}</Fact>
        </>
      );
  }
}

/**
 * One open action: what is asked, on which voyage, from whom, about which exact record, and a
 * link that opens that record on the voyage's page. Nothing here sends a command: acting happens
 * on the record, under its own rules.
 */
export function ActionItemCard({ item }: { item: ActionItem }) {
  const headingId = useId();
  const record = describeRecord(item);
  const open = openLabel(item);

  return (
    <Box
      component="li"
      aria-labelledby={headingId}
      sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper' }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, mb: 0.5 }}
      >
        <Typography id={headingId} variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
          {ACTION_TYPE_LABELS[item.type]}
        </Typography>
        {item.type === 'ACKNOWLEDGE_NOTICE' && item.overdue && (
          <Chip size="small" color="error" label="Overdue" />
        )}
      </Stack>
      <Typography variant="body2" sx={{ mb: 1.5 }}>
        {describeRequiredAction(item)}
      </Typography>

      <Box
        component="dl"
        sx={{
          m: 0,
          mb: 1.5,
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: 'repeat(3, 1fr)' },
        }}
      >
        <Fact label="Voyage">{item.voyage.reference}</Fact>
        <Fact label="Counterparty">
          {item.counterparty.name} · Contract {item.contract.position}
        </Fact>
        {record && <Fact label="Record">{record}</Fact>}
        <SourceFacts item={item} />
      </Box>

      {item.type === 'REPLACE_REJECTED_DOCUMENT' && (
        <Box sx={{ mb: 1.5 }}>
          <Typography component="p" variant="caption" color="text.secondary">
            Reason for rejection
          </Typography>
          <Typography
            variant="body2"
            sx={{
              pl: 1,
              borderLeft: 2,
              borderColor: 'error.light',
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-line',
            }}
          >
            {item.rejectionReason}
          </Typography>
        </Box>
      )}

      <Button
        component={RouterLink}
        to={recordLinkPath(item.target)}
        variant="outlined"
        endIcon={<ArrowForwardIcon aria-hidden />}
        aria-label={`${open} on ${item.voyage.reference}, contract ${item.contract.position}`}
        sx={{ width: { xs: '100%', sm: 'auto' } }}
      >
        {open}
      </Button>
    </Box>
  );
}
