import { type Query, type QueryClient, queryOptions } from '@tanstack/react-query';

import type { CurrentUser, SignInRequest } from '@tradeflow/contracts';
import { isUnauthenticated } from '../../shared/api/http-client';
import {
  identityKey,
  PROTECTED_QUERY_ROOT,
  SESSION_QUERY_KEY,
  sameIdentity,
} from '../../shared/auth/identity';
import { fetchCurrentUser, signIn, signOut } from './api/auth.api';

/*
 * The session is server state like any other (ADR 0003): the server decides who is signed in,
 * and `GET /api/auth/me` is how the client asks. `null` means signed out.
 *
 * Who is signed in changes through explicit transitions (sign-in, sign-out, a 401, another tab)
 * and through session checks. Transitions are ordered by a generation counter kept per query
 * client: each one starts a new generation, and a check's answer counts only if no transition
 * started while it was on its way. A check whose answer names someone else starts a generation
 * too; one that confirms the identity does not. Requests that change the session cookie (sign-in, sign-out)
 * run one at a time, so a slow sign-out response cannot clear the cookie of a newer sign-in.
 *
 * A sign-in owns the session from the moment it starts until it resolves: nobody is signed in
 * locally meanwhile, and session checks answer "nobody" without asking. Only the latest sign-in
 * intent may publish an identity. When that intent cannot be honoured as sent (refused, or
 * overtaken by another tab), the client asks the server and adopts its answer.
 */

const SESSION_KEY = SESSION_QUERY_KEY;

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
  /** This tab signed out explicitly, and no identity has been published here since. */
  signedOutHere: boolean;
  /** Generation of the latest sign-in not yet resolved; it alone may publish an identity. */
  signInIntent: number | undefined;
  /** Tail of the queue of requests that change the session cookie. */
  cookieQueue: Promise<unknown>;
  listeners: Set<() => void>;
  /** Told whenever a new generation starts; see `subscribeToSessionTransitions`. */
  transitionListeners: Set<() => void>;
}

const controls = new WeakMap<QueryClient, SessionControl>();

function controlOf(queryClient: QueryClient): SessionControl {
  let control = controls.get(queryClient);
  if (!control) {
    control = {
      generation: 0,
      signOut: IDLE,
      pendingSignOut: undefined,
      signedOutHere: false,
      signInIntent: undefined,
      cookieQueue: Promise.resolve(),
      listeners: new Set(),
      transitionListeners: new Set(),
    };
    controls.set(queryClient, control);
  }
  return control;
}

/**
 * Starts a new generation: every earlier session epoch is outdated from now on. Transition
 * listeners are told at once, before anything else of the transition happens. A listener that
 * throws is reported without stopping the transition or the other listeners.
 */
function nextGeneration(control: SessionControl): number {
  const generation = ++control.generation;
  control.transitionListeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  });
  return generation;
}

function notifySignOutListeners(control: SessionControl): void {
  control.listeners.forEach((listener) => {
    listener();
  });
}

function setSignOutState(control: SessionControl, state: SignOutState): void {
  if (control.signOut === state) return;
  control.signOut = state;
  notifySignOutListeners(control);
}

function setSignedOutHere(control: SessionControl, signedOutHere: boolean): void {
  if (control.signedOutHere === signedOutHere) return;
  control.signedOutHere = signedOutHere;
  notifySignOutListeners(control);
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

/** A session check's answer, and the generation it belongs to. */
interface SessionAnswer {
  identity: CurrentUser | null;
  /** The generation the check started in, or the one it started itself by adopting someone. */
  generation: number;
}

/**
 * Asks the server who is signed in. The answer is used only if no identity transition started
 * meanwhile; otherwise this rejects with `StaleSessionCheckError` and touches nothing. While a
 * sign-out is unfinished or unconfirmed the answer is "nobody", without asking: the user asked to
 * leave, and an identity the server still remembers must not come back on its own. While a
 * sign-in is pending the answer is also "nobody": the cookie is about to change, and whoever it
 * belongs to now must not be shown.
 *
 * An answer naming someone other than the identity held now (the cookie changed behind this
 * tab's back, with no notification) starts a new generation, owned by this check: every earlier
 * session has ended, even if its identity comes back later, and checks still on their way are
 * outdated. An answer that confirms the identity held now changes nothing.
 */
export async function checkSession(
  queryClient: QueryClient,
  signal?: AbortSignal,
): Promise<CurrentUser | null> {
  return (await askServer(queryClient, signal)).identity;
}

async function askServer(queryClient: QueryClient, signal?: AbortSignal): Promise<SessionAnswer> {
  const control = controlOf(queryClient);
  let generation = control.generation;
  if (control.signOut.status !== 'idle' || control.signInIntent !== undefined) {
    return { identity: null, generation };
  }
  const assertCurrent = () => {
    if (control.generation !== generation) throw new StaleSessionCheckError();
  };

  const identity = await fetchCurrentUser(signal);
  assertCurrent();
  // Drop the previous identity's data before the new identity is stored and rendered.
  if (!sameIdentity(queryClient.getQueryData<CurrentUser | null>(SESSION_KEY), identity)) {
    generation = nextGeneration(control);
    await purgeProtectedData(queryClient);
    assertCurrent();
  }
  // Someone is signed in again (another tab signed in): this tab's sign-out is over.
  if (identity) setSignedOutHere(control, false);
  return { identity, generation };
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
  const generation = nextGeneration(controlOf(queryClient));
  await publishIdentity(queryClient, generation, next);
}

/** The second half of a transition that started `generation`: see `switchIdentity`. */
async function publishIdentity(
  queryClient: QueryClient,
  generation: number,
  next: CurrentUser | null,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: SESSION_KEY });
  if (!sameIdentity(queryClient.getQueryData(SESSION_KEY), next)) {
    await purgeProtectedData(queryClient);
  }
  const control = controlOf(queryClient);
  if (control.generation === generation) {
    if (next) setSignedOutHere(control, false);
    queryClient.setQueryData(SESSION_KEY, next);
  }
}

