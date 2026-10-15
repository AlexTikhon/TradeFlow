import { Alert, AlertTitle, Button } from '@mui/material';
import { ApiError } from '../api/http-client';

interface QueryErrorAlertProps {
  title: string;
  error: Error;
  onRetry: () => void;
}

function describe(error: Error): string {
  if (error instanceof ApiError && error.status < 500) {
    return error.message;
  }
  // Server and network failures: never surface internals, and suggest the useful action.
  return 'The server could not be reached or failed to respond. Please try again.';
}

export function QueryErrorAlert({ title, error, onRetry }: QueryErrorAlertProps) {
  return (
    <Alert
      severity="error"
      action={
        <Button color="inherit" size="small" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      <AlertTitle>{title}</AlertTitle>
      {describe(error)}
    </Alert>
  );
}
