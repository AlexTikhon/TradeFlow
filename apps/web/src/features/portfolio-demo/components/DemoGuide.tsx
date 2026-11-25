import CloseIcon from '@mui/icons-material/Close';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { useIdentity } from '../../../shared/auth/identity';
import { type DemoAccount, demoAccountOf } from '../demo-accounts';
import { GUIDE_AFTER_SIGN_IN, showcasePath, showcaseQuery, wantsGuide } from '../portfolio-demo';

/** What the signed-in account may do on the showcase, in the API's terms, in one paragraph. */
function partOf(account: DemoAccount | undefined): string {
  switch (account?.part) {
    case 'seller':
      return 'You are Ana, the seller (Cerrado Grãos). On the showcase voyage you can upload the commercial invoice and replace the rejected weight certificate; your Action Center asks for the replacement.';
    case 'buyer':
      return 'You are Wei Ling, the buyer (Meridian Agri Trading). On the showcase voyage you can approve or reject the certificate of origin; your Action Center asks for that review.';
    case 'viewer':
      return 'You are Rafael, a viewer at the seller (Cerrado Grãos). You can read every record of the showcase voyage and download its files, but you cannot upload, review or acknowledge anything.';
    case 'outsider':
      return 'You are Lucía, from Pampa Litoral, which takes no part in the showcase voyage. Opening it shows “Voyage not found”: that is intended, because only a voyage’s participants can see it.';
    case undefined:
      return 'This account has no prepared part in the showcase. To follow it, sign out and choose one of the demo accounts.';
  }
}

const DOCUMENT_STATES = [
  ['Commercial invoice', 'not uploaded yet.'],
  ['Certificate of origin', 'version 1 is waiting for the buyer’s review.'],
  ['Weight certificate', 'version 1 was rejected; the seller must replace it.'],
  ['Bill of lading', 'version 2 is approved; rejected version 1 is kept under Earlier versions.'],
] as const;

interface DemoGuideDialogProps {
  open: boolean;
  onClose: () => void;
}

/** The short guide: where the showcase is, what this account may do there, and what to know. */
function DemoGuideDialog({ open, onClose }: DemoGuideDialogProps) {
  const { user } = useIdentity();
  const account = demoAccountOf(user.email);
  const showcase = useQuery({ ...showcaseQuery, enabled: open });
  const titleId = useId();

  return (
    <Dialog open={open} onClose={onClose} aria-labelledby={titleId} fullWidth maxWidth="sm">
      <DialogTitle id={titleId} sx={{ pr: 7 }}>
        Demo guide
      </DialogTitle>
      <IconButton
        aria-label="Close the demo guide"
        onClick={onClose}
        sx={{ position: 'absolute', right: 8, top: 8 }}
      >
        <CloseIcon />
      </IconButton>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Typography variant="body1">{partOf(account)}</Typography>

          <Box component="nav" aria-label="Guide links">
            {showcase.data === undefined ? (
              <Typography role="status" variant="body2" color="text.secondary">
                Finding the showcase voyage…
              </Typography>
            ) : (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                {showcase.data && (
                  <Button
                    variant="contained"
                    component={RouterLink}
                    to={showcasePath(showcase.data)}
                    onClick={onClose}
                  >
                    Open showcase voyage {showcase.data.reference}
                  </Button>
                )}
                <Button variant="outlined" component={RouterLink} to="/actions" onClick={onClose}>
                  Open Action Center
                </Button>
              </Stack>
            )}
            {showcase.data === null && (
              <Alert severity="info" sx={{ mt: 1.5 }}>
                The showcase voyage is not available in this run.
              </Alert>
            )}
          </Box>

          <Box component="section" aria-labelledby={`${titleId}-documents`}>
            <Typography id={`${titleId}-documents`} variant="h2" component="h3" sx={{ mb: 0.5 }}>
              The showcase documents
            </Typography>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              The buyer’s instructions (revision 1) require four documents:
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {DOCUMENT_STATES.map(([document, state]) => (
                <Typography component="li" variant="body2" key={document}>
                  <strong>{document}</strong>: {state}
                </Typography>
              ))}
            </Box>
          </Box>

          <Box component="section" aria-labelledby={`${titleId}-notes`}>
            <Typography id={`${titleId}-notes`} variant="h2" component="h3" sx={{ mb: 0.5 }}>
              Good to know
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              <Typography component="li" variant="body2">
                To be seller and buyer at the same time, use two browser profiles, or a normal and a
                private window: tabs of one browser share one sign-in.
              </Typography>
              <Typography component="li" variant="body2">
                This is a local demo: whatever you change disappears when the demo stops.
              </Typography>
            </Box>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The portfolio demo's bar under the app bar: it says the data is fictional and reopens the
 * guide, which opens by itself once after a sign-in sent from the sign-in page.
 */
export function DemoGuide() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(() => wantsGuide(location.state));

  // Opened once: the request leaves the history entry, so Back or a reload does not reopen it.
  useEffect(() => {
    if (!wantsGuide(location.state)) return;
    const { [GUIDE_AFTER_SIGN_IN]: _opened, ...rest } = location.state as Record<string, unknown>;
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: Object.keys(rest).length > 0 ? rest : null },
    );
  }, [location, navigate]);

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: { xs: 2, sm: 3 },
          py: 0.25,
          bgcolor: 'action.hover',
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
          Portfolio demo · fictional data
        </Typography>
        <Button
          size="small"
          startIcon={<HelpOutlineIcon aria-hidden />}
          onClick={() => {
            setOpen(true);
          }}
          sx={{ flexShrink: 0 }}
        >
          Demo guide
        </Button>
      </Box>
      <DemoGuideDialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}
