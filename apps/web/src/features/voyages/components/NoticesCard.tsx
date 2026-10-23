import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  CounterpartyContractListResponse,
  Notice,
  NoticeActor,
  NoticeListResponse,
} from '@tradeflow/contracts';
import { type ReactNode, useState } from 'react';
import { ApiError } from '../../../shared/api/http-client';
import { useIdentity } from '../../../shared/auth/identity';
import { formatInstant } from '../../../shared/lib/format';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import {
  canAcknowledge,
  describeContract,
  issuableContracts,
  type NoticeState,
  noticeState,
} from '../domain/notices';
import { useAcknowledgeNotice } from '../hooks/use-notice-commands';
import { linkedRecordProps, linkedRecordSx, useLinkedRecord } from '../navigation/linked-record';
import { IssueNoticeForm } from './IssueNoticeForm';

const STATES: Record<
  NoticeState,
  { label: string; color: 'default' | 'error' | 'success' | 'warning' }
> = {
  AWAITING: { label: 'Awaiting acknowledgement', color: 'default' },
  OVERDUE: { label: 'Overdue', color: 'error' },
  ACKNOWLEDGED: { label: 'Acknowledged', color: 'success' },
  ACKNOWLEDGED_LATE: { label: 'Acknowledged late', color: 'warning' },
};

const actor = ({ name, organization }: NoticeActor) => `${name} (${organization.name})`;

function describeAcknowledgeFailure(error: Error): string {
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'Receipt could not be acknowledged. Please try again.';
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Typography component="dt" variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0 }}>
        {children}
      </Typography>
    </div>
  );
}

function NoticeItem({ voyageId, notice }: { voyageId: string; notice: Notice }) {
  const identity = useIdentity();
  const { acknowledge, error, isPending } = useAcknowledgeNotice(voyageId);
  const state = STATES[noticeState(notice)];
  const waitingForUs = notice.status === 'ISSUED' && notice.contract.side === 'BUYER';
  const heading = `ETA notice, contract ${notice.contract.position}`;
  const linked = useLinkedRecord();
  const isLinked = linked?.kind === 'NOTICE' && linked.notice.id === notice.id;

  return (
    <Box
      component="li"
      aria-label={heading}
      {...(isLinked && linkedRecordProps)}
      sx={[
        { p: 2, border: 1, borderColor: 'divider', borderRadius: 1 },
        isLinked && linkedRecordSx,
      ]}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, mb: 0.5 }}
      >
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
          ETA notice
        </Typography>
        <Chip size="small" label={state.label} color={state.color} />
        <Chip
          size="small"
          variant="outlined"
          label={notice.contract.side === 'SELLER' ? 'Sent by you' : 'Sent to you'}
        />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {describeContract(notice.contract)}
      </Typography>

      <Box
        component="dl"
        sx={{
          m: 0,
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
        }}
      >
        <Fact label="Estimated arrival">{formatInstant(notice.estimatedArrivalAt)}</Fact>
        <Fact label="Acknowledge by">{formatInstant(notice.acknowledgementDueAt)}</Fact>
        <Fact label="Issued">
          {formatInstant(notice.issuedAt)} by {actor(notice.issuedBy)}
        </Fact>
        <Fact label="Acknowledged">
          {notice.acknowledgedAt && notice.acknowledgedBy
            ? `${formatInstant(notice.acknowledgedAt)} by ${actor(notice.acknowledgedBy)}`
            : 'Not yet'}
        </Fact>
      </Box>

      {notice.message && (
        <Typography
          variant="body2"
          sx={{
            mt: 1.5,
            pl: 1.5,
            borderLeft: 3,
            borderColor: 'divider',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {notice.message}
        </Typography>
      )}

      {error && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {describeAcknowledgeFailure(error)}
        </Alert>
      )}

      {canAcknowledge(identity, notice) ? (
        <Button
          variant="outlined"
          sx={{ mt: 1.5 }}
          disabled={isPending}
          startIcon={isPending ? <CircularProgress size={18} color="inherit" /> : null}
          onClick={() => {
            acknowledge(notice.id);
          }}
        >
          Acknowledge receipt
        </Button>
      ) : (
        waitingForUs && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            An operator in your organization can acknowledge receipt.
          </Typography>
        )
      )}
    </Box>
  );
}

interface NoticesCardProps {
  voyageId: string;
  contracts: UseQueryResult<CounterpartyContractListResponse>;
  notices: UseQueryResult<NoticeListResponse>;
}

/**
 * ETA notices under the organization's own contracts on this voyage: the list, issuing (for
 * operators of a seller) and acknowledging (for operators of a buyer). Degrades on its own, like
 * the trade string: loading, an error with retry, or an explanation, while the page stays.
 */
export function NoticesCard({ voyageId, contracts, notices }: NoticesCardProps) {
  const identity = useIdentity();
  const [issuing, setIssuing] = useState(false);
  const [lastIssued, setLastIssued] = useState<Notice | null>(null);

  const error = contracts.error ?? notices.error;
  const ownContracts = contracts.data?.items;
  const issuable = ownContracts ? issuableContracts(identity, ownContracts) : [];

  let body: ReactNode;
  if (error) {
    body = (
      <QueryErrorAlert
        title="Notices could not be loaded"
        error={error}
        onRetry={() => {
          void contracts.refetch();
          void notices.refetch();
        }}
      />
    );
  } else if (!ownContracts || !notices.data) {
    body = (
      <Stack spacing={1} aria-busy aria-label="Loading notices">
        <Skeleton variant="rounded" height={96} />
      </Stack>
    );
  } else if (ownContracts.length === 0) {
    body = (
      <Typography color="text.secondary">
        Your organization is not a party to a sale contract on this voyage, so it neither sends nor
        receives notices here.
      </Typography>
    );
  } else {
    body = (
      <Stack spacing={2}>
        {lastIssued && (
          <Alert
            severity="success"
            onClose={() => {
              setLastIssued(null);
            }}
          >
            Your ETA notice to {lastIssued.contract.buyer.name} has been issued.
          </Alert>
        )}
        {issuing ? (
          <IssueNoticeForm
            voyageId={voyageId}
            contracts={issuable}
            onIssued={(notice) => {
              setIssuing(false);
              setLastIssued(notice);
            }}
            onCancel={() => {
              setIssuing(false);
            }}
          />
        ) : (
          issuable.length > 0 && (
            <Box>
              <Button
                variant="contained"
                onClick={() => {
                  setLastIssued(null);
                  setIssuing(true);
                }}
              >
                Issue ETA notice
              </Button>
            </Box>
          )
        )}
        {notices.data.items.length === 0 ? (
          <Typography color="text.secondary">No notices under your contracts yet.</Typography>
        ) : (
          <Stack
            component="ul"
            // Explicit role: Safari drops list semantics from lists styled without markers.
            role="list"
            aria-label="Notices"
            spacing={2}
            sx={{ listStyle: 'none', m: 0, p: 0 }}
          >
            {notices.data.items.map((notice) => (
              <NoticeItem key={notice.id} voyageId={voyageId} notice={notice} />
            ))}
          </Stack>
        )}
      </Stack>
    );
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h2" sx={{ mb: 0.5 }}>
          ETA notices
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Sent by the seller to the buyer under each sale contract, and seen only by those two.
          Acknowledging records receipt; it does not accept any commercial terms.
        </Typography>
        {body}
      </CardContent>
    </Card>
  );
}
