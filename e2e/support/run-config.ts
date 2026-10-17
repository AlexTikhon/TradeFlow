/*
 * What global setup hands the tests. Setup runs in the runner process and starts everything;
 * tests run in worker processes, which inherit the runner's environment, so these values travel
 * as environment variables. None of them is a secret: the password below exists only in the
 * throwaway E2E database, and the password hash is not a session token.
 */

/** Password of every user a scenario creates, typed into the sign-in form by the tests. */
export const E2E_PASSWORD = 'e2e-browser-password';

/** The dedicated database. Its name must end in `_e2e`: every run drops and recreates it. */
export const DEFAULT_E2E_DATABASE_URL =
  'postgresql://tradeflow:tradeflow@localhost:5433/tradeflow_e2e';

const VARIABLES = {
  webUrl: 'E2E_WEB_URL',
  transportUrl: 'E2E_TRANSPORT_URL',
  databaseUrl: 'E2E_RUN_DATABASE_URL',
  passwordHash: 'E2E_PASSWORD_HASH',
} as const;

export type RunConfig = Record<keyof typeof VARIABLES, string>;

export function publishRunConfig(config: RunConfig): void {
  for (const [key, variable] of Object.entries(VARIABLES)) {
    process.env[variable] = config[key as keyof RunConfig];
  }
}

export function runConfig(): RunConfig {
  const entries = Object.entries(VARIABLES).map(([key, variable]) => {
    const value = process.env[variable];
    if (!value) {
      throw new Error(`${variable} is not set: run the suite with "pnpm test:e2e".`);
    }
    return [key, value];
  });
  return Object.fromEntries(entries) as RunConfig;
}
