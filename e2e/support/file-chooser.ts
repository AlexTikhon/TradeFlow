import type { FileChooser, Locator, Page } from '@playwright/test';

/*
 * Waiting for the file chooser that a person opens from a file input, by keyboard for instance.
 *
 * Playwright switches Chromium's file-chooser interception on when the first `filechooser`
 * listener is added, without waiting for Chromium to apply it, and Chromium may handle a key
 * press sent right afterwards first: the two commands reach the page by different routes.
 * Headless Chromium then dismisses the picker it was not told to hand over. The input receives
 * `cancel`, Playwright never emits `filechooser`, and a bare `waitForEvent` waits out the test
 * (docs/mvp-status.md, "Intermittent verification failures").
 *
 * `armFileChooser` adds the listener and then evaluates in the page over the same DevTools
 * session, which Chromium handles after the interception command; once it has returned, a picker
 * the page opens is intercepted. It also records a `cancel` on the input, so that a missing
 * chooser fails within a bounded time and says where focus was and what the input saw.
 */

/** Flag set on the armed input when it receives `cancel`. */
const CANCELLED = '__e2eFileChooserCancelled';

export interface ArmedFileChooser {
  /**
   * The chooser the page opened, waiting at most `timeout` ms from this call; otherwise an error
   * that describes focus and the input, never cookies, storage, headers or file contents.
   */
  chosen(timeout?: number): Promise<FileChooser>;
}

export async function armFileChooser(page: Page, input: Locator): Promise<ArmedFileChooser> {
  // No timeout of its own: `chosen` bounds the wait from the moment the test asks for it.
  const choosing = page.waitForEvent('filechooser', { timeout: 0 });
  // Rejects only when the page closes; `chosen` reports that.
  choosing.catch(() => undefined);
  await input.evaluate(
    (element, flag) => {
      const flagged = element as unknown as Record<string, boolean>;
      flagged[flag] = false;
      element.addEventListener('cancel', () => (flagged[flag] = true), { once: true });
    },
    CANCELLED,
    { timeout: 5_000 },
  );
  return {
    async chosen(timeout = 15_000) {
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => {
          resolve('expired');
        }, timeout);
      });
      try {
        const outcome = await Promise.race([choosing, expired]);
        if (outcome !== 'expired') return outcome;
      } finally {
        clearTimeout(timer);
      }
      throw new Error(`No file chooser within ${timeout} ms. ${await describe(page, input)}`);
    },
  };
}

/** Where focus is and what the armed input saw: element names and states only. */
async function describe(page: Page, input: Locator): Promise<string> {
  const facts = [`Page: ${new URL(page.url()).pathname}.`];
  try {
    facts.push(
      `Focus: ${await page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return 'the page body';
        const type = active.getAttribute('type');
        const label = active.getAttribute('aria-label');
        return `${active.tagName.toLowerCase()}${type ? `[type=${type}]` : ''}${label ? ` "${label}"` : ''}`;
      })}.`,
    );
    const count = await input.count();
    if (count !== 1) {
      facts.push(`The input matches ${count} elements now.`);
    } else {
      const state = await input.evaluate(
        (element, flag) => ({
          focused: document.activeElement === element,
          disabled: (element as HTMLInputElement).disabled,
          cancelled: (element as unknown as Record<string, boolean | undefined>)[flag],
        }),
        CANCELLED,
        { timeout: 2_000 },
      );
      facts.push(
        state.cancelled === undefined
          ? 'The input on the page is not the one armed: it was replaced.'
          : state.cancelled
            ? 'The input received "cancel": the browser opened a picker and dismissed it without handing it over.'
            : 'The input received no "cancel": no picker was opened.',
        `It is ${state.focused ? '' : 'not '}focused and ${state.disabled ? '' : 'not '}disabled.`,
      );
    }
    facts.push(`Pages in its browser context: ${page.context().pages().length}.`);
  } catch (error) {
    facts.push(`The page could not be inspected: ${(error as Error).message.split('\n')[0]}`);
  }
  return facts.join(' ');
}
