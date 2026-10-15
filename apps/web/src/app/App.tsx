import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { startSessionSync } from '../features/auth/session-sync';
import { AppProviders } from './AppProviders';
import { createQueryClient } from './query-client';
import { routes } from './routes';

const queryClient = createQueryClient();
const router = createBrowserRouter(routes);

export function App() {
  useEffect(() => startSessionSync(queryClient), []);

  return (
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
