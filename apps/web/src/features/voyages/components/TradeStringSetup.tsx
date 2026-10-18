import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
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
import { useQuery } from '@tanstack/react-query';
import {
  type ConfigureTradeStringRequest,
  ConfigureTradeStringRequestSchema,
  ORGANIZATION_SEARCH_MIN_LENGTH,
  type OrganizationRef,
  type ProblemFieldError,
  type TradeString,
  type VoyageDetail,
} from '@tradeflow/contracts';
import { type SubmitEvent, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../shared/api/http-client';
import { useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import { formatCountry } from '../../../shared/lib/format';
import { organizationQueries } from '../api/organizations.api';
import { participantRoleLabel } from '../domain/participant-role';
import {
  MAX_DOWNSTREAM_PARTIES,
  plannedChain,
  SETUP_UNAVAILABLE,
  tradeStringSetupAvailability,
} from '../domain/trade-string-setup';
import { isSetupConflict, useConfigureTradeString } from '../hooks/use-trade-string-setup';

/** How long typing must pause before the search is sent. */
const SEARCH_DELAY_MS = 300;

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return debounced;
}

const listOfNames = (organizations: readonly OrganizationRef[]) => {
  const names = organizations.map(({ name }) => name);
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
};

/**
 * Field errors by chain position: `body.parties.N…` is position N (0 is the exporter). What
 * names no position is about the chain as a whole.
 */
function toRowErrors(errors: readonly ProblemFieldError[]) {
  const rows = new Map<number, string>();
  const other: string[] = [];
  for (const { path, message } of errors) {
    const match = /^body\.parties\.(\d+)(\.|$)/.exec(path);
    if (match && !rows.has(Number(match[1]))) {
      rows.set(Number(match[1]), message);
    } else if (!match) {
      other.push(message);
    }
  }
  return { rows, other };
}

function describeFailure(error: Error): string {
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'The trade string could not be set up. Please try again.';
}

interface SearchProps {
  chosen: readonly OrganizationRef[];
  full: boolean;
  onAdd: (organization: OrganizationRef) => void;
}

/** Finds organizations by part of their name, to add to the chain. */
function OrganizationSearch({ chosen, full, onAdd }: SearchProps) {
  const identity = useIdentity();
  const scope = useProtectedScope();
  const [text, setText] = useState('');
  const search = useDebounced(text.trim(), SEARCH_DELAY_MS);
  const searchable = search.length >= ORGANIZATION_SEARCH_MIN_LENGTH;
  const results = useQuery({ ...organizationQueries.search(scope, search), enabled: searchable });
  const chosenIds = new Set(chosen.map(({ id }) => id));
  const found = (results.data?.items ?? []).filter(({ id }) => id !== identity.organization.id);

  return (
    <Stack spacing={1.5}>
      <TextField
        label="Find an organization"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        helperText={
          full
            ? `A trade string names at most ${MAX_DOWNSTREAM_PARTIES + 1} organizations, yours included.`
            : `Type at least ${ORGANIZATION_SEARCH_MIN_LENGTH} characters of its name.`
        }
        slotProps={{ htmlInput: { autoComplete: 'off' } }}
      />
      {searchable && results.isPending && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }} aria-busy>
          <CircularProgress size={16} />
          <Typography variant="body2">Searching…</Typography>
        </Stack>
      )}
      {searchable && results.error && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void results.refetch()}>
              Retry
            </Button>
          }
        >
          {results.error instanceof ApiError && results.error.status < 500
            ? results.error.message
            : 'The search failed. Please try again.'}
        </Alert>
      )}
      {searchable && results.data && found.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          No organization matches “{search}”.
        </Typography>
      )}
      {searchable && found.length > 0 && (
        <Box
          component="ul"
          role="list"
          aria-label="Organizations found"
          sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1 }}
        >
          {found.map((organization) => {
            const added = chosenIds.has(organization.id);
            return (
              <Box
                component="li"
                key={organization.id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  justifyContent: 'space-between',
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ overflowWrap: 'anywhere' }}>{organization.name}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {formatCountry(organization.countryCode)}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  disabled={added || full}
                  aria-label={added ? `${organization.name} added` : `Add ${organization.name}`}
                  onClick={() => {
                    onAdd(organization);
                  }}
                >
                  {added ? 'Added' : 'Add'}
                </Button>
              </Box>
            );
          })}
        </Box>
      )}
    </Stack>
  );
}

