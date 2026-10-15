import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { TestProject } from 'vitest/node';

/** Brings the test database schema up to date once per run, using the real migrations. */
export default function setup(project: TestProject): void {
  const databaseUrl = project.config.env.DATABASE_URL;
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against "${String(databaseUrl)}": ` +
        'the database name must end in "_test" because tests truncate its tables.',
    );
  }

  // Run the Prisma CLI through the current Node binary: no shell, so no argument injection
  // and identical behaviour on Windows and Linux.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}
