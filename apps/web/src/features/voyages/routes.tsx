import type { RouteObject } from 'react-router';
import { NewVoyagePage } from './pages/NewVoyagePage';
import { VoyageDetailsPage } from './pages/VoyageDetailsPage';
import { VoyageListPage } from './pages/VoyageListPage';

/** The feature owns its routes; the app shell only composes them. */
export const voyageRoutes: RouteObject[] = [
  { path: 'voyages', element: <VoyageListPage /> },
  // A static segment outranks `:voyageId`, so "new" is never taken for an id.
  { path: 'voyages/new', element: <NewVoyagePage /> },
  { path: 'voyages/:voyageId', element: <VoyageDetailsPage /> },
];
