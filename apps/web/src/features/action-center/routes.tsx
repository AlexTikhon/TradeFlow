import type { RouteObject } from 'react-router';
import { ActionCenterPage } from './pages/ActionCenterPage';

/** The feature owns its routes; the app shell only composes them. */
export const actionCenterRoutes: RouteObject[] = [
  { path: 'actions', element: <ActionCenterPage /> },
];
