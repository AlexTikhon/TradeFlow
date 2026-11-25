import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { useId } from 'react';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, type DemoAccount } from '../demo-accounts';

interface DemoAccountPickerProps {
  /** What the form holds now: an account whose details it holds is shown as chosen. */
  email: string;
  password: string;
  /** Fills the form with the account; it never signs in by itself. */
  onChoose: (account: DemoAccount) => void;
}

/** What TradeFlow is, and the fictional accounts of the portfolio demo, on the sign-in page. */
export function DemoAccountPicker({ email, password, onChoose }: DemoAccountPickerProps) {
  const headingId = useId();
  const chosen =
    password === DEMO_PASSWORD
      ? DEMO_ACCOUNTS.find((account) => account.email === email.trim().toLowerCase())
      : undefined;

  return (
    <Stack spacing={2}>
      <Typography variant="body1" sx={{ textAlign: 'center' }}>
        TradeFlow gives every company on a bulk commodity shipment one shared record of its
        execution. Each contract’s documentary instructions and documents stay confidential to its
        seller and buyer.
      </Typography>

      <Box component="section" aria-labelledby={headingId}>
        <Typography id={headingId} variant="h2" component="h2" sx={{ mb: 1 }}>
          Demo accounts
        </Typography>
        <Alert severity="info" sx={{ mb: 1.5 }}>
          Fictional people and companies. Every account uses the published demo password{' '}
          <Box component="strong" sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
            {DEMO_PASSWORD}
          </Box>
          .
        </Alert>
        <Box
          component="ul"
          aria-label="Demo accounts"
          sx={{
            listStyle: 'none',
            m: 0,
            p: 0,
            display: 'grid',
            gap: 1,
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          }}
        >
          {DEMO_ACCOUNTS.map((account) => (
            <li key={account.email}>
              <Button
                variant="outlined"
                fullWidth
                aria-pressed={chosen === account}
                onClick={() => {
                  onChoose(account);
                }}
                sx={{
                  height: '100%',
                  display: 'block',
                  textAlign: 'left',
                  textTransform: 'none',
                  color: 'text.primary',
                  py: 1,
                  '&[aria-pressed="true"]': {
                    bgcolor: 'action.selected',
                    borderColor: 'primary.main',
                  },
                }}
              >
                <Typography
                  component="span"
                  variant="caption"
                  sx={{ display: 'block', color: 'primary.main', fontWeight: 600 }}
                >
                  {account.label} · {account.organization}
                </Typography>
                <Typography
                  component="span"
                  variant="body2"
                  sx={{ display: 'block', fontWeight: 600 }}
                >
                  {account.fullName}
                </Typography>
                <Typography
                  component="span"
                  variant="body2"
                  sx={{ display: 'block', color: 'text.secondary' }}
                >
                  {account.summary}
                </Typography>
              </Button>
            </li>
          ))}
        </Box>
        <Typography
          role="status"
          variant="body2"
          sx={{ mt: 1, color: 'text.secondary', minHeight: '1.5em' }}
        >
          {chosen
            ? `${chosen.fullName}’s email and the demo password are filled in. Select Sign in to continue.`
            : 'Choosing an account fills in the form below; nothing is sent until you select Sign in.'}
        </Typography>
      </Box>
    </Stack>
  );
}
