import DirectionsBoatOutlinedIcon from '@mui/icons-material/DirectionsBoatOutlined';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SignInRequest, SignInRequestSchema } from '@tradeflow/contracts';
import { type SubmitEvent, useState } from 'react';
import { type Location, Navigate, useLocation } from 'react-router';
import { ApiError, isUnauthenticated } from '../../../shared/api/http-client';
import { useSignOut, useSignOutState } from '../hooks/use-sign-out';
import { sessionQuery, startSession } from '../session';
import { announceSessionChange } from '../session-sync';

const DEFAULT_TARGET = '/voyages';

/** Where to go after signing in: back to the protected page that sent us here, if any. */
function redirectTarget(state: unknown): string {
  const from = (state as { from?: Partial<Location> } | null)?.from;
  const path = from?.pathname;
  // Only same-app paths; never an absolute or protocol-relative URL.
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    return DEFAULT_TARGET;
  }
  return `${path}${from?.search ?? ''}`;
}

function describeSignInError(error: Error): string {
  if (isUnauthenticated(error)) {
    return 'Email or password is incorrect.';
  }
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  return 'Sign-in is unavailable right now. Please try again.';
}

interface FieldErrors {
  email?: string;
  password?: string;
}

export function SignInPage() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { data: identity } = useQuery(sessionQuery);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const signOut = useSignOutState();
  const retrySignOut = useSignOut();

  const mutation = useMutation({
    // Publishing the identity re-renders this page, which then redirects.
    mutationFn: (credentials: SignInRequest) => startSession(queryClient, credentials),
    onSuccess: () => {
      announceSessionChange();
    },
  });
  // The previous session's sign-out must be answered first, or its response could clear the
  // cookie of the new session. `startSession` waits for it anyway; this keeps the form honest.
  const signingOut = signOut.status === 'pending';

  if (identity) {
    return <Navigate to={redirectTarget(location.state)} replace />;
  }

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = SignInRequestSchema.safeParse({
      email: form.get('email'),
      password: form.get('password'),
    });
    if (!parsed.success) {
      const invalid = new Set(parsed.error.issues.map((issue) => issue.path[0]));
      setFieldErrors({
        ...(invalid.has('email') && { email: 'Enter a valid email address.' }),
        ...(invalid.has('password') && { password: 'Enter your password.' }),
      });
      return;
    }
    setFieldErrors({});
    mutation.mutate(parsed.data);
  };

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        bgcolor: 'background.default',
        px: 2,
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 400 }}>
        <CardContent sx={{ p: 4 }}>
          <Stack spacing={3} component="form" noValidate onSubmit={onSubmit} aria-label="Sign in">
            <Stack spacing={1} sx={{ alignItems: 'center', color: 'primary.main' }}>
              <DirectionsBoatOutlinedIcon aria-hidden fontSize="large" />
              <Typography variant="h1">Sign in to TradeFlow</Typography>
            </Stack>

            {signingOut && (
              <Alert
                severity="info"
                role="status"
                icon={<CircularProgress size={20} color="inherit" aria-hidden />}
              >
                Finishing sign-out…
              </Alert>
            )}

            {signOut.status === 'failed' && (
              <Alert
                severity="warning"
                action={
                  <Button color="inherit" size="small" onClick={() => void retrySignOut()}>
                    Retry sign-out
                  </Button>
                }
              >
                <AlertTitle>Sign-out was not confirmed</AlertTitle>
                The server did not confirm it, so your previous session may still be active. Retry
                to end it, or sign in to replace it.
              </Alert>
            )}

            {mutation.error && (
              <Alert severity="error">{describeSignInError(mutation.error)}</Alert>
            )}

            <TextField
              name="email"
              label="Email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              error={Boolean(fieldErrors.email)}
              helperText={fieldErrors.email}
            />
            <TextField
              name="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              error={Boolean(fieldErrors.password)}
              helperText={fieldErrors.password}
            />
            <Button
              type="submit"
              variant="contained"
              size="large"
              disabled={mutation.isPending || signingOut}
              startIcon={mutation.isPending ? <CircularProgress size={18} color="inherit" /> : null}
            >
              Sign in
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
