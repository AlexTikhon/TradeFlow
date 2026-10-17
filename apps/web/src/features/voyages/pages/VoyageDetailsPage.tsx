import { Breadcrumbs, Link, Skeleton, Stack, Typography } from '@mui/material';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { VoyageIdParamSchema } from '@tradeflow/contracts';
import { Link as RouterLink, useParams } from 'react-router';
import { ApiError } from '../../../shared/api/http-client';
import { useProtectedScope } from '../../../shared/auth/identity';
import { NotFoundState } from '../../../shared/ui/NotFoundState';
import { PageHeader } from '../../../shared/ui/PageHeader';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import { voyageQueries } from '../api/voyage.queries';
import { DocumentaryInstructionsCard } from '../components/DocumentaryInstructionsCard';
import { NoticesCard } from '../components/NoticesCard';
import { ParticipantsCard } from '../components/ParticipantsCard';
import { TimelineCard } from '../components/TimelineCard';
import { TradeStringCard } from '../components/TradeStringCard';
import { VoyageFacts } from '../components/VoyageFacts';
import { VoyageStatusChip } from '../components/VoyageStatusChip';

const VoyageNotFound = () => (
  <NotFoundState
    title="Voyage not found"
    message="This voyage does not exist, or you do not have access to it."
  />
);

export function VoyageDetailsPage() {
  const { voyageId = '' } = useParams<'voyageId'>();
  // A malformed id can never exist: answer locally instead of sending a doomed request.
  const isValidId = VoyageIdParamSchema.safeParse(voyageId).success;
  const scope = useProtectedScope();

  const {
    data: voyage,
    error,
    isPending,
    refetch,
  } = useQuery({
    ...voyageQueries.detail(scope, voyageId),
    enabled: isValidId,
  });
  // Fetched alongside the voyage, not after it.
  const tradeString = useQuery({
    ...voyageQueries.tradeString(scope, voyageId),
    enabled: isValidId,
  });
  const myContracts = useQuery({
    ...voyageQueries.myContracts(scope, voyageId),
    enabled: isValidId,
  });
  const notices = useQuery({ ...voyageQueries.notices(scope, voyageId), enabled: isValidId });
  const instructions = useQuery({
    ...voyageQueries.documentaryInstructions(scope, voyageId),
    enabled: isValidId,
  });
  const documents = useQuery({ ...voyageQueries.documents(scope, voyageId), enabled: isValidId });
  const timeline = useInfiniteQuery({
    ...voyageQueries.timeline(scope, voyageId),
    enabled: isValidId,
  });

  if (!isValidId || (error instanceof ApiError && error.status === 404)) {
    return <VoyageNotFound />;
  }

  return (
    <Stack spacing={3}>
      <Breadcrumbs aria-label="Breadcrumb">
        <Link component={RouterLink} to="/voyages" underline="hover" color="inherit">
          Voyages
        </Link>
        <Typography color="text.primary">{voyage?.reference ?? '…'}</Typography>
      </Breadcrumbs>

      {error && (
        <QueryErrorAlert
          title="Voyage could not be loaded"
          error={error}
          onRetry={() => void refetch()}
        />
      )}

      {isPending && (
        <Stack spacing={3} aria-busy aria-label="Loading voyage">
          <Skeleton variant="text" width={280} height={48} />
          <Skeleton variant="rounded" height={160} />
          <Skeleton variant="rounded" height={240} />
        </Stack>
      )}

      {voyage && (
        <div>
          <PageHeader
            title={voyage.reference}
            adornment={<VoyageStatusChip status={voyage.status} />}
            subtitle={`${voyage.vessel.name} · ${voyage.commodity.name} · ${voyage.loadPort.name} → ${voyage.dischargePort.name}`}
          />
          <Stack spacing={3}>
            <VoyageFacts voyage={voyage} />
            <TradeStringCard
              tradeString={tradeString.data}
              error={tradeString.error}
              onRetry={() => void tradeString.refetch()}
            />
            <NoticesCard voyageId={voyage.id} contracts={myContracts} notices={notices} />
            <DocumentaryInstructionsCard
              voyageId={voyage.id}
              contracts={myContracts}
              instructions={instructions}
              documents={documents}
            />
            <ParticipantsCard participants={voyage.participants} />
            <TimelineCard timeline={timeline} />
          </Stack>
        </div>
      )}
    </Stack>
  );
}
