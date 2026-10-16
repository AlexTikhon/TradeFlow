import DownloadIcon from '@mui/icons-material/Download';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  ContractDocument,
  CounterpartyContract,
  DocumentaryInstructionRevision,
  DocumentListResponse,
  DocumentVersion,
  RequiredDocumentType,
} from '@tradeflow/contracts';
import { ApiError } from '../../../shared/api/http-client';
import { useIdentity } from '../../../shared/auth/identity';
import { formatInstant } from '../../../shared/lib/format';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import type { DocumentTarget } from '../api/documents.api';
import { DOCUMENT_LABELS } from '../domain/documentary-instructions';
import {
  canUploadDocuments,
  findDocument,
  formatFileSize,
  shortChecksum,
} from '../domain/documents';
import { useDownloadDocument } from '../hooks/use-document-commands';
import { DocumentUploadForm } from './DocumentUploadForm';

function describeDownloadFailure(error: Error): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'The file could not be found. It may no longer be available to your organization.';
  }
  return 'The file could not be downloaded. Please try again.';
}

interface VersionLineProps {
  version: DocumentVersion;
  label: string;
  downloading: boolean;
  onDownload: () => void;
}

/** One version: what was uploaded, by whom and when, and a way to get it. */
function VersionLine({ version, label, downloading, onDownload }: VersionLineProps) {
  const { uploadedBy } = version;
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          Version {version.number}: {version.fileName} ({formatFileSize(version.sizeBytes)})
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          Uploaded {formatInstant(version.uploadedAt)} by {uploadedBy.name} (
          {uploadedBy.organization.name}) · SHA-256 {shortChecksum(version.sha256)}
        </Typography>
      </Box>
      <Button
        size="small"
        variant="text"
        startIcon={downloading ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
        disabled={downloading}
        aria-label={`Download version ${version.number} of the ${label.toLowerCase()}`}
        onClick={onDownload}
        sx={{ flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'center' } }}
      >
        Download
      </Button>
    </Stack>
  );
}

interface DocumentItemProps {
  target: DocumentTarget;
  document: ContractDocument | null;
  /** Whether the user may upload it: the current revision, the seller's operator. */
  uploads: boolean;
  /** Whether to say that an operator could upload it: the current revision, the seller. */
  explainUploads: boolean;
  onReviewLatest: () => Promise<unknown>;
}

/** One required document: its current version, earlier ones, and the upload form if allowed. */
function DocumentItem({
  target,
  document,
  uploads,
  explainUploads,
  onReviewLatest,
}: DocumentItemProps) {
  const label = DOCUMENT_LABELS[target.documentType];
  const { download, error, pending } = useDownloadDocument(target.voyageId);
  const downloadVersion = (version: DocumentVersion) => {
    download({ target, versionNumber: version.number, fileName: version.fileName });
  };
  const isDownloading = (version: DocumentVersion) => pending?.versionNumber === version.number;

  return (
    <Box
      component="li"
      aria-label={label}
      sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1 }}
    >
      <Stack spacing={1.5}>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
        >
          <Typography variant="body2" component="h5" sx={{ fontWeight: 600 }}>
            {label}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={document ? `Version ${document.currentVersion.number}` : 'Not uploaded yet'}
            color={document ? 'success' : 'default'}
          />
        </Stack>

        {document && (
          <VersionLine
            version={document.currentVersion}
            label={label}
            downloading={isDownloading(document.currentVersion)}
            onDownload={() => {
              downloadVersion(document.currentVersion);
            }}
          />
        )}
        {error && <Alert severity="error">{describeDownloadFailure(error)}</Alert>}

        {document && document.previousVersions.length > 0 && (
          <Accordion disableGutters variant="outlined">
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="body2">
                Earlier versions ({document.previousVersions.length})
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack
                component="ul"
                role="list"
                aria-label={`Earlier versions of the ${label.toLowerCase()}`}
                spacing={1.5}
                sx={{ listStyle: 'none', m: 0, p: 0 }}
              >
                {document.previousVersions.map((version) => (
                  <li key={version.number}>
                    <VersionLine
                      version={version}
                      label={label}
                      downloading={isDownloading(version)}
                      onDownload={() => {
                        downloadVersion(version);
                      }}
                    />
                  </li>
                ))}
              </Stack>
            </AccordionDetails>
          </Accordion>
        )}

        {uploads ? (
          <DocumentUploadForm
            target={target}
            label={label}
            latest={document}
            onReviewLatest={onReviewLatest}
          />
        ) : (
          explainUploads &&
          !document && (
            <Typography variant="body2" color="text.secondary">
              An operator in your organization can upload it.
            </Typography>
          )
        )}
      </Stack>
    </Box>
  );
}

interface RevisionDocumentsProps {
  voyageId: string;
  contract: CounterpartyContract;
  revision: DocumentaryInstructionRevision;
  /** Whether this is the revision in force: only it takes uploads. */
  current: boolean;
  documents: UseQueryResult<DocumentListResponse>;
}

/**
 * The documents presented against one revision, one per document it requires. For the current
 * revision every required document is listed, presented or not, and the seller's operators can
 * upload; for an earlier one only what was presented against it, read-only. Degrades on its own:
 * the revision above it stays readable when documents cannot be loaded.
 */
export function RevisionDocuments({
  voyageId,
  contract,
  revision,
  current,
  documents,
}: RevisionDocumentsProps) {
  const identity = useIdentity();
  const loaded = documents.data?.items;
  const headingId = `${contract.id}-${revision.number}-documents`;
  const retry = () => void documents.refetch();

  if (!loaded) {
    if (!current) return null;
    return documents.error ? (
      <QueryErrorAlert
        title="Documents could not be loaded"
        error={documents.error}
        onRetry={retry}
      />
    ) : (
      <Skeleton variant="rounded" height={72} aria-label="Loading documents" />
    );
  }

  const required = revision.requirements.map(({ document }) => document);
  const presented = (type: RequiredDocumentType) =>
    findDocument(loaded, contract.id, revision.number, type);
  const shown = current ? required : required.filter((type) => presented(type) !== null);
  if (shown.length === 0) return null;

  const uploads = current && canUploadDocuments(identity, contract);
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography variant="subtitle2" component="h4" id={headingId} sx={{ mb: 1 }}>
        {current ? 'Documents' : `Documents presented against revision ${revision.number}`}
      </Typography>
      {current && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {contract.side === 'SELLER'
            ? `Present each document revision ${revision.number} requires. Uploads go to ${contract.buyer.name} only.`
            : `What ${contract.seller.name} presents against revision ${revision.number}.`}
        </Typography>
      )}
      {documents.error && (
        <Box sx={{ mb: 1.5 }}>
          <QueryErrorAlert
            title="Documents could not be refreshed"
            error={documents.error}
            onRetry={retry}
          />
        </Box>
      )}
      <Stack
        component="ul"
        role="list"
        aria-labelledby={headingId}
        spacing={1.5}
        sx={{ listStyle: 'none', m: 0, p: 0 }}
      >
        {shown.map((type) => (
          <DocumentItem
            key={type}
            target={{
              voyageId,
              contractId: contract.id,
              revisionNumber: revision.number,
              documentType: type,
            }}
            document={presented(type)}
            uploads={uploads}
            explainUploads={current && contract.side === 'SELLER'}
            onReviewLatest={() => documents.refetch()}
          />
        ))}
      </Stack>
    </Box>
  );
}
