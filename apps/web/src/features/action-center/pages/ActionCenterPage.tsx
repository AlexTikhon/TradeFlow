import RefreshIcon from '@mui/icons-material/Refresh';
import { Alert, Button, Stack } from '@mui/material';
import { useSearchParams } from 'react-router';
import { useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import { formatInstant } from '../../../shared/lib/format';
import { PageHeader } from '../../../shared/ui/PageHeader';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import type { ActionItemFilters } from '../api/action-items.api';
import { ActionQueue } from '../components/ActionQueue';
import { ActionQueueFilters } from '../components/ActionQueueFilters';
import { parseQueueFilters, queueSearch } from '../domain/action-items';
import { type ActionQueue as ActionQueueState, useActionQueue } from '../hooks/use-action-queue';

const PURPOSE = 'What your organization has to do next, across voyages.';

/**
 * How current the queue shown is: the API's time for the last first page read successfully, and
 * why nothing newer is shown when a refresh failed or cannot be sent. A failure never moves that
 * time, so older items are never presented as just checked.
 */
function describeFreshness({ generatedAt, refreshError, online }: ActionQueueState): string {
  if (!generatedAt) return PURPOSE;
  const at = formatInstant(generatedAt);
  if (!online) {
    return `${PURPOSE} Last updated ${at}. You are offline, so it may be out of date; it is checked again when the connection returns.`;
  }
  if (refreshError) {
    return `${PURPOSE} Last updated ${at}. It could not be checked since, so it may be out of date.`;
  }
  return `${PURPOSE} Updated ${at}, and checked again every 30 seconds while this page is open.`;
}

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
 * queue. It keeps itself current while open (`useActionQueue`); Refresh reads it at once.
 */
export function ActionCenterPage() {
  const scope = useProtectedScope();
  const identity = useIdentity();
  const { filters, ignored, setFilters, dropIgnored } = useQueueFilters();
  const queue = useActionQueue(scope, filters);

  return (
    <>
      <PageHeader
        title="Action Center"
        subtitle={describeFreshness(queue)}
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
              disabled={queue.refreshing}
              onClick={queue.refresh}
            >
              Refresh
            </Button>
          </Stack>
        }
      />
      <Stack spacing={2}>
        {queue.refreshError && (
          <QueryErrorAlert
            title="Actions could not be refreshed"
            error={queue.refreshError}
            onRetry={queue.refresh}
          />
        )}
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
