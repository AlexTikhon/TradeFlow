import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HistoryIcon from '@mui/icons-material/History';
import { Box, Stack, Typography } from '@mui/material';
import type { DocumentSetSummary } from '../domain/documents';

interface DocumentSetStatusProps {
  /** Where the counts come from: one contract's revision, so ids stay unique on the page. */
  idPrefix: string;
  revisionNumber: number;
  summary: DocumentSetSummary;
  /**
   * The last read of the documents or the instructions failed: the counts are what was last
   * read, and completion is not claimed until a read succeeds.
   */
  lastKnown: boolean;
}

/**
 * How far the document set of the current revision has come: how many required documents are
 * approved, and how many are missing, pending review or rejected. Read-only and recomputed from
 * the page's query data on every render; it sends nothing. Every state is written out in words,
 * so nothing depends on color.
 */
export function DocumentSetStatus({
  idPrefix,
  revisionNumber,
  summary,
  lastKnown,
}: DocumentSetStatusProps) {
  const headingId = `${idPrefix}-document-set`;
  const { required, missing, pending, rejected, approved } = summary;
  const complete = summary.allApproved && !lastKnown;
  const counts = [
    ['Missing', missing],
    ['Pending review', pending],
    ['Rejected', rejected],
    ['Approved', approved],
  ] as const;

  return (
    <Box
      role="group"
      aria-labelledby={headingId}
      sx={{
        p: 1.5,
        mb: 1.5,
        border: 1,
        borderColor: complete ? 'success.main' : 'divider',
        borderRadius: 1,
      }}
    >
      <Typography id={headingId} variant="body2" component="p" sx={{ fontWeight: 600 }}>
        Documents approved: {approved} of {required}
        {lastKnown && ' (last known)'}
      </Typography>
      <Stack
        component="ul"
        role="list"
        aria-label={`Required documents of revision ${revisionNumber} by status`}
        direction="row"
        sx={{ listStyle: 'none', m: 0, mt: 0.5, p: 0, flexWrap: 'wrap', columnGap: 2, rowGap: 0.5 }}
      >
        {counts.map(([label, count]) => (
          <Typography
            key={label}
            component="li"
            variant="body2"
            color={count > 0 ? 'text.primary' : 'text.secondary'}
          >
            {label}: {count}
          </Typography>
        ))}
      </Stack>
      {lastKnown ? (
        <Stack direction="row" spacing={0.75} sx={{ mt: 1, alignItems: 'flex-start' }}>
          <HistoryIcon fontSize="small" color="action" aria-hidden />
          <Typography variant="body2" color="text.secondary">
            Last known counts: the latest documents or instructions could not be read. They are
            confirmed again after a successful refresh.
          </Typography>
        </Stack>
      ) : (
        complete && (
          <Stack direction="row" spacing={0.75} sx={{ mt: 1, alignItems: 'flex-start' }}>
            <CheckCircleIcon fontSize="small" sx={{ color: 'success.dark' }} aria-hidden />
            <Box>
              <Typography variant="body2" sx={{ color: 'success.dark', fontWeight: 600 }}>
                All required documents approved.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                The latest version of each document revision {revisionNumber} requires is approved.
                This does not mean the voyage is completed, payment is settled or any other
                obligation is met.
              </Typography>
            </Box>
          </Stack>
        )
      )}
    </Box>
  );
}
