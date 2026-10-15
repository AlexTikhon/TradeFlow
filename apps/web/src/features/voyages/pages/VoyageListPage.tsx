import { useQuery } from '@tanstack/react-query';
import { VoyageStatusSchema, type VoyageStatus } from '@tradeflow/contracts';
import { useSearchParams } from 'react-router';
import { useProtectedScope } from '../../../shared/auth/identity';
import { PageHeader } from '../../../shared/ui/PageHeader';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import { voyageQueries } from '../api/voyage.queries';
import { VoyagesTable } from '../components/VoyagesTable';
import { VoyageStatusFilter } from '../components/VoyageStatusFilter';

/**
 * Filter state lives in the URL (shareable, survives reload, works with back/forward);
 * the data itself lives in the query cache. No component state duplicates either.
 */
function useStatusFilter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const parsed = VoyageStatusSchema.safeParse(searchParams.get('status'));
  const status = parsed.success ? parsed.data : undefined;

  const setStatus = (next: VoyageStatus | undefined) => {
    setSearchParams((params) => {
      if (next) params.set('status', next);
      else params.delete('status');
      return params;
    });
  };
  return [status, setStatus] as const;
}

export function VoyageListPage() {
  const [status, setStatus] = useStatusFilter();
  const scope = useProtectedScope();
  const { data, error, isPending, refetch } = useQuery(
    voyageQueries.list(scope, status ? { status } : {}),
  );

  const count = data?.items.length;
  return (
    <>
      <PageHeader
        title="Voyages"
        subtitle={
          count === undefined ? 'Loading voyages…' : `${count} voyage${count === 1 ? '' : 's'}`
        }
        actions={<VoyageStatusFilter value={status} onChange={setStatus} />}
      />
      {error ? (
        <QueryErrorAlert
          title="Voyages could not be loaded"
          error={error}
          onRetry={() => void refetch()}
        />
      ) : (
        <VoyagesTable voyages={data?.items} isLoading={isPending} />
      )}
    </>
  );
}
