import { Alert, Box, Button, CircularProgress, Skeleton, Stack, Typography } from '@mui/material';
import { ApiError } from '../../../shared/api/http-client';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import type { ActionItemFilters } from '../api/action-items.api';
import { ACTION_TYPE_LABELS } from '../domain/action-items';
import type { ActionQueue as ActionQueueState } from '../hooks/use-action-queue';
import { ActionItemCard } from './ActionItemCard';

function describeLoadMoreFailure(error: Error): string {
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'More actions could not be loaded. Please try again.';
}

interface EmptyQueueProps {
  filters: ActionItemFilters;
  onClearFilters: () => void;
}

/** Nothing to show: said for what was asked, since a filter may be why. */
function EmptyQueue({ filters, onClearFilters }: EmptyQueueProps) {
  if (!filters.type && !filters.overdue) {
    return (
      <Stack spacing={0.5} sx={{ py: 4 }}>
        <Typography variant="subtitle1" component="p" sx={{ fontWeight: 600 }}>
          Nothing is waiting for your organization
        </Typography>
        <Typography color="text.secondary">
          No notice, instruction or document under your contracts needs your organization right now.
          This page checks again while it is open.
        </Typography>
      </Stack>
    );
  }
  // Only notices have deadlines (ADR 0017), so nothing else can ever be overdue.
  const neverOverdue =
    filters.overdue && filters.type !== 'ACKNOWLEDGE_NOTICE' ? filters.type : undefined;
  return (
    <Stack spacing={1.5} sx={{ py: 4, alignItems: 'flex-start' }}>
      <Stack spacing={0.5}>
        <Typography variant="subtitle1" component="p" sx={{ fontWeight: 600 }}>
          No actions match these filters
        </Typography>
        <Typography color="text.secondary">
          {neverOverdue
            ? `Only ETA notices have a deadline, so a “${ACTION_TYPE_LABELS[neverOverdue]}” action is never overdue.`
            : 'Other actions may be waiting for your organization.'}
        </Typography>
      </Stack>
      <Button variant="outlined" onClick={onClearFilters}>
        Show all actions
      </Button>
    </Stack>
  );
}

interface ActionQueueProps {
  queue: ActionQueueState;
  filters: ActionItemFilters;
  onClearFilters: () => void;
}

/**
 * The open actions loaded so far, in the API's order, a page per "Load more". A failed page
 * keeps what is shown and offers its own retry. No count is shown: the API serves none, and the
 * items loaded so far are not the whole queue.
 */
export function ActionQueue({ queue, filters, onClearFilters }: ActionQueueProps) {
  const { items, loadError, nextPageError, isFetchingNextPage, hasNextPage } = queue;

  if (!items) {
    return loadError ? (
      <QueryErrorAlert
        title="Actions could not be loaded"
        error={loadError}
        onRetry={queue.refresh}
      />
    ) : (
      <Stack spacing={2} aria-busy aria-label="Loading actions">
        <Skeleton variant="rounded" height={160} />
        <Skeleton variant="rounded" height={160} />
      </Stack>
    );
  }
  if (items.length === 0) {
    return <EmptyQueue filters={filters} onClearFilters={onClearFilters} />;
  }

  return (
    <Stack spacing={2}>
      <Stack
        component="ul"
        // Explicit role: Safari drops list semantics from lists styled without markers.
        role="list"
        aria-label="Actions"
        aria-busy={isFetchingNextPage}
        spacing={2}
        sx={{ listStyle: 'none', m: 0, p: 0 }}
      >
        {items.map((item) => (
          <ActionItemCard key={item.key} item={item} />
        ))}
      </Stack>
      {nextPageError && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={queue.retryNextPage}>
              Retry
            </Button>
          }
        >
          {describeLoadMoreFailure(nextPageError)}
        </Alert>
      )}
      {hasNextPage && !nextPageError && (
        <Box>
          <Button
            variant="outlined"
            disabled={isFetchingNextPage}
            startIcon={isFetchingNextPage ? <CircularProgress size={18} color="inherit" /> : null}
            onClick={queue.fetchNextPage}
          >
            Load more
          </Button>
        </Box>
      )}
      {!hasNextPage && (
        <Typography variant="body2" color="text.secondary">
          End of the list.
        </Typography>
      )}
    </Stack>
  );
}
