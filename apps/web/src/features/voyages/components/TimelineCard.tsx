import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import type { TimelineEvent, VoyageTimelinePage } from '@tradeflow/contracts';
import type { ReactNode } from 'react';
import { ApiError } from '../../../shared/api/http-client';
import { formatInstant } from '../../../shared/lib/format';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import { describeTimelineEvent, timelineContractLabel } from '../domain/timeline';

function describeLoadMoreFailure(error: Error): string {
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'Older events could not be loaded. Please try again.';
}

function TimelineItem({ event }: { event: TimelineEvent }) {
  const contract = timelineContractLabel(event);
  return (
    <Box component="li" sx={{ py: 1.5, borderTop: 1, borderColor: 'divider' }}>
      <Typography variant="body1" sx={{ fontWeight: 600 }}>
        {describeTimelineEvent(event)}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {[
          formatInstant(event.occurredAt),
          `${event.actor.name} (${event.actor.organization.name})`,
          contract,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Typography>
    </Box>
  );
}

interface TimelineCardProps {
  timeline: UseInfiniteQueryResult<InfiniteData<VoyageTimelinePage>>;
}

/**
 * The voyage's audit trail as the organization may see it: the voyage's creation, and what
 * happened under its own contracts. Read-only, newest first, a page at a time. Degrades on its
 * own like the other cards: loading, an error with retry, or an empty state, while the page stays.
 */
export function TimelineCard({ timeline }: TimelineCardProps) {
  const { data, error, isFetchNextPageError, isFetchingNextPage, hasNextPage } = timeline;
  const events = data?.pages.flatMap((page) => page.items);

  let body: ReactNode;
  if (!events) {
    body = error ? (
      <QueryErrorAlert
        title="Timeline could not be loaded"
        error={error}
        onRetry={() => void timeline.refetch()}
      />
    ) : (
      <Stack spacing={1} aria-busy aria-label="Loading timeline">
        <Skeleton variant="rounded" height={48} />
        <Skeleton variant="rounded" height={48} />
      </Stack>
    );
  } else if (events.length === 0) {
    body = (
      <Typography color="text.secondary">
        Nothing your organization can see has been recorded on this voyage yet.
      </Typography>
    );
  } else {
    body = (
      <Stack spacing={1.5}>
        <Stack
          component="ol"
          // Explicit role: Safari drops list semantics from lists styled without markers.
          role="list"
          aria-label="Timeline"
          aria-busy={isFetchingNextPage}
          sx={{ listStyle: 'none', m: 0, p: 0 }}
        >
          {events.map((event) => (
            <TimelineItem key={event.id} event={event} />
          ))}
        </Stack>
        {error && isFetchNextPageError && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void timeline.fetchNextPage()}>
                Retry
              </Button>
            }
          >
            {describeLoadMoreFailure(error)}
          </Alert>
        )}
        {hasNextPage && !isFetchNextPageError && (
          <Box>
            <Button
              variant="outlined"
              disabled={isFetchingNextPage}
              startIcon={isFetchingNextPage ? <CircularProgress size={18} color="inherit" /> : null}
              onClick={() => void timeline.fetchNextPage()}
            >
              Load more
            </Button>
          </Box>
        )}
      </Stack>
    );
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h2" sx={{ mb: 0.5 }}>
          Timeline
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Who did what on this voyage, newest first. You see when it was created, and what happened
          under your organization’s own sale contracts.
        </Typography>
        {body}
      </CardContent>
    </Card>
  );
}