/**
 * The session as it stands now: the generation it belongs to and the identity published for it.
 * The generation changes with every identity transition, including signing out and back in as
 * the same user, and whenever a session check adopts someone else (the cookie changed behind
 * this tab's back with no notification), so it tells sessions apart where identities cannot:
 * going to someone else and back never revives an earlier session. Capture it when sending a
 * request whose 401 must be attributed to the session it was sent under.
 */
export interface SessionEpoch {
  readonly generation: number;
  readonly identity: CurrentUser | null | undefined;
}

export function currentSessionEpoch(queryClient: QueryClient): SessionEpoch {
  return {
    generation: controlOf(queryClient).generation,
    identity: queryClient.getQueryData<CurrentUser | null>(SESSION_KEY),
  };
}

/**
 * Whether `epoch` is still the session as it stands: no transition has started since, and no
 * session check has adopted another identity. False once the user has signed out, even if the
 * same user has signed back in since, and once a check has gone to someone else, even if a later
 * check came back to the same user. A session check that only confirms the identity changes
 * nothing. Gate on it every side effect of a response to an operation started during `epoch`.
 * (The identity is compared too: an adopting check moves the generation before its answer is
 * published.)
 */
export function isCurrentSession(queryClient: QueryClient, epoch: SessionEpoch): boolean {
  const current = queryClient.getQueryData<CurrentUser | null>(SESSION_KEY);
  return (
    controlOf(queryClient).generation === epoch.generation && sameIdentity(current, epoch.identity)
  );
}

/**
 * Calls `listener` synchronously whenever an identity transition starts, or a session check
 * adopts another identity: the moments a `SessionEpoch` stops being current. For whatever must
 * end with its session at once (a connection made for it), rather than when a response arrives.
 * The listener must be quick and must not start a transition itself. Returns an unsubscribe
 * function.
 */
export function subscribeToSessionTransitions(
  queryClient: QueryClient,
  listener: () => void,
): () => void {
  const { transitionListeners } = controlOf(queryClient);
  transitionListeners.add(listener);
  return () => {
    transitionListeners.delete(listener);
  };
}

/**
 * A request sent during `epoch` was answered 401: that session has ended (expired, or revoked
 * elsewhere). Signs out locally, like a 401 on protected data: requests are aborted, data dropped,
 * and the auth boundary sends the user to sign in. Nothing is sent to the server, which has ended
 * the session already. If any transition started since the request was sent, or a session check
 * has since adopted another identity, the 401 speaks for a session that is already gone (even if its identity has come back), and the
 * current one (whoever it belongs to) is left alone.
 */
export async function sessionExpired(queryClient: QueryClient, epoch: SessionEpoch): Promise<void> {
  if (!isCurrentSession(queryClient, epoch)) return;
  await switchIdentity(queryClient, null);
}

/**
 * Sends a write on behalf of the session current now. If the server answers 401, that session
 * has ended: the client signs out locally before the error is reported (so no form shows it as
 * its own), unless the session has changed since the request was sent (see `sessionExpired`).
 * The error is rethrown either way, and the write is never retried.
 */
export async function sendForCurrentSession<T>(
  queryClient: QueryClient,
  send: () => Promise<T>,
): Promise<T> {
  const epoch = currentSessionEpoch(queryClient);
  try {
    return await send();
  } catch (error) {
    if (isUnauthenticated(error)) await sessionExpired(queryClient, epoch);
    throw error;
  }
}

