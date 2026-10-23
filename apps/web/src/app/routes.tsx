import { Navigate, type RouteObject } from 'react-router';
import { actionCenterRoutes } from '../features/action-center/routes';
import { RequireAuth } from '../features/auth/components/RequireAuth';
import { authRoutes } from '../features/auth/routes';
import { voyageRoutes } from '../features/voyages/routes';
import { AppLayout } from './layout/AppLayout';
import { NotFoundPage } from './NotFoundPage';
import { RouteErrorPage } from './RouteErrorPage';

/** The route tree, shared by the browser router and by tests (memory router). */
export const routes: RouteObject[] = [
  {
    errorElement: <RouteErrorPage />,
    children: [
      ...authRoutes,
      {
        // Everything else requires a session. New feature routes go here.
        element: (
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <Navigate to="/voyages" replace /> },
          ...voyageRoutes,
          ...actionCenterRoutes,
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
