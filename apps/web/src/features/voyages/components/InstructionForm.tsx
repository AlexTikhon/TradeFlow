import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  type CounterpartyContract,
  type DocumentaryInstruction,
  DocumentaryInstructionContentSchema,
  type DocumentaryInstructionRevision,
  MAX_DOCUMENT_COUNT,
  PARTY_DETAILS_MAX_LENGTH,
  type ProblemFieldError,
  REQUIRED_DOCUMENT_TYPES,
  type RequiredDocumentType,
} from '@tradeflow/contracts';
import { type SubmitEvent, useState } from 'react';
import { ApiError } from '../../../shared/api/http-client';
import { formatInstant } from '../../../shared/lib/format';
import { DOCUMENT_LABELS } from '../domain/documentary-instructions';
import {
  isPreconditionFailure,
  useSubmitInstruction,
} from '../hooks/use-documentary-instruction-commands';
import { InstructionRevision } from './InstructionRevision';

/** One requirement row as typed: counts stay text until the draft is checked. */
interface Row {
  key: number;
  document: RequiredDocumentType | '';
  originals: string;
  copies: string;
}

interface Draft {
  consignee: string;
  notifyParty: string;
  rows: Row[];
}

/** The version a draft is based on: what the user saw when they started, or chose to adopt. */
type Basis = { version: number; revisionNumber: number } | null;

type FieldErrors = Record<string, string>;

const basisOf = (instruction: DocumentaryInstruction | null): Basis =>
  instruction && {
    version: instruction.version,
    revisionNumber: instruction.currentRevision.number,
  };

/** React keys for requirement rows, which have no identity of their own; unique is enough. */
let rowKeys = 0;
const nextKey = () => (rowKeys += 1);

function draftFrom(revision: DocumentaryInstructionRevision | undefined): Draft {
  if (!revision) {
    return {
      consignee: '',
      notifyParty: '',
      rows: [{ key: nextKey(), document: '', originals: '', copies: '' }],
    };
  }
  return {
    consignee: revision.consignee,
    notifyParty: revision.notifyParty ?? '',
    rows: revision.requirements.map((requirement) => ({
      key: nextKey(),
      document: requirement.document,
      originals: String(requirement.originals),
      copies: String(requirement.copies),
    })),
  };
}

/** A typed count as the contract sees it: a number when it is one, otherwise left to fail. */
const toCount = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text) : undefined);

const toCandidate = ({ consignee, notifyParty, rows }: Draft) => ({
  consignee,
  ...(notifyParty.trim() !== '' && { notifyParty }),
  requirements: rows.map((row) => ({
    document: row.document === '' ? undefined : row.document,
    originals: toCount(row.originals),
    copies: toCount(row.copies),
  })),
});

/** Messages for what is missing or unreadable, rather than the schema's type errors. */
function messageFor(path: string, message: string, draft: Draft): string {
  const match = /^requirements\.(\d+)\.(document|originals|copies)$/.exec(path);
  const row = match ? draft.rows[Number(match[1])] : undefined;
  if (!match || !row) return message;
  const field = match[2] as 'document' | 'originals' | 'copies';
  if (field === 'document') return row.document === '' ? 'Choose a document' : message;
  const text = row[field].trim();
  if (text === '') return 'Enter a number';
  return /^\d+$/.test(text) ? message : 'Enter a whole number';
}

/** Groups errors by field path; what names no field is reported for the whole form. */
function toFieldErrors(errors: ProblemFieldError[], draft: Draft) {
  const fields: FieldErrors = {};
  const other: string[] = [];
  for (const { path, message } of errors) {
    const field = path.replace(/^body\.?/, '');
    if (field === '') {
      other.push(message);
    } else {
      fields[field] ??= messageFor(field, message, draft);
    }
  }
  return { fields, other };
}

function describeFailure(error: Error): string {
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'The instructions could not be sent. Please try again.';
}

/** What happened to the instructions since the draft's basis, in a sentence. */
function describeChange(latest: DocumentaryInstruction, basis: Basis): string {
  const { currentRevision } = latest;
  const given = `Revision ${currentRevision.number} was given by ${currentRevision.createdBy.name} on ${formatInstant(currentRevision.createdAt)}`;
  if (!basis || currentRevision.number !== basis.revisionNumber) {
    return `${given}, after you started this draft.`;
  }
  const { acknowledgement } = currentRevision;
  return acknowledgement
    ? `The seller (${acknowledgement.acknowledgedBy.name}) acknowledged revision ${currentRevision.number} after you started this draft.`
    : `The instructions changed after you started this draft.`;
}

