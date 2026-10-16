import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  CounterpartyContract,
  CounterpartyContractListResponse,
  DocumentaryInstruction,
  DocumentaryInstructionListResponse,
} from '@tradeflow/contracts';
import { type ReactNode, useState } from 'react';
import { ApiError } from '../../../shared/api/http-client';
import { useIdentity } from '../../../shared/auth/identity';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import { canAcknowledgeRevision, canGiveInstructions } from '../domain/documentary-instructions';
import { describeContract } from '../domain/notices';
import {
  isPreconditionFailure,
  useAcknowledgeRevision,
} from '../hooks/use-documentary-instruction-commands';
import { InstructionForm } from './InstructionForm';
import { InstructionRevision } from './InstructionRevision';

function describeAcknowledgeFailure(error: Error): string {
  if (isPreconditionFailure(error)) {
    return 'Not recorded: the instructions changed before your acknowledgement arrived. The current version is shown above; acknowledge it if it is what you received.';
  }
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'Receipt could not be acknowledged. Please try again.';
}

interface ContractInstructionsProps {
  voyageId: string;
  contract: CounterpartyContract;
  instruction: DocumentaryInstruction | null;
  onReviewLatest: () => Promise<unknown>;
}

/** The instructions under one contract, from the reader's side, with what the user may do. */
function ContractInstructions({
  voyageId,
  contract,
  instruction,
  onReviewLatest,
}: ContractInstructionsProps) {
  const identity = useIdentity();
  const [editing, setEditing] = useState(false);
  const [sent, setSent] = useState<DocumentaryInstruction | null>(null);
  const { acknowledge, error, isPending } = useAcknowledgeRevision(voyageId);
  const buying = contract.side === 'BUYER';
  const heading = describeContract(contract);

  let content: ReactNode;
  if (editing) {
    content = (
      <InstructionForm
        voyageId={voyageId}
        contract={contract}
        latest={instruction}
        onReviewLatest={onReviewLatest}
        onSaved={(saved) => {
          setEditing(false);
          setSent(saved);
        }}
        onCancel={() => {
          setEditing(false);
        }}
      />
    );
  } else if (!instruction) {
    content = (
      <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <Typography color="text.secondary">
          {buying
            ? 'Your organization has not given documentary instructions under this contract yet.'
            : 'The buyer has not given documentary instructions under this contract yet.'}
        </Typography>
        {canGiveInstructions(identity, contract) ? (
          <Button
            variant="contained"
            onClick={() => {
              setSent(null);
              setEditing(true);
            }}
          >
            Give documentary instructions
          </Button>
        ) : (
          buying && (
            <Typography variant="body2" color="text.secondary">
              An operator in your organization can give them.
            </Typography>
          )
        )}
      </Stack>
    );
  } else {
    const { currentRevision, previousRevisions } = instruction;
    content = (
      <Stack spacing={2}>
        <InstructionRevision revision={currentRevision} current />

        {error && <Alert severity="error">{describeAcknowledgeFailure(error)}</Alert>}

        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          {canGiveInstructions(identity, contract) && (
            <Button
              variant="outlined"
              onClick={() => {
                setSent(null);
                setEditing(true);
              }}
            >
              Revise instructions
            </Button>
          )}
          {canAcknowledgeRevision(identity, instruction) && (
            <Button
              variant="contained"
              disabled={isPending}
              startIcon={isPending ? <CircularProgress size={18} color="inherit" /> : null}
              onClick={() => {
                acknowledge(instruction);
              }}
            >
              Acknowledge receipt of revision {currentRevision.number}
            </Button>
          )}
        </Stack>
        {!buying && !currentRevision.acknowledgement && identity.user.role !== 'OPERATOR' && (
          <Typography variant="body2" color="text.secondary">
            An operator in your organization can acknowledge receipt.
          </Typography>
        )}

        {previousRevisions.length > 0 && (
          <Accordion disableGutters variant="outlined">
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="body2">
                Earlier revisions ({previousRevisions.length})
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={2} divider={<Divider flexItem />}>
                {previousRevisions.map((revision) => (
                  <InstructionRevision key={revision.number} revision={revision} current={false} />
                ))}
              </Stack>
            </AccordionDetails>
          </Accordion>
        )}
      </Stack>
    );
  }

  return (
    <Box
      component="li"
      aria-label={heading}
      sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, mb: 1.5 }}
      >
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
          {heading}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          label={buying ? 'You buy: you give them' : 'You sell: you receive them'}
        />
      </Stack>
      {sent && !editing && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => {
            setSent(null);
          }}
        >
          Revision {sent.currentRevision.number} has been sent to {contract.seller.name} for
          acknowledgement.
        </Alert>
      )}
      {content}
    </Box>
  );
}

interface DocumentaryInstructionsCardProps {
  voyageId: string;
  contracts: UseQueryResult<CounterpartyContractListResponse>;
  instructions: UseQueryResult<DocumentaryInstructionListResponse>;
}

/**
 * Documentary instructions under the organization's own contracts on this voyage: the current
 * revision, earlier ones, acknowledgements, and the buyer's form. Degrades on its own, like the
 * other cards. Once loaded it stays on screen through a failed refresh, so an open draft is never
 * thrown away by a network error.
 */
export function DocumentaryInstructionsCard({
  voyageId,
  contracts,
  instructions,
}: DocumentaryInstructionsCardProps) {
  const error = contracts.error ?? instructions.error;
  const ownContracts = contracts.data?.items;
  const loaded = instructions.data?.items;
  const retry = () => {
    void contracts.refetch();
    void instructions.refetch();
  };

  let body: ReactNode;
  if (!ownContracts || !loaded) {
    body = error ? (
      <QueryErrorAlert
        title="Documentary instructions could not be loaded"
        error={error}
        onRetry={retry}
      />
    ) : (
      <Stack spacing={1} aria-busy aria-label="Loading documentary instructions">
        <Skeleton variant="rounded" height={96} />
      </Stack>
    );
  } else if (ownContracts.length === 0) {
    body = (
      <Typography color="text.secondary">
        Documentary instructions pass only between the buyer and the seller under a sale contract,
        and your organization is party to none on this voyage.
      </Typography>
    );
  } else {
    body = (
      <Stack spacing={2}>
        {error && (
          <QueryErrorAlert
            title="Documentary instructions could not be refreshed"
            error={error}
            onRetry={retry}
          />
        )}
        <Stack
          component="ul"
          // Explicit role: Safari drops list semantics from lists styled without markers.
          role="list"
          aria-label="Documentary instructions by contract"
          spacing={2}
          sx={{ listStyle: 'none', m: 0, p: 0 }}
        >
          {ownContracts.map((contract) => (
            <ContractInstructions
              key={contract.id}
              voyageId={voyageId}
              contract={contract}
              instruction={loaded.find((item) => item.contract.id === contract.id) ?? null}
              onReviewLatest={() => instructions.refetch()}
            />
          ))}
        </Stack>
      </Stack>
    );
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h2" sx={{ mb: 0.5 }}>
          Documentary instructions
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Given by the buyer to the seller under each sale contract, and seen only by those two: the
          consignee, the notify party and the documents to present. Every revision is kept.
          Acknowledging a revision records its receipt; it does not accept any commercial terms.
        </Typography>
        {body}
      </CardContent>
    </Card>
  );
}
