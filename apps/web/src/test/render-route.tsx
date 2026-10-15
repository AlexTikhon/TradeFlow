import type { CurrentUser } from '@tradeflow/contracts';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, type InitialEntry, RouterProvider } from 'react-router';
import { AppProviders } from '../app/AppProviders';
import { createQueryClient } from '../app/query-client';
import { routes } from '../app/routes';
import { aCurrentUser } from './fixtures/auth';
import { type FakeSession, serveSession } from './msw-server';

interface RenderRouteOptions {
  /** Who is signed in when the app starts; `null` for nobody. Defaults to `aCurrentUser()`. */
  signedInAs?: CurrentUser | null;
  /** Accounts that can sign in through the fake API. Defaults to the signed-in user. */
  accounts?: CurrentUser[];
}

/**
 * Renders the real route tree at `path` with the real providers and query client. Only the
 * network is faked (MSW), so tests exercise routing, authentication, data fetching, contract
 * validation and rendering together.
 */
export function renderRoute(path: InitialEntry, options: RenderRouteOptions = {}) {
  const signedInAs = options.signedInAs === undefined ? aCurrentUser() : options.signedInAs;
  const session: FakeSession = serveSession(signedInAs, options.accounts);
  const queryClient = createQueryClient({ retry: false });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup();

  render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );

  return { router, user, queryClient, session };
}
