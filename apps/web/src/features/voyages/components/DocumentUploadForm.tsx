import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Stack,
  styled,
  Typography,
} from '@mui/material';
import {
  type ContractDocument,
  DOCUMENT_MEDIA_TYPE,
  DocumentFileSchema,
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
  formatFileSize,
} from '../domain/documents';
import {
  isPreconditionFailure,
  isSuperseded,
  useUploadDocument,
} from '../hooks/use-document-commands';

/** Present for assistive technology and the label that opens it; invisible otherwise. */
const VisuallyHiddenInput = styled('input')({
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  height: 1,
  overflow: 'hidden',
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: 1,
});

function describeFailure(error: Error): string {
  if (isSuperseded(error)) {
    return `Not uploaded: ${error.message}`;
  }
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'The file could not be uploaded. Please try again.';
}

/** What happened since the user chose their file, as the warning above the form says it. */
function ChangeNotice({ change, label }: { change: DocumentChange; label: string }) {
  if (change.kind === 'none') return null;
  const { latest } = change;
  if (change.kind === 'decided') {
    const { review } = change;
    return (
      <>
        <AlertTitle>
          Version {latest.number} was {decisionVerb(review)}
        </AlertTitle>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
          {review.reviewedBy.name} ({review.reviewedBy.organization.name}) {decisionVerb(review)}{' '}
          version {latest.number} of the {label.toLowerCase()} on {formatInstant(review.reviewedAt)}
          , after you chose your file{review.reason ? `: “${review.reason}”.` : '.'} Your file is
          kept; choose whether it replaces version {latest.number}.
        </Typography>
      </>
    );
  }
  return (
    <>
      <AlertTitle>A new version was uploaded</AlertTitle>
      <Typography variant="body2">
        Version {latest.number} ({latest.fileName}) was uploaded by {latest.uploadedBy.name} on{' '}
        {formatInstant(latest.uploadedAt)}, after you chose your file. Your file is kept; review
        that version, then choose whether yours replaces it.
      </Typography>
    </>
  );
}

interface DocumentUploadFormProps {
  target: DocumentTarget;
  /** The document type as people read it, e.g. "Bill of lading". */
  label: string;
  /**
   * The document as the page has it now (null while it has no version). This follows the cache,
   * so it moves on when the list is refreshed; what the user chose to replace does not.
   */
  latest: ContractDocument | null;
  /** Fetches the latest documents, for the user to review after a conflict. */
  onReviewLatest: () => Promise<unknown>;
}

/**
 * The seller's upload of one document. Choosing a file remembers the document as it was then (its
 * basis): its version, sent in If-Match, and its latest file. If the document moves on meanwhile
 * (a 412, or a refresh that shows it) the chosen file is kept and the change is shown, told apart:
 * a new file someone uploaded, or the buyer's decision on the latest one. The user must explicitly
 * choose to replace what is there now. On any failure the file stays chosen, and nothing is sent
 * again on its own.
 */
export function DocumentUploadForm({
  target,
  label,
  latest,
  onReviewLatest,
}: DocumentUploadFormProps) {
  const { upload, error, isPending, reset } = useUploadDocument(target.voyageId);
  const [file, setFile] = useState<File | null>(null);
  const [basis, setBasis] = useState<DocumentBasis | null>(null);
  const [fileError, setFileError] = useState<string>();
  const [uploaded, setUploaded] = useState<number | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [reviewing, setReviewing] = useState(false);

  // While a chosen file waits, a file or a decision that appears meanwhile must be seen before the
  // chosen file replaces it.
  const change = changeSince(basis, latest);
  const stale = file !== null && !isPending && change.kind !== 'none';
  const conflict = isPreconditionFailure(error);
  const formError = error && !conflict ? describeFailure(error) : undefined;
  const inputId = `${target.contractId}-${target.revisionNumber}-${target.documentType}-file`;

  const choose = (chosen: File | undefined) => {
    reset();
    setUploaded(null);
    if (!chosen) return;
    const checked = DocumentFileSchema.safeParse(chosen);
    if (!checked.success) {
      setFile(null);
      setFileError(checked.error.issues[0]?.message);
      return;
    }
    setFileError(undefined);
    setFile(chosen);
    setBasis(basisOf(latest));
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
    if (!file || stale) return;
    upload({ target, file, basedOnVersion: basis?.version ?? null }, (document) => {
      setFile(null);
      setInputKey((key) => key + 1);
      setUploaded(document.currentVersion.number);
    });
  };

  return (
    <Stack
      component="form"
      noValidate
      aria-label={`Upload ${label}`}
      onSubmit={onSubmit}
      spacing={1.5}
    >
      {stale && latest && (
        <Alert severity="warning" role="region" aria-label={`Latest version of ${label}`}>
          <Stack spacing={1.5}>
            <Box>
              <ChangeNotice change={change} label={label} />
            </Box>
            <Box>
              <Button
                variant="outlined"
                color="inherit"
                onClick={() => {
                  setBasis(basisOf(latest));
                  reset();
                }}
              >
                Replace version {latest.currentVersion.number} with my file
              </Button>
            </Box>
          </Stack>
        </Alert>
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
          <AlertTitle>Not uploaded</AlertTitle>
          The document changed after you chose your file: a new version was uploaded, or the buyer
          decided on the latest one. Your file is kept.
        </Alert>
      )}

      {formError && <Alert severity="error">{formError}</Alert>}

      {uploaded !== null && (
        <Alert
          severity="success"
          onClose={() => {
            setUploaded(null);
          }}
        >
          Version {uploaded} of the {label.toLowerCase()} has been uploaded.
        </Alert>
      )}

      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
      >
        <Button
          component="label"
          htmlFor={inputId}
          variant="outlined"
          startIcon={<UploadFileIcon />}
          disabled={isPending}
        >
          {file ? 'Choose another PDF' : 'Choose a PDF'}
          <VisuallyHiddenInput
            key={inputKey}
            id={inputId}
            type="file"
            accept={`${DOCUMENT_MEDIA_TYPE},.pdf`}
            aria-label={`PDF file for the ${label.toLowerCase()}`}
            disabled={isPending}
            onChange={(event) => {
              choose(event.target.files?.[0]);
            }}
          />
        </Button>
        <Typography
          variant="body2"
          color={file ? 'text.primary' : 'text.secondary'}
          sx={{ overflowWrap: 'anywhere', minWidth: 0 }}
        >
          {file ? `${file.name} (${formatFileSize(file.size)})` : 'No file chosen'}
        </Typography>
        <Button
          type="submit"
          variant="contained"
          disabled={!file || isPending || stale}
          startIcon={isPending ? <CircularProgress size={18} color="inherit" /> : null}
        >
          {basis === null ? 'Upload' : `Upload as version ${basis.fileVersion + 1}`}
        </Button>
      </Stack>
      {fileError && (
        <Typography variant="body2" color="error" role="alert">
          {fileError}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        PDF only, at most 10 MiB.
        {latest
          ? ' A replacement becomes a new version for the buyer to review; every earlier version, and the decision on it, is kept.'
          : ''}
      </Typography>
    </Stack>
  );
}
