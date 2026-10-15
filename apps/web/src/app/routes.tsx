import { Navigate, type RouteObject } from 'react-router';
import { voyageRoutes } from '../features/voyages/routes';
import { AppLayout } from './layout/AppLayout';
import { NotFoundPage } from './NotFoundPage';
import { RouteErrorPage } from './RouteErrorPage';

/** The route tree, shared by the browser router and by tests (memory router). */
export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/voyages" replace /> },
      ...voyageRoutes,
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
