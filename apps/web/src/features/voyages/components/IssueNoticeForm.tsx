import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import {
  type CounterpartyContract,
  type IssueNoticeRequest,
  IssueNoticeRequestSchema,
  NOTICE_MESSAGE_MAX_LENGTH,
  type Notice,
  type ProblemFieldError,
} from '@tradeflow/contracts';
import { type SubmitEvent, useState } from 'react';
import { ApiError } from '../../../shared/api/http-client';
import { localTimeZone } from '../../../shared/lib/format';
import { describeContract } from '../domain/notices';
import { useIssueNotice } from '../hooks/use-notice-commands';

const FIELDS = ['contractId', 'estimatedArrivalAt', 'acknowledgementDueAt', 'message'] as const;
type Field = (typeof FIELDS)[number];
type FieldErrors = Partial<Record<Field, string>>;

const WHEN_EMPTY: Partial<Record<Field, string>> = {
  contractId: 'Select the contract.',
  estimatedArrivalAt: 'Enter the estimated arrival.',
  acknowledgementDueAt: 'Enter the acknowledgement deadline.',
};

const isField = (path: string): path is Field => (FIELDS as readonly string[]).includes(path);

/** Groups errors by form field; anything that names no field is reported for the whole form. */
function toFieldErrors(errors: ProblemFieldError[], values: Record<Field, string>) {
  const fields: FieldErrors = {};
  const other: string[] = [];
  for (const { path, message } of errors) {
    const field = path.replace(/^body\.?/, '');
    if (isField(field)) {
      fields[field] ??= (values[field] === '' && WHEN_EMPTY[field]) || message;
    } else {
      other.push(message);
    }
  }
  return { fields, other };
}

function readForm(form: HTMLFormElement): Record<Field, string> {
  const data = new FormData(form);
  const value = (name: Field) => {
    const raw = data.get(name);
    return typeof raw === 'string' ? raw.trim() : '';
  };
  return Object.fromEntries(FIELDS.map((field) => [field, value(field)])) as Record<Field, string>;
}

/**
 * A `datetime-local` value ("2026-10-20T14:00") is a wall-clock time in the viewer's time zone.
 * It becomes an unambiguous instant here, before it leaves the browser.
 */
function toInstant(localDateTime: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(localDateTime)) {
    return undefined;
  }
  const instant = new Date(localDateTime);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

const toRequest = (values: Record<Field, string>) => ({
  contractId: values.contractId,
  estimatedArrivalAt: toInstant(values.estimatedArrivalAt),
  acknowledgementDueAt: toInstant(values.acknowledgementDueAt),
  ...(values.message !== '' && { message: values.message }),
});

function describeFailure(error: Error): string {
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'The notice could not be issued. Please try again.';
}

interface IssueNoticeFormProps {
  voyageId: string;
  /** Contracts under which the organization sells; the user picks one. */
  contracts: CounterpartyContract[];
  onIssued: (notice: Notice) => void;
  onCancel: () => void;
}

export function IssueNoticeForm({ voyageId, contracts, onIssued, onCancel }: IssueNoticeFormProps) {
  const { issue, error, isPending } = useIssueNotice(voyageId);
  const [submitted, setSubmitted] = useState<Record<Field, string> | null>(null);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  const serverProblems =
    error instanceof ApiError && error.status === 400 && submitted
      ? toFieldErrors(error.problem?.errors ?? [], submitted)
      : undefined;
  const fieldErrors: FieldErrors = { ...clientErrors, ...serverProblems?.fields };
  const formError = serverProblems
    ? serverProblems.other.join(' ') || undefined
    : error && describeFailure(error);

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = readForm(event.currentTarget);
    setSubmitted(values);
    const parsed = IssueNoticeRequestSchema.safeParse(toRequest(values));
    const issues =
      parsed.error?.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })) ?? [];
    // The server checks this against its own clock; checking here too saves a round trip.
    const due = toInstant(values.acknowledgementDueAt);
    if (due && Date.parse(due) <= Date.now()) {
      issues.push({
        path: 'acknowledgementDueAt',
        message: 'The acknowledgement deadline must be in the future',
      });
    }
    if (!parsed.success || issues.length > 0) {
      setClientErrors(toFieldErrors(issues, values).fields);
      return;
    }
    setClientErrors({});
    issue(parsed.data satisfies IssueNoticeRequest, onIssued);
  };

  return (
    <Stack
      component="form"
      noValidate
      aria-label="Issue ETA notice"
      onSubmit={onSubmit}
      spacing={2.5}
      sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}
    >
      <Typography variant="body2" color="text.secondary">
        The buyer under the contract receives the notice and is asked to acknowledge receipt by the
        deadline. Times are in your time zone ({localTimeZone()}). A notice cannot be changed once
        issued; issue a new one if the ETA moves.
      </Typography>

      {formError && <Alert severity="error">{formError}</Alert>}

      <TextField
        select
        name="contractId"
        label="Contract"
        // With a single contract there is nothing to choose.
        defaultValue={contracts.length === 1 ? contracts[0]?.id : ''}
        required
        error={Boolean(fieldErrors.contractId)}
        helperText={fieldErrors.contractId}
        slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
      >
        <option value="" disabled>
          Select…
        </option>
        {contracts.map((contract) => (
          <option key={contract.id} value={contract.id}>
            {describeContract(contract)}
          </option>
        ))}
      </TextField>

      <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
        <TextField
          name="estimatedArrivalAt"
          label="Estimated arrival"
          type="datetime-local"
          required
          error={Boolean(fieldErrors.estimatedArrivalAt)}
          helperText={fieldErrors.estimatedArrivalAt}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          name="acknowledgementDueAt"
          label="Acknowledge by"
          type="datetime-local"
          required
          error={Boolean(fieldErrors.acknowledgementDueAt)}
          helperText={
            fieldErrors.acknowledgementDueAt ?? 'In the future, and not after the arrival'
          }
          slotProps={{ inputLabel: { shrink: true } }}
        />
      </Box>

      <TextField
        name="message"
        label="Message (optional)"
        multiline
        minRows={2}
        error={Boolean(fieldErrors.message)}
        helperText={fieldErrors.message ?? `Up to ${NOTICE_MESSAGE_MAX_LENGTH} characters`}
      />

      <Stack direction="row" spacing={2}>
        <Button
          type="submit"
          variant="contained"
          disabled={isPending}
          startIcon={isPending ? <CircularProgress size={18} color="inherit" /> : null}
        >
          Issue notice
        </Button>
        <Button onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
      </Stack>
    </Stack>
  );
}