/**
 * Asks the server who is signed in and publishes the answer, whether or not anything observes
 * the session (invalidating would only mark an unobserved query stale). It is a transition of
 * its own, so checks already on their way are outdated. If the server cannot be reached, the
 * session becomes "unknown" and is asked again by whatever displays it next.
 */
async function reconcileSession(queryClient: QueryClient): Promise<void> {
  const control = controlOf(queryClient);
  const generation = nextGeneration(control);
  await queryClient.cancelQueries({ queryKey: SESSION_KEY });
  try {
    // Adopting someone else moves the check to a generation of its own; it still publishes.
    const answer = await askServer(queryClient);
    if (control.generation === answer.generation) {
      queryClient.setQueryData(SESSION_KEY, answer.identity);
    }
  } catch (error) {
    // A stale answer means a newer transition started; that one publishes.
    if (!(error instanceof StaleSessionCheckError) && control.generation === generation) {
      await queryClient.resetQueries({ queryKey: SESSION_KEY });
    }
  }
}

type SignInOutcome = { ok: true; identity: CurrentUser } | { ok: false; error: unknown };

/**
 * Signs in. The sign-in owns the session at once: older session checks are outdated, and nobody
 * is signed in locally (the previous identity's data is dropped) until it resolves. The request
 * waits for every earlier cookie-changing request, so their responses cannot land after its own.
 *
 * Only the latest sign-in publishes. An earlier one that completes meanwhile publishes nothing;
 * one overtaken by a sign-out leaves the session to that sign-out. When the latest sign-in
 * succeeds, its identity is published. When it is refused, or another tab changed the session
 * while it was on its way, the server is asked who is signed in and its answer is published
 * (after a refusal: whatever cookie an earlier request left, or nobody). Rejects with the
 * sign-in's error once the session has settled.
 */
export async function startSession(
  queryClient: QueryClient,
  credentials: SignInRequest,
): Promise<void> {
  const control = controlOf(queryClient);
  const intent = nextGeneration(control);
  control.signInIntent = intent;
  const response = inCookieQueue(control, () => signIn(credentials)).then(
    (identity): SignInOutcome => ({ ok: true, identity }),
    (error: unknown): SignInOutcome => ({ ok: false, error }),
  );
  await publishIdentity(queryClient, intent, null);
  const outcome = await response;

  // A successful sign-in revoked whatever session this browser presented, confirmed or not.
  if (outcome.ok && control.signOut.status === 'failed') setSignOutState(control, IDLE);
  if (control.signInIntent === intent) {
    control.signInIntent = undefined;
    if (outcome.ok && control.generation === intent) {
      await switchIdentity(queryClient, outcome.identity);
    } else {
      await reconcileSession(queryClient);
    }
  }
  if (!outcome.ok) throw outcome.error;
}

/**
 * Signs out: locally at once (whether or not the server is reachable), then on the server. A
 * failure is kept as the `failed` sign-out state for the UI to report and retry, and the
 * identity stays signed out locally meanwhile. Calling it while a sign-out is unfinished
 * returns that sign-out. From now until someone is signed in again, `signedOutHere` is true.
 */
export function endSession(queryClient: QueryClient): SignOut {
  const control = controlOf(queryClient);
  if (control.pendingSignOut) return control.pendingSignOut;

  // Before nobody is published: the auth boundary reads it when it sees nobody signed in.
  setSignedOutHere(control, true);
  setSignOutState(control, { status: 'pending' });
  // Sign-ins still on their way are overtaken: their responses publish nothing.
  control.signInIntent = undefined;
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
 * since the server's answer now reflects that other tab's action. A sign-in still on its way
 * keeps ownership, and asks the server again once its own response has set the cookie.
 */
export async function sessionChangedElsewhere(queryClient: QueryClient): Promise<void> {
  const control = controlOf(queryClient);
  nextGeneration(control);
  if (control.signOut.status === 'failed') setSignOutState(control, IDLE);
  await Promise.all([
    purgeProtectedData(queryClient),
    queryClient.resetQueries({ queryKey: SESSION_KEY }),
  ]);
}

export function getSignOutState(queryClient: QueryClient): SignOutState {
  return controlOf(queryClient).signOut;
}

/**
 * Whether this tab's own explicit sign-out ended the session, and nobody has been signed in here
 * since. Not when the session ended otherwise: by a 401, or because another tab signed out.
 */
export function signedOutHere(queryClient: QueryClient): boolean {
  return controlOf(queryClient).signedOutHere;
}

/**
 * Notifies `listener` whenever the sign-out state or `signedOutHere` changes. Returns an
 * unsubscribe function.
 */
export function subscribeToSignOutState(queryClient: QueryClient, listener: () => void) {
  const { listeners } = controlOf(queryClient);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
