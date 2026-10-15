import { type CurrentUser, CurrentUserSchema, type SignInRequest } from '@tradeflow/contracts';
import { getJson, isUnauthenticated, postEmpty, postJson } from '../../../shared/api/http-client';

/** The signed-in identity, or null when there is no valid session (401 is an answer, not an error). */
export async function fetchCurrentUser(signal?: AbortSignal): Promise<CurrentUser | null> {
  try {
    return await getJson('/auth/me', CurrentUserSchema, { ...(signal && { signal }) });
  } catch (error) {
    if (isUnauthenticated(error)) return null;
    throw error;
  }
}

export function signIn(credentials: SignInRequest): Promise<CurrentUser> {
  return postJson('/auth/sign-in', credentials, CurrentUserSchema);
}

export function signOut(): Promise<void> {
  return postEmpty('/auth/sign-out');
}