type Move = 'up' | 'down';

interface SetupFormProps {
  setup: ReturnType<typeof useConfigureTradeString>;
  onConfigured: (tradeString: TradeString, named: OrganizationRef[]) => void;
  onCancel: () => void;
}

/**
 * The exporter's form: its own organization fixed first, then the organizations it sells
 * through, found by search, in order. A review step shows the roles and contracts that follow
 * from the order, and what setting it up means, before anything is sent.
 */
function TradeStringSetupForm({ setup, onConfigured, onCancel }: SetupFormProps) {
  const identity = useIdentity();
  const exporter: OrganizationRef = identity.organization;
  const [downstream, setDownstream] = useState<OrganizationRef[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  /** The row just moved and the way it went, until the move has rendered. */
  const focusAfterMove = useRef<{ id: string; move: Move } | null>(null);
  const form = useRef<HTMLFormElement>(null);

  const { parties, sales } = plannedChain(exporter, downstream);
  const badRequest = setup.error instanceof ApiError && setup.error.status === 400;
  const serverErrors = badRequest
    ? toRowErrors((setup.error as ApiError).problem?.errors ?? [])
    : undefined;
  const otherFailure =
    setup.error && !badRequest && !isSetupConflict(setup.error)
      ? describeFailure(setup.error)
      : undefined;
  // A refused chain goes back to editing, where each refusal shows on its organization.
  const step = reviewing && !badRequest ? 'review' : 'edit';
  const full = downstream.length >= MAX_DOWNSTREAM_PARTIES;

  // Keeps focus on the control that moved a row, wherever the row went (or on the other move
  // button, when the row reached an end and its own is now disabled).
  useEffect(() => {
    const moved = focusAfterMove.current;
    if (!moved) return;
    focusAfterMove.current = null;
    const button = (direction: Move) =>
      form.current?.querySelector<HTMLButtonElement>(`[data-move="${moved.id}:${direction}"]`);
    const same = button(moved.move);
    (same && !same.disabled ? same : button(moved.move === 'up' ? 'down' : 'up'))?.focus();
  });

  const change = (next: OrganizationRef[], message: string) => {
    setDownstream(next);
    setAnnouncement(message);
    setClientError(null);
    // Server refusals name positions; after a change they may name the wrong ones.
    setup.reset();
  };
  const roleAfter = (next: OrganizationRef[], id: string) => {
    const index = next.findIndex((organization) => organization.id === id);
    return participantRoleLabel(index === next.length - 1 ? 'FINAL_BUYER' : 'TRADER').toLowerCase();
  };
  const add = (organization: OrganizationRef) => {
    if (full || downstream.some(({ id }) => id === organization.id)) return;
    const next = [...downstream, organization];
    change(
      next,
      `${organization.name} added at position ${next.length + 1}, as ${roleAfter(next, organization.id)}.`,
    );
  };
  const remove = (organization: OrganizationRef) => {
    change(
      downstream.filter(({ id }) => id !== organization.id),
      `${organization.name} removed.`,
    );
  };
  const move = (index: number, direction: Move) => {
    const target = direction === 'up' ? index - 1 : index + 1;
    const moved = downstream[index];
    const other = downstream[target];
    if (!moved || !other) return;
    const next = downstream.map((organization, i) =>
      i === index ? other : i === target ? moved : organization,
    );
    change(
      next,
      `${moved.name} moved to position ${target + 2} of ${next.length + 1}, as ${roleAfter(next, moved.id)}.`,
    );
    focusAfterMove.current = { id: moved.id, move: direction };
  };

  const request = (): ConfigureTradeStringRequest | null => {
    const parsed = ConfigureTradeStringRequestSchema.safeParse({
      parties: [exporter, ...downstream].map(({ id }) => ({ organizationId: id })),
    });
    return parsed.success ? parsed.data : null;
  };

  const toReview = () => {
    if (downstream.length === 0) {
      setClientError('Add at least one organization: the buyer your organization sells to.');
      return;
    }
    if (!request()) {
      setClientError('Each organization can appear only once, and at most ten in all.');
      return;
    }
    setup.reset();
    setReviewing(true);
  };

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step === 'edit') {
      toReview();
      return;
    }
    const body = request();
    if (!body || setup.isPending) return;
    setup.configure(body, (tradeString) => {
      onConfigured(tradeString, downstream);
    });
  };

  const rowError = (position: number) => serverErrors?.rows.get(position);
  const errorId = (position: number) => `trade-string-setup-error-${position}`;

  return (
    <Stack
      component="form"
      ref={form}
      noValidate
      aria-label="Set up the trade string"
      onSubmit={onSubmit}
      spacing={2.5}
      sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}
    >
      <Box role="status" sx={visuallyHidden}>
        {announcement}
      </Box>

      {step === 'edit' ? (
        <>
          <Typography variant="body2" color="text.secondary">
            Name the organizations the cargo is sold through, in order. Your organization sells
            first; the last one named is the final buyer, and every one between is a trader.
          </Typography>

          {(clientError ?? serverErrors) && (
            <Alert severity="error">
              {clientError ??
                (serverErrors?.other.join(' ') ||
                  'Some organizations could not be accepted. Change them, then review again.')}
            </Alert>
          )}
          {otherFailure && <Alert severity="error">{otherFailure}</Alert>}

          <Box
            component="ol"
            role="list"
            aria-label="Organizations in the trade string, in order"
            sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1 }}
          >
            {parties.map(({ organization, role }, position) => {
              const index = position - 1;
              const error = rowError(position);
              return (
                <Box
                  component="li"
                  key={organization.id}
                  aria-label={`${position + 1}. ${organization.name}, ${participantRoleLabel(role)}`}
                  aria-describedby={error ? errorId(position) : undefined}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    p: 1.5,
                    border: 1,
                    borderColor: error ? 'error.main' : 'divider',
                    borderRadius: 1,
                  }}
                >
                  <Typography sx={{ fontWeight: 600, minWidth: '1.5em' }}>
                    {position + 1}.
                  </Typography>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="overline"
                      component="p"
                      color="text.secondary"
                      sx={{ lineHeight: 1.6 }}
                    >
                      {participantRoleLabel(role)}
                    </Typography>
                    <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                      {organization.name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {formatCountry(organization.countryCode)}
                      {position === 0 && ' · Your organization, always first'}
                    </Typography>
                    {error && (
                      <Typography id={errorId(position)} variant="body2" color="error">
                        {error}
                      </Typography>
                    )}
                  </Box>
                  {position > 0 && (
                    <Stack direction="row" spacing={0.5}>
                      <IconButton
                        aria-label={`Move ${organization.name} up`}
                        data-move={`${organization.id}:up`}
                        disabled={index === 0}
                        onClick={() => {
                          move(index, 'up');
                        }}
                      >
                        <ArrowUpwardIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        aria-label={`Move ${organization.name} down`}
                        data-move={`${organization.id}:down`}
                        disabled={index === downstream.length - 1}
                        onClick={() => {
                          move(index, 'down');
                        }}
                      >
                        <ArrowDownwardIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        aria-label={`Remove ${organization.name}`}
                        onClick={() => {
                          remove(organization);
                        }}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  )}
                </Box>
              );
            })}
          </Box>

          <OrganizationSearch chosen={downstream} full={full} onAdd={add} />

          <Stack direction="row" spacing={1}>
            <Button type="submit" variant="contained">
              Review the trade string
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </Stack>
        </>
      ) : (
        <>
          <Box role="region" aria-label="Review the trade string">
            <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
              The trade string, as it will be recorded
            </Typography>
            <Box component="ol" role="list" sx={{ m: 0, pl: 3 }}>
              {parties.map(({ organization, role }) => (
                <li key={organization.id}>
                  <Typography>
                    {organization.name} ({formatCountry(organization.countryCode)}) —{' '}
                    {participantRoleLabel(role)}
                  </Typography>
                </li>
              ))}
            </Box>
            <Box component="ul" role="list" aria-label="Contracts" sx={{ m: 0, mt: 1, pl: 3 }}>
              {sales.map(({ position, seller, buyer }) => (
                <li key={position}>
                  <Typography variant="body2">
                    Contract {position}: {seller.name} sells to {buyer.name}
                  </Typography>
                </li>
              ))}
            </Box>
          </Box>

          <Alert severity="info">
            <AlertTitle>What setting it up does</AlertTitle>
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              <li>
                {listOfNames(downstream)} {downstream.length === 1 ? 'takes part' : 'take part'} in
                this voyage at once: {downstream.length === 1 ? 'it sees' : 'each sees'} the voyage,
                the whole trade string and every participant, and can act under{' '}
                {downstream.length === 1 ? 'its' : 'their'} own contracts.
              </li>
              <li>
                It records who your organization says the cargo is sold through. It does not record
                that any of them agreed to it.
              </li>
              <li>Once set up, the trade string cannot be changed or undone here.</li>
            </Box>
          </Alert>

          {otherFailure && <Alert severity="error">{otherFailure}</Alert>}

          <Stack direction="row" spacing={1}>
            <Button
              type="submit"
              variant="contained"
              disabled={setup.isPending}
              startIcon={setup.isPending ? <CircularProgress size={16} /> : undefined}
            >
              {setup.isPending ? 'Setting up…' : 'Set up trade string'}
            </Button>
            <Button
              disabled={setup.isPending}
              onClick={() => {
                setReviewing(false);
              }}
            >
              Back to editing
            </Button>
          </Stack>
        </>
      )}
    </Stack>
  );
}

