import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  type ContractDocument,
  type DocumentReviewDecision,
  REJECTION_REASON_MAX_LENGTH,
  ReviewDocumentVersionRequestSchema,
} from '@tradeflow/contracts';
import { type SubmitEvent, useState } from 'react';
import { ApiError } from '../../../shared/api/http-client';
import { formatInstant } from '../../../shared/lib/format';
import type { DocumentTarget } from '../api/documents.api';
import {
  basisOf,
  changeSince,
  decisionVerb,
  type DocumentBasis,
  type DocumentChange,
} from '../domain/documents';
import {
  isPreconditionFailure,
  isSuperseded,
  useReviewDocument,
} from '../hooks/use-document-commands';

function describeFailure(error: Error): string {
  if (isSuperseded(error)) {
    return `Not recorded: ${error.message}`;
  }
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'The decision could not be recorded. Please try again.';
}

interface ChangeNoticeProps {
  change: Exclude<DocumentChange, { kind: 'none' }>;
  basis: DocumentBasis;
  label: string;
  /** Moves the draft onto the latest file, keeping the decision and reason typed so far. */
  onReviewLatest: () => void;
  /** Drops the draft: there is nothing left to decide. */
  onDismiss: () => void;
}

/** What happened since the user started deciding, and what they can do about it. */
function ChangeNotice({ change, basis, label, onReviewLatest, onDismiss }: ChangeNoticeProps) {
  const { latest } = change;
  const document = label.toLowerCase();
  if (change.kind === 'new-file') {
    return (
      <Alert severity="warning" role="region" aria-label={`Changes to ${label}`}>
        <AlertTitle>A new version was uploaded</AlertTitle>
        <Stack spacing={1.5}>
          <Typography variant="body2">
            Version {latest.number} ({latest.fileName}) was uploaded by {latest.uploadedBy.name} on{' '}
            {formatInstant(latest.uploadedAt)}, after you started reviewing version{' '}
            {basis.fileVersion}. Your decision has not been sent.{' '}
            {latest.review
              ? `It has already been ${decisionVerb(latest.review)} by ${latest.review.reviewedBy.name}.`
              : 'Check the new version before you decide on it.'}
          </Typography>
          <Box>
            {latest.review ? (
              <Button variant="outlined" color="inherit" onClick={onDismiss}>
                Dismiss
              </Button>
            ) : (
              <Button variant="outlined" color="inherit" onClick={onReviewLatest}>
                Review version {latest.number} instead
              </Button>
            )}
          </Box>
        </Stack>
      </Alert>
    );
  }
  const { review } = change;
  return (
    <Alert severity="warning" role="region" aria-label={`Changes to ${label}`}>
      <AlertTitle>
        Version {latest.number} was already {decisionVerb(review)}
      </AlertTitle>
      <Stack spacing={1.5}>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
          {review.reviewedBy.name} ({review.reviewedBy.organization.name}) {decisionVerb(review)}{' '}
          version {latest.number} of the {document} on {formatInstant(review.reviewedAt)}
          {review.reason ? `: “${review.reason}”.` : '.'} A decision is final, so yours has not been
          recorded.
        </Typography>
        <Box>
          <Button variant="outlined" color="inherit" onClick={onDismiss}>
            Dismiss
          </Button>
        </Box>
      </Stack>
    </Alert>
  );
}

interface DocumentReviewFormProps {
  target: DocumentTarget;
  /** The document type as people read it, e.g. "Bill of lading". */
  label: string;
  /**
   * The document as the page has it now. This follows the cache, so it moves on when the list is
   * refreshed; the version the user started deciding on does not.
   */
  latest: ContractDocument;
  /** Fetches the latest documents, for the user to review after a conflict. */
  onReviewLatest: () => Promise<unknown>;
}

/**
 * The buyer's decision on the latest file of one document: approve it, or reject it with a
 * reason. Choosing a decision remembers the document as it was then (its basis): its version,
 * sent in If-Match, and the file being decided on. If the document moves on meanwhile (a 412, or
 * a refresh that shows it) nothing is sent, the draft is kept, and the change is shown, told
 * apart: a new file to check (the draft can move onto it), or someone else's decision on the same
 * file (final, so the draft can only be dismissed). Nothing is sent again on its own.
 */
