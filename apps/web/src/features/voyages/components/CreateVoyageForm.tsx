import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import {
  type CreateVoyageRequest,
  CreateVoyageRequestSchema,
  type ProblemFieldError,
} from '@tradeflow/contracts';
import { type ReactNode, type SubmitEvent, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { ApiError } from '../../../shared/api/http-client';
import { useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import { referenceDataQueries } from '../api/reference-data.queries';
import { useCreateVoyage } from '../hooks/use-create-voyage';

/** Form fields, named by their path in the request body. */
const FIELDS = [
  'vesselId',
  'commodityId',
  'quantity.amount',
  'loadPortId',
  'dischargePortId',
  'laycan.start',
  'laycan.end',
] as const;
type Field = (typeof FIELDS)[number];
type FieldErrors = Partial<Record<Field, string>>;

/** What to say when a field was left empty; otherwise the contract's own message is shown. */
const WHEN_EMPTY: Record<Field, string> = {
  vesselId: 'Select a vessel.',
  commodityId: 'Select a commodity.',
  'quantity.amount': 'Enter the quantity.',
  loadPortId: 'Select the load port.',
  dischargePortId: 'Select the discharge port.',
  'laycan.start': 'Enter the first laycan day.',
  'laycan.end': 'Enter the last laycan day.',
};

const isField = (path: string): path is Field => (FIELDS as readonly string[]).includes(path);

/** Groups errors by form field; anything that names no field is reported for the whole form. */
function toFieldErrors(errors: ProblemFieldError[], values: Record<Field, string>) {
  const fields: FieldErrors = {};
  const other: string[] = [];
  for (const { path, message } of errors) {
    const field = path.replace(/^body\.?/, '');
    if (isField(field)) {
      fields[field] ??= values[field] === '' ? WHEN_EMPTY[field] : message;
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

const toRequest = (values: Record<Field, string>) => ({
  vesselId: values.vesselId,
  commodityId: values.commodityId,
  // The amount stays the string the user typed: no float ever touches it.
  quantity: { amount: values['quantity.amount'], unit: 'MT' },
  loadPortId: values.loadPortId,
  dischargePortId: values.dischargePortId,
  laycan: { start: values['laycan.start'], end: values['laycan.end'] },
});

function describeFailure(error: Error): string {
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'The voyage could not be created. Please try again.';
}

interface SelectFieldProps {
  name: Field;
  label: string;
  error: string | undefined;
  disabled: boolean;
  children: ReactNode;
}

function SelectField({ name, label, error, disabled, children }: SelectFieldProps) {
  return (
    <TextField
      select
      name={name}
      label={label}
      defaultValue=""
      required
      disabled={disabled}
      error={Boolean(error)}
      helperText={error}
      slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
    >
      <option value="" disabled>
        {disabled ? 'Loading…' : `Select…`}
      </option>
      {children}
    </TextField>
  );
}

export function CreateVoyageForm() {
  const identity = useIdentity();
  const scope = useProtectedScope();
  const vessels = useQuery(referenceDataQueries.vessels(scope));
  const commodities = useQuery(referenceDataQueries.commodities(scope));
  const ports = useQuery(referenceDataQueries.ports(scope));
  const { create, error, isPending } = useCreateVoyage();
  // What was submitted last, to word server errors about fields that were left empty.
  const [submitted, setSubmitted] = useState<Record<Field, string> | null>(null);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  const lookupError = vessels.error ?? commodities.error ?? ports.error;
  const loading = vessels.isPending || commodities.isPending || ports.isPending;

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
    const parsed = CreateVoyageRequestSchema.safeParse(toRequest(values));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      setClientErrors(toFieldErrors(issues, values).fields);
      return;
    }
    setClientErrors({});
    create(parsed.data satisfies CreateVoyageRequest);
  };

  if (lookupError) {
    return (
      <QueryErrorAlert
        title="Vessels, commodities and ports could not be loaded"
        error={lookupError}
        onRetry={() => {
          void vessels.refetch();
          void commodities.refetch();
          void ports.refetch();
        }}
      />
    );
  }

  return (
    <Card>
      <CardContent>
        <Stack
          component="form"
          noValidate
          aria-label="New voyage"
          onSubmit={onSubmit}
          spacing={3}
          sx={{ maxWidth: 720 }}
        >
          <Typography color="text.secondary">
            {identity.organization.name} will be the exporter on this voyage. It starts as planned,
            and its reference is assigned when it is created.
          </Typography>

          {formError && <Alert severity="error">{formError}</Alert>}

          <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <SelectField
              name="vesselId"
              label="Vessel"
              error={fieldErrors.vesselId}
              disabled={loading}
            >
              {vessels.data?.items.map((vessel) => (
                <option key={vessel.id} value={vessel.id}>
                  {vessel.name} (IMO {vessel.imoNumber})
                </option>
              ))}
            </SelectField>
            <SelectField
              name="commodityId"
              label="Commodity"
              error={fieldErrors.commodityId}
              disabled={loading}
            >
              {commodities.data?.items.map((commodity) => (
                <option key={commodity.id} value={commodity.id}>
                  {commodity.name}
                </option>
              ))}
            </SelectField>
            <TextField
              name="quantity.amount"
              label="Quantity (MT)"
              required
              error={Boolean(fieldErrors['quantity.amount'])}
              helperText={fieldErrors['quantity.amount'] ?? 'Metric tonnes, up to 3 decimal places'}
              slotProps={{ htmlInput: { inputMode: 'decimal', autoComplete: 'off' } }}
            />
            <Box aria-hidden sx={{ display: { xs: 'none', sm: 'block' } }} />
            <SelectField
              name="loadPortId"
              label="Load port"
              error={fieldErrors.loadPortId}
              disabled={loading}
            >
              {ports.data?.items.map((port) => (
                <option key={port.id} value={port.id}>
                  {port.name} ({port.unLocode})
                </option>
              ))}
            </SelectField>
            <SelectField
              name="dischargePortId"
              label="Discharge port"
              error={fieldErrors.dischargePortId}
              disabled={loading}
            >
              {ports.data?.items.map((port) => (
                <option key={port.id} value={port.id}>
                  {port.name} ({port.unLocode})
                </option>
              ))}
            </SelectField>
            <TextField
              name="laycan.start"
              label="Laycan start"
              type="date"
              required
              error={Boolean(fieldErrors['laycan.start'])}
              helperText={fieldErrors['laycan.start']}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              name="laycan.end"
              label="Laycan end"
              type="date"
              required
              error={Boolean(fieldErrors['laycan.end'])}
              helperText={fieldErrors['laycan.end']}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Box>

          <Stack direction="row" spacing={2}>
            <Button
              type="submit"
              variant="contained"
              disabled={loading || isPending}
              startIcon={isPending ? <CircularProgress size={18} color="inherit" /> : null}
            >
              Create voyage
            </Button>
            <Button component={RouterLink} to="/voyages">
              Cancel
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