/** Read by screen readers, not shown. */
const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

interface TradeStringSetupProps {
  voyage: VoyageDetail;
  tradeString: TradeString;
}

/**
 * What the trade-string card offers the exporter while the string is empty: the setup, or why
 * there is none; and what became of a setup once it was sent. A 409 is never answered by sending
 * again: the page is refreshed, and shows either the string recorded meanwhile or why the voyage
 * cannot be set up.
 */
export function TradeStringSetup({ voyage, tradeString }: TradeStringSetupProps) {
  const identity = useIdentity();
  const setup = useConfigureTradeString(voyage.id);
  const [open, setOpen] = useState(false);
  const [named, setNamed] = useState<OrganizationRef[] | null>(null);
  const availability = tradeStringSetupAvailability(identity, voyage, tradeString);
  const configured = tradeString.edges.length > 0;

  if (setup.isSuccess && named) {
    return (
      <Alert severity="success">
        <AlertTitle>Trade string set up</AlertTitle>
        {listOfNames(named)} {named.length === 1 ? 'now takes' : 'now take'} part in this voyage.
      </Alert>
    );
  }

  if (isSetupConflict(setup.error)) {
    return configured ? (
      <Alert severity="info">
        <AlertTitle>Already set up</AlertTitle>
        The trade string had already been set up when yours arrived; it is shown above as recorded.
        Yours was not recorded, and nothing was sent again.
      </Alert>
    ) : (
      <Alert severity="warning">
        <AlertTitle>Not set up</AlertTitle>
        {setup.error?.message}
        {availability.kind === 'unavailable' && ` ${SETUP_UNAVAILABLE[availability.reason]}`}
      </Alert>
    );
  }

  if (open && availability.kind !== 'available') {
    return (
      <Alert
        severity="warning"
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => {
              setOpen(false);
            }}
          >
            Close
          </Button>
        }
      >
        <AlertTitle>The trade string can no longer be set up here</AlertTitle>
        {availability.kind === 'unavailable'
          ? SETUP_UNAVAILABLE[availability.reason]
          : 'It has been set up meanwhile, as shown above.'}
      </Alert>
    );
  }

  if (availability.kind === 'unavailable') {
    return (
      <Typography variant="body2" color="text.secondary">
        {SETUP_UNAVAILABLE[availability.reason]}
      </Typography>
    );
  }

  if (availability.kind === 'hidden') {
    return null;
  }

  return open ? (
    <TradeStringSetupForm
      setup={setup}
      onConfigured={(_tradeString, organizations) => {
        setNamed(organizations);
        setOpen(false);
      }}
      onCancel={() => {
        setup.reset();
        setOpen(false);
      }}
    />
  ) : (
    <Box>
      <Button
        variant="outlined"
        onClick={() => {
          setOpen(true);
        }}
      >
        Set up trade string
      </Button>
    </Box>
  );
}
