import { Alert, AlertTitle, Button, type AlertColor } from '@mui/material';
import { formatInstant } from '../../../shared/lib/format';
import { DOCUMENT_LABELS } from '../domain/documentary-instructions';
import { decisionVerb } from '../domain/documents';
import { LINKED_RECORD_STATUS_ID } from '../navigation/linked-record';
import type { LinkedRecord, LinkResolution } from '../navigation/record-resolution';

interface Explanation {
  severity: AlertColor;
  title: string;
  body: string;
}

const by = ({ name, organization }: { name: string; organization: { name: string } }) =>
  `${name} (${organization.name})`;

/**
 * What became of the record since the link was made, from the organization's side of its
 * contract. Says plainly when nothing is waiting any more, and when what is shown is history: a
 * link is never moved on to a newer revision or file.
 */
function explain(record: LinkedRecord): Explanation {
  const { contract } = record;
  const buying = contract.side === 'BUYER';

  if (record.kind === 'NOTICE') {
    const { notice } = record;
    if (notice.acknowledgedAt && notice.acknowledgedBy) {
      return {
        severity: 'success',
        title: 'This ETA notice has already been acknowledged',
        body: `${by(notice.acknowledgedBy)} acknowledged receipt on ${formatInstant(notice.acknowledgedAt)}. Nothing is waiting on it any more.`,
      };
    }
    const deadline = `Acknowledge by ${formatInstant(notice.acknowledgementDueAt)}${notice.overdue ? ': the deadline has passed' : ''}.`;
    return buying
      ? {
          severity: notice.overdue ? 'warning' : 'info',
          title: 'This ETA notice is waiting for your organization to acknowledge receipt',
          body: deadline,
        }
      : {
          severity: 'info',
          title: `This ETA notice is waiting for ${contract.buyer.name} to acknowledge receipt`,
          body: deadline,
        };
  }

  if (record.kind === 'INSTRUCTION_REVISION') {
    const { revision, instruction } = record;
    const { acknowledgement } = revision;
    if (!record.current) {
      return {
        severity: 'warning',
        title: `Revision ${revision.number} has been superseded`,
        body: `Revision ${instruction.currentRevision.number} of these documentary instructions is now in force. Revision ${revision.number} is shown below as history, read-only: ${acknowledgement ? 'it was acknowledged, and' : 'it can no longer be acknowledged, so'} nothing is waiting on it.`,
      };
    }
    if (acknowledgement) {
      return {
        severity: 'success',
        title: `Revision ${revision.number} has already been acknowledged`,
        body: `${by(acknowledgement.acknowledgedBy)} acknowledged receipt on ${formatInstant(acknowledgement.acknowledgedAt)}. Nothing is waiting on it any more.`,
      };
    }
    return {
      severity: 'info',
      title: buying
        ? `Revision ${revision.number} is waiting for ${contract.seller.name} to acknowledge receipt`
        : `Revision ${revision.number} is waiting for your organization to acknowledge receipt`,
      body: 'It is the revision in force.',
    };
  }

  const { document, version, instruction } = record;
  const label = DOCUMENT_LABELS[document.documentType].toLowerCase();
  const file = `Version ${version.number} of the ${label}`;
  const decided = version.review
    ? ` It was ${decisionVerb(version.review)} by ${by(version.review.reviewedBy)} on ${formatInstant(version.review.reviewedAt)}.`
    : ' It was never reviewed.';
  if (!record.revisionCurrent) {
    return {
      severity: 'warning',
      title: `Revision ${document.revisionNumber} has been superseded`,
      body: `${file} was presented against revision ${document.revisionNumber} of the documentary instructions; revision ${instruction.currentRevision.number} is now in force. It is shown below as history, read-only, and nothing is waiting on it.${decided}`,
    };
  }
  if (!record.latest) {
    return {
      severity: 'warning',
      title: `${file} has been replaced`,
      body: `Version ${document.currentVersion.number} is now the latest file. Version ${version.number} is shown below as history, read-only, and nothing is waiting on it.${decided} A decision or a replacement applies only to version ${document.currentVersion.number}.`,
    };
  }
  const { review } = version;
  if (!review) {
    return {
      severity: 'info',
      title: buying
        ? `${file} is waiting for your organization’s decision`
        : `${file} is waiting for ${contract.buyer.name}’s decision`,
      body: 'It is the latest file, under the revision in force.',
    };
  }
  if (review.decision === 'APPROVED') {
    return {
      severity: 'success',
      title: `${file} has already been approved`,
      body: `Approved by ${by(review.reviewedBy)} on ${formatInstant(review.reviewedAt)}. Nothing is waiting on it any more.`,
    };
  }
  return buying
    ? {
        severity: 'success',
        title: `${file} has already been rejected`,
        body: `Rejected by ${by(review.reviewedBy)} on ${formatInstant(review.reviewedAt)}. Nothing is waiting for your decision; ${contract.seller.name} can upload a replacement.`,
      }
    : {
        severity: 'info',
        title: `${file} was rejected and is waiting for your organization to replace it`,
        body: `Rejected by ${by(review.reviewedBy)} on ${formatInstant(review.reviewedAt)}. The reason is shown with the file below.`,
      };
}

const NOT_OPENED = 'Nothing has been opened or changed.';

interface LinkedRecordStatusProps {
  resolution: LinkResolution;
  /** Moves focus to the linked record again. */
  onShow: () => void;
}

/**
 * The page's explanation of the record link it was opened with: what the record is now, or why
 * it cannot be shown. Never offers a command: those stay with the record, under their usual
 * rules.
 */
export function LinkedRecordStatus({ resolution, onShow }: LinkedRecordStatusProps) {
  let explanation: Explanation;
  switch (resolution.status) {
    case 'none':
      return null;
    case 'loading':
      return (
        <Alert severity="info" role="status" id={LINKED_RECORD_STATUS_ID}>
          Finding the linked record…
        </Alert>
      );
    case 'malformed':
      explanation = {
        severity: 'warning',
        title: 'This link is not valid',
        body: `Part of it is missing or malformed, so it does not name a record. ${NOT_OPENED}`,
      };
      break;
    case 'unavailable':
      explanation = {
        severity: 'warning',
        title: 'The linked record cannot be found',
        body: `It is not on this voyage, or your organization cannot see it. ${NOT_OPENED}`,
      };
      break;
    case 'failed':
      explanation = {
        severity: 'warning',
        title: 'The linked record cannot be shown yet',
        body: 'Part of this voyage could not be loaded. Retry in the section below.',
      };
      break;
    case 'resolved':
      explanation = explain(resolution.record);
      break;
  }

  return (
    <Alert
      severity={explanation.severity}
      role="status"
      id={LINKED_RECORD_STATUS_ID}
      aria-label="Linked record"
      action={
        resolution.status === 'resolved' && (
          <Button color="inherit" size="small" onClick={onShow}>
            Show it
          </Button>
        )
      }
    >
      <AlertTitle>{explanation.title}</AlertTitle>
      {explanation.body}
    </Alert>
  );
}
