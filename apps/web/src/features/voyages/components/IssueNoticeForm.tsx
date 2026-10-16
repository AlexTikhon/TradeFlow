import {
  Alert,
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
  type CounterpartyContract,
  type IssueNoticeRequest,
  IssueNoticeRequestSchema,
  NOTICE_MESSAGE_MAX_LENGTH,
  type Notice,
  type ProblemFieldError,
} from '@tradeflow/contracts';
import { type SubmitEvent, useId, useState } from 'react';
import { ApiError } from '../../../shared/api/http-client';
import { localTimeZone } from '../../../shared/lib/format';
import {
  describeOccurrence,
  type LocalDateTimeResolution,
  type Occurrence,
  resolveLocalDateTime,
} from '../../../shared/lib/local-date-time';
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

const TIME_FIELDS = ['estimatedArrivalAt', 'acknowledgementDueAt'] as const;
type TimeField = (typeof TIME_FIELDS)[number];

/** The instant the user chose for a repeated local time; editing the time forgets it. */
type Choices = Partial<Record<TimeField, string>>;

interface TimeEntry {
  /** Undefined while the field is empty. */
  resolution?: LocalDateTimeResolution;
  /** The one instant this entry stands for, once there is exactly one. */
  occurrence?: Occurrence | undefined;
}

/**
 * A `datetime-local` value ("2026-10-20T14:00") is a wall-clock time in the viewer's time zone.
 * It becomes an instant here, before it leaves the browser, and only when there is exactly one:
 * a repeated time needs the user's choice, and a skipped or impossible one is refused.
 */
function resolveTime(local: string, zone: string, choice?: Choices[TimeField]): TimeEntry {
  if (local === '') {
    return {};
  }
  const resolution = resolveLocalDateTime(local, zone);
  if (resolution.kind === 'exact') {
    return { resolution, occurrence: resolution.occurrence };
  }
  const chosen =
    resolution.kind === 'repeated'
      ? resolution.occurrences.find((occurrence) => occurrence.instant === choice)
      : undefined;
  return { resolution, occurrence: chosen };
}

/** Why an entered time cannot be sent yet; an empty field is the schema's to report. */
function timeProblem({ resolution, occurrence }: TimeEntry, zone: string): string | undefined {
  switch (resolution?.kind) {
    case 'invalid':
      return 'Enter a real date and time.';
    case 'nonexistent':
      return `This time does not exist in ${zone}: the clocks skip it. Enter another time.`;
    case 'repeated':
      return occurrence
        ? undefined
        : `This time occurs twice in ${zone}, as the clocks go back. Choose which one.`;
    default:
      return undefined;
  }
}

