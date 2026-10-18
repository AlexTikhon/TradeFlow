import { Box, CircularProgress } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { IdentityContext, identityKey } from '../../../shared/auth/identity';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import { useSignedOutHere } from '../hooks/use-sign-out';
import { sessionQuery } from '../session';

/**
 * Boundary around every protected route. Children render only once the server has confirmed a
 * session, inside an identity context keyed by that identity: when the identity changes, the
 * whole protected subtree is discarded and rebuilt, so no component state carries over.
 *
 * With nobody signed in it is the only thing that sends the user to sign in, keeping the page to
 * come back to afterwards, unless this tab's own sign-out ended the session: then the next sign-in
 * starts afresh, on the default page.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { data: identity, error, refetch } = useQuery(sessionQuery);
  const signedOutHere = useSignedOutHere();

  if (identity) {
    return (
      <IdentityContext key={identityKey(identity)} value={identity}>
        {children}
      </IdentityContext>
    );
  }
  if (identity === null) {
    return <Navigate to="/sign-in" replace state={signedOutHere ? null : { from: location }} />;
  }
  if (error) {
    return (
      <Box sx={{ p: 4 }}>
        <QueryErrorAlert
          title="Your session could not be checked"
          error={error}
          onRetry={() => void refetch()}
        />
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <CircularProgress aria-label="Checking your session" />
    </Box>
  );
}
