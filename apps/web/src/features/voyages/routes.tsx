import type { RouteObject } from 'react-router';
import { VoyageDetailsPage } from './pages/VoyageDetailsPage';
import { VoyageListPage } from './pages/VoyageListPage';

/** The feature owns its routes; the app shell only composes them. */
export const voyageRoutes: RouteObject[] = [
  { path: 'voyages', element: <VoyageListPage /> },
  { path: 'voyages/:voyageId', element: <VoyageDetailsPage /> },
];
