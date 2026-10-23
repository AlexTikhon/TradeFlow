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
  canReviewDocuments,
  canUploadDocuments,
  decisionVerb,
  findDocument,
  formatFileSize,
  REVIEW_STATUS_LABELS,
  type ReviewStatus,
  reviewStatusOf,
  shortChecksum,
} from '../domain/documents';
import { useDownloadDocument } from '../hooks/use-document-commands';
import {
  linkedRecordProps,
  linkedRecordSx,
  useDisclosure,
  useLinkedRecord,
} from '../navigation/linked-record';
import { DocumentReviewForm } from './DocumentReviewForm';
import { DocumentUploadForm } from './DocumentUploadForm';

const STATUS_COLORS = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  NOT_REVIEWED: 'default',
} as const satisfies Record<ReviewStatus, string>;

interface ReviewLineProps {
  version: DocumentVersion;
  status: ReviewStatus;
  buyerName: string;
}

/** The decision on one version, or why there is none, under what was uploaded. */
function ReviewLine({ version, status, buyerName }: ReviewLineProps) {
  const { review } = version;
  if (!review) {
    return (
      <Typography variant="caption" color="text.secondary" component="p">
        {status === 'PENDING' ? `Pending review by ${buyerName}` : 'Not reviewed'}
      </Typography>
    );
  }
  const verb = decisionVerb(review);
  return (
    <Box>
      <Typography
        variant="caption"
        component="p"
        color={review.decision === 'REJECTED' ? 'error' : 'success.main'}
      >
        {verb.charAt(0).toUpperCase() + verb.slice(1)} by {review.reviewedBy.name} (
        {review.reviewedBy.organization.name}) on {formatInstant(review.reviewedAt)}
      </Typography>
      {review.reason && (
        <Typography
          variant="body2"
          aria-label={`Reason for rejecting version ${version.number}`}
          sx={{
            mt: 0.5,
            pl: 1,
            borderLeft: 2,
            borderColor: 'error.light',
            overflowWrap: 'anywhere',
            whiteSpace: 'pre-line',
          }}
        >
          {review.reason}
        </Typography>
      )}
    </Box>
  );
}

function describeDownloadFailure(error: Error): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'The file could not be found. It may no longer be available to your organization.';
  }
  return 'The file could not be downloaded. Please try again.';
}

interface VersionLineProps {
  version: DocumentVersion;
  label: string;
  /** Whether it can still be decided on: the latest file, under the current revision. */
  reviewable: boolean;
  buyerName: string;
  downloading: boolean;
  onDownload: () => void;
  /** Whether the page was opened with a link to this version. */
  linked: boolean;
}

/** One version: what was uploaded, by whom and when, the decision on it, and a way to get it. */
function VersionLine({
  version,
  label,
  reviewable,
  buyerName,
  downloading,
  onDownload,
  linked,
}: VersionLineProps) {
  const { uploadedBy } = version;
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      {...(linked && {
        ...linkedRecordProps,
        role: 'group',
        'aria-label': `Version ${version.number} of the ${label.toLowerCase()}`,
      })}
      sx={[
        { alignItems: { sm: 'center' }, justifyContent: 'space-between' },
        linked && linkedRecordSx,
      ]}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          Version {version.number}: {version.fileName} ({formatFileSize(version.sizeBytes)})
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          Uploaded {formatInstant(version.uploadedAt)} by {uploadedBy.name} (
          {uploadedBy.organization.name}) · SHA-256 {shortChecksum(version.sha256)}
        </Typography>
        <ReviewLine
          version={version}
          status={reviewStatusOf(version, reviewable)}
          buyerName={buyerName}
        />
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
  /** The contract's buyer, who reviews it. */
  buyerName: string;
  /** Whether it is under the revision in force: only then can it be uploaded or decided on. */
  current: boolean;
  /** Whether the user may upload it: the current revision, the seller's operator. */
  uploads: boolean;
  /** Whether to say that an operator could upload it: the current revision, the seller. */
  explainUploads: boolean;
  /** Whether the user may decide on it: the current revision, the buyer's operator. */
  reviews: boolean;
  /** Whether to say that an operator could decide on it: the current revision, the buyer. */
  explainReviews: boolean;
  onReviewLatest: () => Promise<unknown>;
}