const toRequest = (values: Record<Field, string>, times: Record<TimeField, TimeEntry>) => ({
  contractId: values.contractId,
  estimatedArrivalAt: times.estimatedArrivalAt.occurrence?.instant,
  acknowledgementDueAt: times.acknowledgementDueAt.occurrence?.instant,
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
  const [localTimes, setLocalTimes] = useState<Record<TimeField, string>>({
    estimatedArrivalAt: '',
    acknowledgementDueAt: '',
  });
  const [choices, setChoices] = useState<Choices>({});
  const zone = localTimeZone();
  const resolveAll = (values: Record<TimeField, string>) =>
    Object.fromEntries(
      TIME_FIELDS.map((field) => [field, resolveTime(values[field], zone, choices[field])]),
    ) as Record<TimeField, TimeEntry>;
  // What the user sees below each field is what submitting would send.
  const times = resolveAll(localTimes);

  /** A new value or choice answers any earlier complaint about that field. */
  const clearError = (field: TimeField) => {
    setClientErrors(({ [field]: _cleared, ...rest }) => rest);
  };
  const changeTime = (field: TimeField, local: string) => {
    setLocalTimes((current) => ({ ...current, [field]: local }));
    setChoices(({ [field]: _forgotten, ...rest }) => rest);
    clearError(field);
  };
  const choose = (field: TimeField, instant: string) => {
    setChoices((current) => ({ ...current, [field]: instant }));
    clearError(field);
  };

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
    const submittedTimes = resolveAll(values);
    // Listed first, so they win over the schema's report of the same missing instant.
    const issues: ProblemFieldError[] = TIME_FIELDS.flatMap((field) => {
      const message = timeProblem(submittedTimes[field], zone);
      return message ? [{ path: field, message }] : [];
    });
    // The ordering refinement compares the resolved instants, never the wall-clock text.
    const parsed = IssueNoticeRequestSchema.safeParse(toRequest(values, submittedTimes));
    issues.push(
      ...(parsed.error?.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })) ?? []),
    );
    // The server checks this against its own clock; checking here too saves a round trip.
    const due = submittedTimes.acknowledgementDueAt.occurrence?.instant;
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

      <Box
        sx={{
          display: 'grid',
          gap: 2.5,
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          alignItems: 'start',
        }}
      >
        <TimeInput
          name="estimatedArrivalAt"
          label="Estimated arrival"
          choiceLabel="Which arrival is meant?"
          value={localTimes.estimatedArrivalAt}
          entry={times.estimatedArrivalAt}
          zone={zone}
          error={fieldErrors.estimatedArrivalAt}
          onChange={changeTime}
          onChoose={choose}
        />
        <TimeInput
          name="acknowledgementDueAt"
          label="Acknowledge by"
          choiceLabel="Which deadline is meant?"
          hint="In the future, and not after the arrival"
          value={localTimes.acknowledgementDueAt}
          entry={times.acknowledgementDueAt}
          zone={zone}
          error={fieldErrors.acknowledgementDueAt}
          onChange={changeTime}
          onChoose={choose}
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

interface TimeInputProps {
  name: TimeField;
  label: string;
  /** Names the choice between the occurrences of a repeated time. */
  choiceLabel: string;
  hint?: string;
  value: string;
  entry: TimeEntry;
  zone: string;
  error?: string | undefined;
  onChange: (field: TimeField, local: string) => void;
  onChoose: (field: TimeField, instant: string) => void;
}

/**
 * A wall-clock time with what it resolves to: its UTC offset and instant, a warning when it
 * cannot be sent as it is, and the choice between the two occurrences of a repeated time.
 */
function TimeInput({
  name,
  label,
  choiceLabel,
  hint,
  value,
  entry,
  zone,
  error,
  onChange,
  onChoose,
}: TimeInputProps) {
  const choiceLabelId = useId();
  const { resolution, occurrence } = entry;
  const resolved = occurrence && describeOccurrence(occurrence);
  return (
    <Stack spacing={1}>
      <TextField
        name={name}
        label={label}
        type="datetime-local"
        required
        value={value}
        onChange={(event) => {
          onChange(name, event.target.value);
        }}
        error={Boolean(error)}
        helperText={error ?? resolved ?? timeProblem(entry, zone) ?? hint}
        slotProps={{ inputLabel: { shrink: true } }}
      />
      {resolution?.kind === 'repeated' && (
        <FormControl error={Boolean(error)}>
          <FormLabel id={choiceLabelId}>{choiceLabel}</FormLabel>
          <RadioGroup
            aria-labelledby={choiceLabelId}
            value={occurrence?.instant ?? ''}
            onChange={(event) => {
              onChoose(name, event.target.value);
            }}
          >
            {resolution.occurrences.map((candidate, index) => (
              <FormControlLabel
                key={candidate.instant}
                value={candidate.instant}
                control={<Radio size="small" />}
                label={`${index === 0 ? 'Earlier' : 'Later'}: ${describeOccurrence(candidate)}`}
              />
            ))}
          </RadioGroup>
        </FormControl>
      )}
    </Stack>
  );
}