interface InstructionFormProps {
  voyageId: string;
  contract: CounterpartyContract;
  /**
   * The instructions as the page has them now (null while there are none). This follows the
   * cache, so it moves on when the list is refreshed; the draft's basis does not.
   */
  latest: DocumentaryInstruction | null;
  /** Fetches the latest instructions, for the user to review after a conflict. */
  onReviewLatest: () => Promise<unknown>;
  onSaved: (instruction: DocumentaryInstruction) => void;
  onCancel: () => void;
}

/**
 * The buyer's form for the first instructions or a new revision. It starts from the current
 * revision and remembers the version it started from (its basis), which is what it sends in
 * If-Match. If the instructions move on meanwhile (a 412, or a refresh that shows a newer
 * version) the draft is kept untouched and the newer version is shown next to it; the user must
 * explicitly base the draft on it before it can be sent. Nothing is sent again on its own.
 */
export function InstructionForm({
  voyageId,
  contract,
  latest,
  onReviewLatest,
  onSaved,
  onCancel,
}: InstructionFormProps) {
  const { submit, error, isPending, isSuccess, reset } = useSubmitInstruction(voyageId);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(latest?.currentRevision));
  const [basis, setBasis] = useState<Basis>(() => basisOf(latest));
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const [reviewing, setReviewing] = useState(false);

  // After a successful write the cache holds the version just written, until the form closes.
  const stale = !isSuccess && (latest?.version ?? null) !== (basis?.version ?? null);
  const conflict = isPreconditionFailure(error);
  const serverProblems =
    error instanceof ApiError && error.status === 400
      ? toFieldErrors(error.problem?.errors ?? [], draft)
      : undefined;
  const fieldErrors: FieldErrors = { ...clientErrors, ...serverProblems?.fields };
  const formError = serverProblems
    ? serverProblems.other.join(' ') || undefined
    : error && !conflict
      ? describeFailure(error)
      : undefined;

  const edit = (change: (current: Draft) => Draft, ...fields: string[]) => {
    setDraft(change);
    if (fields.length > 0) {
      setClientErrors((current) =>
        Object.fromEntries(Object.entries(current).filter(([path]) => !fields.includes(path))),
      );
    }
  };
  const editRow = (index: number, field: keyof Omit<Row, 'key'>, value: string) => {
    edit(
      (current) => ({
        ...current,
        rows: current.rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
      }),
      `requirements.${index}.${field}`,
      // A changed count can settle the "at least one original or copy" rule, reported on originals.
      `requirements.${index}.originals`,
      'requirements',
    );
  };

  const reviewLatest = async () => {
    setReviewing(true);
    try {
      await onReviewLatest();
    } finally {
      setReviewing(false);
    }
  };

  const adoptLatest = () => {
    setBasis(basisOf(latest));
    reset();
  };

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (stale) return;
    const parsed = DocumentaryInstructionContentSchema.safeParse(toCandidate(draft));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      setClientErrors(toFieldErrors(issues, draft).fields);
      return;
    }
    setClientErrors({});
    submit(
      { contractId: contract.id, content: parsed.data, basedOnVersion: basis?.version ?? null },
      onSaved,
    );
  };

  const nextRevision = (basis?.revisionNumber ?? 0) + 1;
  const used = new Set(draft.rows.map((row) => row.document));

  return (
    <Stack
      component="form"
      noValidate
      aria-label={basis ? 'Revise documentary instructions' : 'Give documentary instructions'}
      onSubmit={onSubmit}
      spacing={2.5}
      sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}
    >
      <Typography variant="body2" color="text.secondary">
        {basis
          ? `Your changes become revision ${nextRevision}. Revision ${basis.revisionNumber} stays on record unchanged, and the seller is asked to acknowledge the new revision.`
          : 'The seller is asked to acknowledge receipt. Later changes become new revisions; none is ever overwritten.'}
      </Typography>

      {stale && latest && (
        <Alert severity="warning" role="region" aria-label="Latest version">
          <AlertTitle>The instructions have changed</AlertTitle>
          <Stack spacing={2}>
            <Typography variant="body2">
              {describeChange(latest, basis)} Your draft below is kept as you wrote it; review the
              latest version, then base your draft on it before sending.
            </Typography>
            <Box sx={{ p: 1.5, bgcolor: 'background.paper', borderRadius: 1 }}>
              <InstructionRevision revision={latest.currentRevision} current />
            </Box>
            <Box>
              <Button variant="outlined" color="inherit" onClick={adoptLatest}>
                Base my draft on revision {latest.currentRevision.number}
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
          <AlertTitle>Not sent</AlertTitle>
          The instructions changed after you started this draft. Your draft is kept.
        </Alert>
      )}

      {formError && <Alert severity="error">{formError}</Alert>}

      <TextField
        label="Consignee"
        required
        multiline
        minRows={2}
        value={draft.consignee}
        onChange={(event) => {
          edit((current) => ({ ...current, consignee: event.target.value }), 'consignee');
        }}
        error={Boolean(fieldErrors.consignee)}
        helperText={
          fieldErrors.consignee ??
          `As it should appear on the bill of lading. Up to ${PARTY_DETAILS_MAX_LENGTH} characters.`
        }
      />
      <TextField
        label="Notify party (optional)"
        multiline
        minRows={2}
        value={draft.notifyParty}
        onChange={(event) => {
          edit((current) => ({ ...current, notifyParty: event.target.value }), 'notifyParty');
        }}
        error={Boolean(fieldErrors.notifyParty)}
        helperText={fieldErrors.notifyParty ?? `Up to ${PARTY_DETAILS_MAX_LENGTH} characters`}
      />

      <Box>
        <Typography variant="subtitle2" component="h4" id={`${contract.id}-documents`}>
          Required documents
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Each document once, with up to {MAX_DOCUMENT_COUNT} originals and {MAX_DOCUMENT_COUNT}{' '}
          copies.
        </Typography>
        {fieldErrors.requirements && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {fieldErrors.requirements}
          </Alert>
        )}
        <Stack
          component="ul"
          role="list"
          aria-labelledby={`${contract.id}-documents`}
          spacing={2}
          sx={{ listStyle: 'none', m: 0, mt: 1.5, p: 0 }}
        >
          {draft.rows.map((row, index) => {
            const error = (field: string) => fieldErrors[`requirements.${index}.${field}`];
            return (
              <Box
                component="li"
                key={row.key}
                aria-label={`Required document ${index + 1}`}
                sx={{
                  display: 'grid',
                  gap: 1.5,
                  alignItems: 'start',
                  gridTemplateColumns: { xs: '1fr 1fr auto', sm: '2fr 1fr 1fr auto' },
                }}
              >
                <TextField
                  select
                  label="Document"
                  value={row.document}
                  onChange={(event) => {
                    editRow(index, 'document', event.target.value);
                  }}
                  error={Boolean(error('document'))}
                  helperText={error('document')}
                  slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
                  sx={{ gridColumn: { xs: '1 / -1', sm: 'auto' } }}
                >
                  <option value="" disabled>
                    Select…
                  </option>
                  {REQUIRED_DOCUMENT_TYPES.map((document) => (
                    <option
                      key={document}
                      value={document}
                      disabled={document !== row.document && used.has(document)}
                    >
                      {DOCUMENT_LABELS[document]}
                    </option>
                  ))}
                </TextField>
                <TextField
                  label="Originals"
                  type="number"
                  value={row.originals}
                  onChange={(event) => {
                    editRow(index, 'originals', event.target.value);
                  }}
                  error={Boolean(error('originals'))}
                  helperText={error('originals')}
                  slotProps={{ htmlInput: { min: 0, max: MAX_DOCUMENT_COUNT, step: 1 } }}
                />
                <TextField
                  label="Copies"
                  type="number"
                  value={row.copies}
                  onChange={(event) => {
                    editRow(index, 'copies', event.target.value);
                  }}
                  error={Boolean(error('copies'))}
                  helperText={error('copies')}
                  slotProps={{ htmlInput: { min: 0, max: MAX_DOCUMENT_COUNT, step: 1 } }}
                />
                <IconButton
                  aria-label={`Remove required document ${index + 1}`}
                  disabled={draft.rows.length === 1}
                  onClick={() => {
                    setClientErrors({});
                    edit((current) => ({
                      ...current,
                      rows: current.rows.filter((_, i) => i !== index),
                    }));
                  }}
                  sx={{ mt: 1 }}
                >
                  <DeleteOutlineIcon />
                </IconButton>
              </Box>
            );
          })}
        </Stack>
        <Button
          startIcon={<AddIcon />}
          sx={{ mt: 1 }}
          disabled={draft.rows.length >= REQUIRED_DOCUMENT_TYPES.length}
          onClick={() => {
            edit(
              (current) => ({
                ...current,
                rows: [
                  ...current.rows,
                  { key: nextKey(), document: '', originals: '', copies: '' },
                ],
              }),
              'requirements',
            );
          }}
        >
          Add a document
        </Button>
      </Box>

      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Button
          type="submit"
          variant="contained"
          disabled={isPending || stale}
          startIcon={isPending ? <CircularProgress size={18} color="inherit" /> : null}
        >
          {basis ? `Send revision ${nextRevision}` : 'Send instructions'}
        </Button>
        <Button onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        {stale && (
          <Typography variant="body2" color="text.secondary">
            Review the latest version above before sending.
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
