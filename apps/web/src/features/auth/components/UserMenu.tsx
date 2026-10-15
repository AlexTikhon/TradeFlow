import LogoutIcon from '@mui/icons-material/Logout';
import { Box, Button, Typography } from '@mui/material';
import { useState } from 'react';
import { useIdentity } from '../../../shared/auth/identity';
import { useSignOut } from '../hooks/use-sign-out';

/** Who is signed in, and for which organization they act. */
export function UserMenu() {
  const { user, organization } = useIdentity();
  const signOut = useSignOut();
  const [isSigningOut, setIsSigningOut] = useState(false);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Box sx={{ textAlign: 'right', display: { xs: 'none', sm: 'block' } }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {user.fullName}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {organization.name}
        </Typography>
      </Box>
      <Button
        variant="outlined"
        size="small"
        startIcon={<LogoutIcon aria-hidden />}
        disabled={isSigningOut}
        onClick={() => {
          setIsSigningOut(true);
          void signOut();
        }}
      >
        Sign out
      </Button>
    </Box>
  );
}
