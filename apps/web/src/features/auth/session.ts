import { type Query, type QueryClient, queryOptions } from '@tanstack/react-query';

import type { CurrentUser, SignInRequest } from '@tradeflow/contracts';
import { identityKey, PROTECTED_QUERY_ROOT, sameIdentity } from '../../shared/auth/identity';
import { fetchCurrentUser, signIn, signOut } from './api/auth.api';

/*
 * The session is server state like any other (ADR 0003): the server decides who is signed in,
 * and `GET /api/auth/me` is how the client asks. `null` means signed out.
 *
 * Who is signed in changes through explicit transitions (sign-in, sign-out, a 401, another tab)
 * and through session checks. Transitions are ordered by a generation counter kept per query
 * client: each one starts a new generation, and a check's answer counts only if no transition
 * started while it was on its way. Requests that change the session cookie (sign-in, sign-out)
 * run one at a time, so a slow sign-out response cannot clear the cookie of a newer sign-in.
 */

const SESSION_KEY = ['session'] as const;

export type SignOutState =
  { status: 'idle' } | { status: 'pending' } | { status: 'failed'; error: unknown };

const IDLE: SignOutState = { status: 'idle' };

/** A sign-out in progress: local cleanup first, then the server. */
export interface SignOut {
  /** This identity's requests are aborted, its data dropped, and nobody is signed in locally. */
  signedOutLocally: Promise<void>;
  /** The server answered; `getSignOutState` tells whether it confirmed. Never rejects. */
  settled: Promise<void>;
}

interface SessionControl {
  generation: number;
  signOut: SignOutState;
  pendingSignOut: SignOut | undefined;
  /** Tail of the queue of requests that change the session cookie. */
  cookieQueue: Promise<unknown>;
  listeners: Set<() => void>;
}

const controls = new WeakMap<QueryClient, SessionControl>();

function controlOf(queryClient: QueryClient): SessionControl {
  let control = controls.get(queryClient);
  if (!control) {
    control = {
      generation: 0,
      signOut: IDLE,
      pendingSignOut: undefined,
      cookieQueue: Promise.resolve(),
      listeners: new Set(),
    };
    controls.set(queryClient, control);
  }
  return control;
}

function setSignOutState(control: SessionControl, state: SignOutState): void {
  if (control.signOut === state) return;
  control.signOut = state;
  control.listeners.forEach((listener) => {
    listener();
  });
}

/** Runs `request` once every earlier cookie-changing request has been answered. */
function inCookieQueue<T>(control: SessionControl, request: () => Promise<T>): Promise<T> {
  const result = control.cookieQueue.then(request);
  control.cookieQueue = result.catch(() => undefined);
  return result;
}

/** A session check answered after a newer identity transition began; its answer is outdated. */
export class StaleSessionCheckError extends Error {
  constructor() {
    super('The session changed while it was being checked');
    this.name = 'StaleSessionCheckError';
  }
}

/**
 * Asks the server who is signed in. The answer is used only if no identity transition started
 * meanwhile; otherwise this rejects with `StaleSessionCheckError` and touches nothing. While a
 * sign-out is unfinished or unconfirmed the answer is "nobody", without asking: the user asked to
 * leave, and an identity the server still remembers must not come back on its own.
 */
export async function checkSession(
  queryClient: QueryClient,
  signal?: AbortSignal,
): Promise<CurrentUser | null> {
  const control = controlOf(queryClient);
  if (control.signOut.status !== 'idle') return null;
  const generation = control.generation;
  const assertCurrent = () => {
    if (control.generation !== generation) throw new StaleSessionCheckError();
  };

  const identity = await fetchCurrentUser(signal);
  assertCurrent();
  // The cookie can change behind this tab's back (another tab signed in as someone else).
  // Drop the previous identity's data before the new identity is stored and rendered.
  if (!sameIdentity(queryClient.getQueryData<CurrentUser | null>(SESSION_KEY), identity)) {
    await purgeProtectedData(queryClient);
    assertCurrent();
  }
  return identity;
}

export const sessionQuery = queryOptions({
  queryKey: SESSION_KEY,
  queryFn: ({ signal, client }) => checkSession(client, signal),
  // Re-check whenever the user returns to the tab: the session may have ended meanwhile.
  refetchOnWindowFocus: 'always',
});

const isProtected = (query: Query) => query.queryKey[0] === PROTECTED_QUERY_ROOT;

function belongsToCurrentIdentity(queryClient: QueryClient, query: Query): boolean {
  const current = queryClient.getQueryData<CurrentUser | null>(SESSION_KEY);
  return Boolean(current) && query.queryKey[1] === (current && identityKey(current));
}