/**
 * One required document: its current version and its status, earlier versions with the
 * decisions made on them, and the upload or review form if the user may use one.
 */
function DocumentItem({
  target,
  document,
  buyerName,
  current,
  uploads,
  explainUploads,
  reviews,
  explainReviews,
  onReviewLatest,
}: DocumentItemProps) {
  const label = DOCUMENT_LABELS[target.documentType];
  const status = document && reviewStatusOf(document.currentVersion, current);
  const { download, error, pending } = useDownloadDocument(target.voyageId);
  const downloadVersion = (version: DocumentVersion) => {
    download({ target, versionNumber: version.number, fileName: version.fileName });
  };
  const isDownloading = (version: DocumentVersion) => pending?.versionNumber === version.number;
  const linked = useLinkedRecord();
  const linkedVersion =
    linked?.kind === 'DOCUMENT_VERSION' && linked.document.id === document?.id
      ? linked.version.number
      : null;
  // A link to a replaced file opens the earlier versions; the latest is always in view.
  const [historyExpanded, setHistoryExpanded] = useDisclosure(
    linkedVersion !== null && linkedVersion !== document?.currentVersion.number,
  );

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
          />
          {status && (
            <Chip size="small" label={REVIEW_STATUS_LABELS[status]} color={STATUS_COLORS[status]} />
          )}
        </Stack>

        {document && (
          <VersionLine
            version={document.currentVersion}
            label={label}
            reviewable={current}
            buyerName={buyerName}
            downloading={isDownloading(document.currentVersion)}
            onDownload={() => {
              downloadVersion(document.currentVersion);
            }}
            linked={linkedVersion === document.currentVersion.number}
          />
        )}
        {error && <Alert severity="error">{describeDownloadFailure(error)}</Alert>}

        {document && document.previousVersions.length > 0 && (
          <Accordion
            disableGutters
            variant="outlined"
            expanded={historyExpanded}
            onChange={(_event, expanded) => {
              setHistoryExpanded(expanded);
            }}
          >
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
                      reviewable={false}
                      buyerName={buyerName}
                      downloading={isDownloading(version)}
                      onDownload={() => {
                        downloadVersion(version);
                      }}
                      linked={linkedVersion === version.number}
                    />
                  </li>
                ))}
              </Stack>
            </AccordionDetails>
          </Accordion>
        )}

        {document &&
          (reviews ? (
            <DocumentReviewForm
              target={target}
              label={label}
              latest={document}
              onReviewLatest={onReviewLatest}
            />
          ) : (
            explainReviews &&
            status === 'PENDING' && (
              <Typography variant="body2" color="text.secondary">
                An operator in your organization can approve or reject it.
              </Typography>
            )
          ))}

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
  const reviews = current && canReviewDocuments(identity, contract);
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography variant="subtitle2" component="h4" id={headingId} sx={{ mb: 1 }}>
        {current ? 'Documents' : `Documents presented against revision ${revision.number}`}
      </Typography>
      {current && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {contract.side === 'SELLER'
            ? `Present each document revision ${revision.number} requires. Uploads go to ${contract.buyer.name} only, who approves or rejects each version.`
            : `What ${contract.seller.name} presents against revision ${revision.number}. Each latest version is approved, or rejected with a reason, by your organization.`}
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
            buyerName={contract.buyer.name}
            current={current}
            uploads={uploads}
            explainUploads={current && contract.side === 'SELLER'}
            reviews={reviews}
            explainReviews={current && contract.side === 'BUYER'}
            onReviewLatest={() => documents.refetch()}
          />
        ))}
      </Stack>
    </Box>
  );
}
