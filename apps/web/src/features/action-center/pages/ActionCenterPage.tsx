import RefreshIcon from '@mui/icons-material/Refresh';
import { Alert, Button, Stack } from '@mui/material';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import { formatInstant } from '../../../shared/lib/format';
import { PageHeader } from '../../../shared/ui/PageHeader';
import type { ActionItemFilters } from '../api/action-items.api';
import { actionItemQueries } from '../api/action-items.queries';
import { ActionQueue } from '../components/ActionQueue';
import { ActionQueueFilters } from '../components/ActionQueueFilters';
import { parseQueueFilters, queueSearch } from '../domain/action-items';

/**
 * Filters live in the URL (reload, back and forward, links), validated as they are read; the
 * queue itself lives in the query cache, one entry per set of filters.
 */
function useQueueFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { filters, ignored } = parseQueueFilters(searchParams);
  return {
    filters,
    ignored,
    /** A new entry in the history, so Back returns to the previous filters. */
    setFilters: (next: ActionItemFilters) => {
      setSearchParams(queueSearch(next));
    },
    /** Rewrites the address without what was ignored; the queue shown stays the same. */
    dropIgnored: () => {
      setSearchParams(queueSearch(filters), { replace: true });
    },
  };
}

/**
 * The Action Center (ADR 0017): what the signed-in organization has to do next, across every
 * voyage, as the API derives it from the records. Read-only: each item links to its exact record
 * on the voyage's page, where the usual commands and permissions apply. Viewers read the same
 * queue.
 */
export function ActionCenterPage() {
  const scope = useProtectedScope();
  const identity = useIdentity();
  const queryClient = useQueryClient();
  const { filters, ignored, setFilters, dropIgnored } = useQueueFilters();
  const options = actionItemQueries.list(scope, filters);
  const queue = useInfiniteQuery(options);
  const loadedAt = queue.data?.pages[0]?.generatedAt;

  const refresh = () => {
    // Drops every page loaded so far and reads the first one again.
    void queryClient.resetQueries({ queryKey: options.queryKey, exact: true });
  };

  return (
    <>
      <PageHeader
        title="Action Center"
        subtitle={
          loadedAt
            ? `What your organization has to do next, across voyages. Loaded ${formatInstant(loadedAt)}; it does not update on its own.`
            : 'What your organization has to do next, across voyages.'
        }
        actions={
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ alignItems: { xs: 'stretch', sm: 'center' }, width: { xs: '100%', sm: 'auto' } }}
          >
            <ActionQueueFilters value={filters} onChange={setFilters} />
            <Button
              variant="outlined"
              startIcon={<RefreshIcon aria-hidden />}
              disabled={queue.isFetching && !queue.isFetchingNextPage}
              onClick={refresh}
            >
              Refresh
            </Button>
          </Stack>
        }
      />
      <Stack spacing={2}>
        {ignored.length > 0 && (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" onClick={dropIgnored}>
                Remove from address
              </Button>
            }
          >
            {`The address has ${ignored.length === 1 ? 'a filter' : 'filters'} the Action Center does not recognise (${ignored.join(', ')}), so ${ignored.length === 1 ? 'it is' : 'they are'} ignored.`}
          </Alert>
        )}
        {identity.user.role === 'VIEWER' && (
          <Alert severity="info">
            You can open every record listed here. Acting on them is for an operator in your
            organization.
          </Alert>
        )}
        <ActionQueue
          queue={queue}
          filters={filters}
          onClearFilters={() => {
            setFilters({});
          }}
        />
      </Stack>
    </>
  );
}