/**
 * Aborts every in-flight protected request and drops all protected data nothing is displaying.
 * Queries still observed belong to components that are about to unmount; removing them now
 * would let their last render rebuild (and refetch) them. `dropAbandonedProtectedQueries`
 * removes them the moment they are no longer observed.
 */
export async function purgeProtectedData(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ queryKey: [PROTECTED_QUERY_ROOT] });
  queryClient.removeQueries({
    queryKey: [PROTECTED_QUERY_ROOT],
    predicate: (query) => query.getObserversCount() === 0,
  });
}

/**
 * Cache invariant: a protected query that does not belong to the current identity is removed
 * as soon as its last observer goes away. Returns an unsubscribe function.
 */
export function dropAbandonedProtectedQueries(queryClient: QueryClient): () => void {
  const cache = queryClient.getQueryCache();
  return cache.subscribe((event) => {
    if (event.type !== 'observerRemoved') return;
    const query = cache.get(event.query.queryHash);
    if (
      query &&
      isProtected(query) &&
      query.getObserversCount() === 0 &&
      !belongsToCurrentIdentity(queryClient, query)
    ) {
      void query.cancel();
      cache.remove(query);
    }
  });
}

/**
 * The only way the client decides who is signed in. Starts a new generation, so session checks
 * already on their way are cancelled and their answers ignored. If the identity actually
 * changes, the previous identity's requests are aborted and its data dropped *before* the new
 * identity is published to the UI. If a newer transition starts meanwhile, that one publishes.
 */
export async function switchIdentity(
  queryClient: QueryClient,
  next: CurrentUser | null,
): Promise<void> {
  const control = controlOf(queryClient);
  const generation = ++control.generation;
  await queryClient.cancelQueries({ queryKey: SESSION_KEY });
  if (!sameIdentity(queryClient.getQueryData(SESSION_KEY), next)) {
    await purgeProtectedData(queryClient);
  }
  if (control.generation === generation) {
    queryClient.setQueryData(SESSION_KEY, next);
  }
}

/**
 * Signs in. Waits for any unfinished sign-out first, so its response (which clears the cookie)
 * cannot arrive after this sign-in's. The new identity is published only if no other transition
 * started meanwhile; otherwise the server is asked again. Rejects if the credentials are refused.
 */
export async function startSession(
  queryClient: QueryClient,
  credentials: SignInRequest,
): Promise<void> {
  const control = controlOf(queryClient);
  const generation = control.generation;
  const identity = await inCookieQueue(control, () => signIn(credentials));
  if (control.generation !== generation) {
    await queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    return;
  }
  // Signing in also revoked whatever session this browser presented, confirmed or not.
  setSignOutState(control, IDLE);
  await switchIdentity(queryClient, identity);
}

/**
 * Signs out: locally at once (whether or not the server is reachable), then on the server. A
 * failure is kept as the `failed` sign-out state for the UI to report and retry, and the
 * identity stays signed out locally meanwhile. Calling it while a sign-out is unfinished
 * returns that sign-out.
 */
export function endSession(queryClient: QueryClient): SignOut {
  const control = controlOf(queryClient);
  if (control.pendingSignOut) return control.pendingSignOut;

  setSignOutState(control, { status: 'pending' });
  const signedOutLocally = switchIdentity(queryClient, null);
  const settled = inCookieQueue(control, async () => {
    await signedOutLocally;
    await signOut();
  }).then(
    () => {
      control.pendingSignOut = undefined;
      setSignOutState(control, IDLE);
    },
    (error: unknown) => {
      control.pendingSignOut = undefined;
      setSignOutState(control, { status: 'failed', error });
    },
  );
  control.pendingSignOut = { signedOutLocally, settled };
  return control.pendingSignOut;
}

/**
 * Another tab signed in or out, so the shared cookie may now belong to someone else. Fails
 * closed: drops protected data at once and returns the session to "unknown" (not "stale"), so
 * nothing renders until the server has answered. An unconfirmed sign-out here is superseded,
 * since the server's answer now reflects that other tab's action.
 */
export async function sessionChangedElsewhere(queryClient: QueryClient): Promise<void> {
  const control = controlOf(queryClient);
  control.generation += 1;
  if (control.signOut.status === 'failed') setSignOutState(control, IDLE);
  await Promise.all([
    purgeProtectedData(queryClient),
    queryClient.resetQueries({ queryKey: SESSION_KEY }),
  ]);
}

export function getSignOutState(queryClient: QueryClient): SignOutState {
  return controlOf(queryClient).signOut;
}

/** Notifies `listener` whenever the sign-out state changes. Returns an unsubscribe function. */
export function subscribeToSignOutState(queryClient: QueryClient, listener: () => void) {
  const { listeners } = controlOf(queryClient);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
