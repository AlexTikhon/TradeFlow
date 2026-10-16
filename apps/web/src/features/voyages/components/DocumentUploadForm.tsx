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
import { formatFileSize } from '../domain/documents';
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

interface DocumentUploadFormProps {
  target: DocumentTarget;
  /** The document type as people read it, e.g. "Bill of lading". */
  label: string;
  /**
   * The document as the page has it now (null while it has no version). This follows the cache,
   * so it moves on when the list is refreshed; the version the user chose to replace does not.
   */
  latest: ContractDocument | null;
  /** Fetches the latest documents, for the user to review after a conflict. */
  onReviewLatest: () => Promise<unknown>;
}

/**
 * The seller's upload of one document. Choosing a file remembers which version it would replace
 * (its basis), which is what the upload sends in If-Match. If someone uploads a version meanwhile
 * (a 412, or a refresh that shows it) the chosen file is kept and the newer version is shown; the
 * user must explicitly choose to replace it. On any failure the file stays chosen, and nothing
 * is sent again on its own.
 */
export function DocumentUploadForm({
  target,
  label,
  latest,
  onReviewLatest,
}: DocumentUploadFormProps) {
  const { upload, error, isPending, reset } = useUploadDocument(target.voyageId);
  const [file, setFile] = useState<File | null>(null);
  const [basis, setBasis] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string>();
  const [uploaded, setUploaded] = useState<number | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [reviewing, setReviewing] = useState(false);

  const latestVersion = latest?.currentVersion.number ?? null;
  // While a chosen file waits, a version that appears meanwhile must be seen before it is replaced.
  const stale = file !== null && !isPending && latestVersion !== basis;
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
    setBasis(latestVersion);
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
    upload({ target, file, basedOnVersion: basis }, (document) => {
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
          <AlertTitle>A new version was uploaded</AlertTitle>
          <Stack spacing={1.5}>
            <Typography variant="body2">
              Version {latest.currentVersion.number} ({latest.currentVersion.fileName}) was uploaded
              by {latest.currentVersion.uploadedBy.name} on{' '}
              {formatInstant(latest.currentVersion.uploadedAt)}, after you chose your file. Your
              file is kept; review that version, then choose whether yours replaces it.
            </Typography>
            <Box>
              <Button
                variant="outlined"
                color="inherit"
                onClick={() => {
                  setBasis(latestVersion);
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
          Someone uploaded a version of this document after you chose your file. Your file is kept.
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
          {basis === null ? 'Upload' : `Upload as version ${basis + 1}`}
        </Button>
      </Stack>
      {fileError && (
        <Typography variant="body2" color="error" role="alert">
          {fileError}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        PDF only, at most 10 MiB.
        {latest ? ' A replacement becomes a new version; every earlier version is kept.' : ''}
      </Typography>
    </Stack>
  );
}
