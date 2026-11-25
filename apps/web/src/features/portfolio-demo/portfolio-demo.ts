import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

/*
 * Portfolio-demo onboarding: an account picker on the sign-in page and a short guide in the app,
 * for the opt-in portfolio showcase (`pnpm demo:portfolio`) only.
 *
 * It is switched on by one explicit build setting, the Vite mode `portfolio-demo`, which only
 * the portfolio profile's web build passes (`vite build --mode portfolio-demo`, e2e/demo). It is
 * never inferred from NODE_ENV, the hostname, the accounts or the address, and no environment
 * variable can switch it on: an ordinary build, `vite` and the plain demo use other modes.
 *
 * Which voyage the showcase is exists only after the build, so the demo writes it into its own
 * build as a small static file once the voyage is prepared. The file is a navigation aid, never
 * an authorization source: the API decides what each account may open. Links are built from its
 * validated id only; when it is missing or malformed, the guide offers no showcase link at all.
 */

export const PORTFOLIO_DEMO_MODE = 'portfolio-demo';

/** Whether this build is the portfolio demo's. Read at call time, so tests can switch it. */
export const isPortfolioDemo = (): boolean => import.meta.env.MODE === PORTFOLIO_DEMO_MODE;

/** The showcase's metadata, written by e2e/demo/portfolio.ts into the demo's web build. */
export const SHOWCASE_METADATA_PATH = '/portfolio-demo.json';

/** More than the file ever needs; anything larger is not the demo's file. */
const MAX_METADATA_LENGTH = 1_024;

const ShowcaseMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  showcase: z.strictObject({
    voyageId: z.uuid(),
    reference: z.string().regex(/^TF-\d{4}-\d{4,}$/),
  }),
});

export type Showcase = z.infer<typeof ShowcaseMetadataSchema>['showcase'];

/**
 * The prepared showcase voyage, or null when this run has none to point at: the file is missing,
 * unreadable, too large or not exactly the expected shape. Never throws for those; only an abort
 * rejects.
 */
export async function fetchShowcase(signal?: AbortSignal): Promise<Showcase | null> {
  let text: string;
  try {
    const response = await fetch(SHOWCASE_METADATA_PATH, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      ...(signal && { signal }),
    });
    const type = response.headers.get('Content-Type') ?? '';
    if (!response.ok || !/^application\/json\b/i.test(type)) return null;
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  if (text.length > MAX_METADATA_LENGTH) return null;
  try {
    const parsed = ShowcaseMetadataSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.showcase : null;
  } catch {
    return null;
  }
}

export const showcaseQuery = queryOptions({
  // Public and the same for everyone: not under the protected (per-identity) root.
  queryKey: ['portfolio-demo', 'showcase'],
  queryFn: ({ signal }) => fetchShowcase(signal),
  retry: false,
  // Found once, it does not change while the demo runs; "none" is asked again next time.
  staleTime: (query) => (query.state.data ? Infinity : 0),
});

/** The voyage page of the showcase, from its validated id only. */
export const showcasePath = (showcase: Showcase) =>
  `/voyages/${encodeURIComponent(showcase.voyageId)}`;

/**
 * Navigation state that asks the app to open the guide once, set by the sign-in page after a
 * sign-in it sent itself.
 */
export const GUIDE_AFTER_SIGN_IN = 'portfolioGuide';

export const wantsGuide = (state: unknown): boolean =>
  typeof state === 'object' &&
  state !== null &&
  (state as Record<string, unknown>)[GUIDE_AFTER_SIGN_IN] === true;
