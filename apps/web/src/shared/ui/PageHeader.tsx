import { Box, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Rendered next to the title, e.g. a status chip. */
  adornment?: ReactNode;
  /** Rendered on the right, e.g. filters. */
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, adornment, actions }: PageHeaderProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 2,
        mb: 3,
      }}
    >
      <Stack spacing={0.5}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <Typography variant="h1">{title}</Typography>
          {adornment}
        </Stack>
        {subtitle && <Typography color="text.secondary">{subtitle}</Typography>}
      </Stack>
      {actions}
    </Box>
  );
}