export function DocumentReviewForm({
  target,
  label,
  latest,
  onReviewLatest,
}: DocumentReviewFormProps) {
  const { review, error, isPending, reset } = useReviewDocument(target.voyageId);
  const [basis, setBasis] = useState<DocumentBasis | null>(null);
  const [decision, setDecision] = useState<DocumentReviewDecision | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const [recorded, setRecorded] = useState<ContractDocument | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const change = basis ? changeSince(basis, latest) : ({ kind: 'none' } as const);
  const stale = !isPending && change.kind !== 'none';
  const conflict = isPreconditionFailure(error);
  const serverReasonError =
    error instanceof ApiError && error.status === 400
      ? error.problem?.errors?.find(({ path }) => path === 'body.reason')?.message
      : undefined;
  const formError = error && !conflict && !serverReasonError ? describeFailure(error) : undefined;
  const fileVersion = basis?.fileVersion ?? latest.currentVersion.number;
  const document = label.toLowerCase();

  const clear = () => {
    setBasis(null);
    setDecision(null);
    setReason('');
    setReasonError(undefined);
    reset();
  };

  const choose = (chosen: DocumentReviewDecision) => {
    setRecorded(null);
    reset();
    setDecision(chosen);
    // The draft is about the file on screen now; it stays about that file.
    setBasis((current) => current ?? basisOf(latest));
  };

  const reviewLatest = async () => {
    setReviewing(true);
    try {
      await onReviewLatest();
    } finally {
      setReviewing(false);
    }
  };

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!basis || !decision || stale || isPending) return;
    const request = ReviewDocumentVersionRequestSchema.safeParse(
      decision === 'APPROVED' ? { decision } : { decision, reason },
    );
    if (!request.success) {
      setReasonError(request.error.issues[0]?.message);
      return;
    }
    review(
      {
        target,
        versionNumber: basis.fileVersion,
        decision: request.data,
        basedOnVersion: basis.version,
      },
      (reviewed) => {
        setRecorded(reviewed);
        setBasis(null);
        setDecision(null);
        setReason('');
      },
    );
  };

  const success = recorded && (
    <Alert
      severity="success"
      onClose={() => {
        setRecorded(null);
      }}
    >
      Version {recorded.currentVersion.number} of the {document} has been{' '}
      {recorded.currentVersion.review ? decisionVerb(recorded.currentVersion.review) : 'reviewed'}.
    </Alert>
  );
  // Nothing to decide, and nothing of the user's to keep.
  if (!basis && latest.currentVersion.review) return success;
  const labelId = `${target.contractId}-${target.revisionNumber}-${target.documentType}-decision`;

  return (
    <>
      {success}
      <Stack
        component="form"
        noValidate
        aria-label={`Review version ${fileVersion} of the ${document}`}
        onSubmit={onSubmit}
        spacing={1.5}
        sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}
      >
        {stale && basis && (
          <ChangeNotice
            change={change}
            basis={basis}
            label={label}
            onReviewLatest={() => {
              setBasis(basisOf(latest));
              reset();
            }}
            onDismiss={clear}
          />
        )}

        {conflict && !stale && (
          <Alert
            severity="warning"
            action={
              <Button
                color="inherit"
                size="small"
                disabled={reviewing}
                onClick={() => void reviewLatest()}
              >
                Review the latest version
              </Button>
            }
          >
            <AlertTitle>Not recorded</AlertTitle>
            The document changed after you started your review: a new version was uploaded, or a
            decision was made. Your draft is kept.
          </Alert>
        )}

        {formError && !stale && <Alert severity="error">{formError}</Alert>}

        <FormControl disabled={isPending || stale}>
          <FormLabel id={labelId}>Your decision on version {fileVersion}</FormLabel>
          <RadioGroup
            row
            aria-labelledby={labelId}
            value={decision ?? ''}
            onChange={(event) => {
              choose(event.target.value as DocumentReviewDecision);
            }}
          >
            <FormControlLabel value="APPROVED" control={<Radio />} label="Approve" />
            <FormControlLabel value="REJECTED" control={<Radio />} label="Reject" />
          </RadioGroup>
        </FormControl>

        {decision === 'REJECTED' && (
          <TextField
            label="Reason for rejecting"
            required
            multiline
            minRows={2}
            value={reason}
            disabled={isPending || stale}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(undefined);
              if (serverReasonError) reset();
            }}
            error={Boolean(reasonError ?? serverReasonError)}
            helperText={
              reasonError ??
              serverReasonError ??
              `${reason.length}/${REJECTION_REASON_MAX_LENGTH} characters. The seller sees it.`
            }
            slotProps={{ htmlInput: { maxLength: REJECTION_REASON_MAX_LENGTH } }}
          />
        )}

        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
        >
          <Button
            type="submit"
            variant="contained"
            color={decision === 'REJECTED' ? 'error' : 'primary'}
            disabled={!decision || isPending || stale}
            startIcon={isPending ? <CircularProgress size={18} color="inherit" /> : null}
          >
            {decision === 'REJECTED'
              ? `Reject version ${fileVersion}`
              : decision === 'APPROVED'
                ? `Approve version ${fileVersion}`
                : 'Record decision'}
          </Button>
          {decision && !isPending && (
            <Button variant="text" onClick={clear}>
              Cancel
            </Button>
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          A decision is final and applies to this exact file. If you reject it, the seller can
          upload a replacement for you to review.
        </Typography>
      </Stack>
    </>
  );
}
