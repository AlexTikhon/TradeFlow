import { Alert, AlertTitle, Box } from '@mui/material';

/** Last-resort boundary for errors thrown while rendering a route. */
export function RouteErrorPage() {
  return (
    <Box sx={{ p: 4 }}>
      <Alert severity="error">
        <AlertTitle>Something went wrong</AlertTitle>
        An unexpected error occurred while displaying this page. Reload to try again.
      </Alert>
    </Box>
  );
}
