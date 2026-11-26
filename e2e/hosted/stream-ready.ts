/** One message the web app's own EventSource received: page time and message type only. */
export interface StreamMessage {
  at: number;
  type: string | null;
}

/** Polls until `probe` yields a value; fails with `message()` after `timeoutMs`. */
export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  message: () => string,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(message());
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The page time of the first `type` message at or after `since` (page time). */
export function awaitStreamMessage(
  messages: () => Promise<StreamMessage[]>,
  type: string,
  since: number,
  timeoutMs = 30_000,
): Promise<number> {
  return waitFor(
    async () => {
      for (const message of await messages())
        if (message.type === type && message.at >= since) return message.at;
      return undefined;
    },
    timeoutMs,
    () =>
      `No ${type} message arrived on the web app's event stream within ${String(timeoutMs / 1000)} s`,
  );
}

/** The page operations a signed-in reload needs. */
export interface ReloadSteps {
  /** The page's clock (`Date.now()` in the current document). */
  now: () => Promise<number>;
  /** Loads a new document. */
  reload: () => Promise<void>;
  /** Resolves once the new document shows the signed-in app. */
  signedIn: () => Promise<void>;
  /** The current document's stream messages for the voyage. */
  messages: () => Promise<StreamMessage[]>;
}

/**
 * Reloads a signed-in page and requires the new document's own stream to receive READY.
 * Returns the page time READY arrived.
 *
 * The boundary is taken before the navigation starts. READY can arrive before the signed-in app
 * is visible, so a cutoff taken after that wait would discard a valid event. The history is
 * per document anyway (the instrumentation starts empty in each one), so nothing the previous
 * document received can satisfy the check.
 */
export async function reloadSignedInWithReady(
  steps: ReloadSteps,
  timeoutMs = 30_000,
): Promise<number> {
  const boundary = await steps.now();
  await steps.reload();
  await steps.signedIn();
  return awaitStreamMessage(steps.messages, 'READY', boundary, timeoutMs);
}
