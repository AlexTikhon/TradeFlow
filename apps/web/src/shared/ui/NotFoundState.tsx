import { Button, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';

interface NotFoundStateProps {
  title: string;
  message: ReactNode;
  backTo?: { path: string; label: string };
}

export function NotFoundState({
  title,
  message,
  backTo = { path: '/voyages', label: 'Back to voyages' },
}: NotFoundStateProps) {
  return (
    <Stack spacing={2} sx={{ alignItems: 'flex-start', py: 6 }}>
      <Typography variant="h1">{title}</Typography>
      <Typography color="text.secondary">{message}</Typography>
      <Button component={RouterLink} to={backTo.path} variant="outlined">
        {backTo.label}
      </Button>
    </Stack>
  );
}
