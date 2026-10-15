import DirectionsBoatOutlinedIcon from '@mui/icons-material/DirectionsBoatOutlined';
import { AppBar, Box, Button, Container, Toolbar, Typography } from '@mui/material';
import { NavLink, Outlet } from 'react-router';
import { UserMenu } from '../../features/auth/components/UserMenu';

export function AppLayout() {
  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="sticky" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar sx={{ gap: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'primary.main' }}>
            <DirectionsBoatOutlinedIcon aria-hidden />
            <Typography component="span" variant="h6" sx={{ fontWeight: 700 }}>
              TradeFlow
            </Typography>
          </Box>
          <Box component="nav" aria-label="Main">
            <Button
              component={NavLink}
              to="/voyages"
              sx={{ '&.active': { bgcolor: 'action.selected' } }}
            >
              Voyages
            </Button>
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
