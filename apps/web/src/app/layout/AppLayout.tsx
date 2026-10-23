import DirectionsBoatOutlinedIcon from '@mui/icons-material/DirectionsBoatOutlined';
import { AppBar, Box, Button, Container, Toolbar, Typography } from '@mui/material';
import { NavLink, Outlet } from 'react-router';
import { UserMenu } from '../../features/auth/components/UserMenu';

const NAV_ITEMS = [
  { to: '/voyages', label: 'Voyages' },
  { to: '/actions', label: 'Action Center' },
] as const;

export function AppLayout() {
  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="sticky" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar sx={{ gap: { xs: 1, sm: 3 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'primary.main' }}>
            <DirectionsBoatOutlinedIcon aria-hidden />
            <Typography
              component="span"
              variant="h6"
              // On phones the icon alone leaves room for the navigation.
              sx={{ fontWeight: 700, display: { xs: 'none', sm: 'inline' } }}
            >
              TradeFlow
            </Typography>
          </Box>
          <Box component="nav" aria-label="Main" sx={{ display: 'flex', gap: 0.5 }}>
            {NAV_ITEMS.map(({ to, label }) => (
              <Button
                key={to}
                component={NavLink}
                to={to}
                sx={{ whiteSpace: 'nowrap', '&.active': { bgcolor: 'action.selected' } }}
              >
                {label}
              </Button>
            ))}
          </Box>
          <Box sx={{ ml: 'auto' }}>
            <UserMenu />
          </Box>
        </Toolbar>
      </AppBar>
      <Container component="main" maxWidth="xl" sx={{ py: 4 }}>
        <Outlet />
      </Container>
    </Box>
  );
}
