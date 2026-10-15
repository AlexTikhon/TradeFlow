import type { RouteObject } from 'react-router';
import { SignInPage } from './pages/SignInPage';

/** Public routes of the auth feature. Protected routes are wrapped in `RequireAuth` by the shell. */
export const authRoutes: RouteObject[] = [{ path: 'sign-in', element: <SignInPage /> }];
