import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { PrismaPg } from '@prisma/adapter-pg';
import { DemoWriteBudgetExhaustedException } from '../../common/http/demo-write-budget-exhausted.exception.js';
import { schemaRef } from '../../common/http/openapi.js';
import { currentRequestContext } from '../../common/http/request-context.js';
import { describeFailure } from '../../common/http/request-failure.js';
import { APP_CONFIG, type AppConfig, type DemoWriteBudgetConfig } from '../../config/app-config.js';
import { PrismaClient } from '../../generated/prisma/client.js';

/** How long admission may take, connecting included, before the command is refused. */
const ADMISSION_TIMEOUT_MS = 5_000;

/**
 * The portfolio demo's write budget (ADR 0021): with `PORTFOLIO_DEMO_WRITE_PROTECTION=enabled`,
 * this database admits at most `allowance` business commands, counted in `demo_write_budget`.
 * Disabled (the default), `admit` does nothing and touches no database.
 *
 * Every business command calls `admit` exactly once, after its authentication, authorization and
 * precondition checks and before its first business write or storage staging. Admission is one
 * conditional upsert, so concurrent commands can never be admitted past the allowance: PostgreSQL
 * serializes them on the counter row and re-evaluates the condition on the latest count.
 *
 * It runs on a small connection pool of its own, never inside the command's transaction, and
 * commits by itself. So an admitted attempt stays counted whatever the command does next (fails
 * a later check, loses a race, rolls back, is interrupted): attempts are counted conservatively
 * and never refunded. And a command holding a transaction can never wait for a connection its own
 * transaction is keeping from the shared pool.
 *
 * Fails closed: if the count cannot be read and raised, the command is refused (503) before it
 * writes anything, and the cause is recorded on the request's lifecycle record.
 */
@Injectable()
export class DemoWriteBudget implements OnModuleDestroy {
  private readonly budget: DemoWriteBudgetConfig;
  private readonly connection: PrismaClient | undefined;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.budget = config.demoWriteBudget;
    this.connection = this.budget.enabled
      ? new PrismaClient({
          adapter: new PrismaPg({
            connectionString: config.databaseUrl,
            connectionTimeoutMillis: ADMISSION_TIMEOUT_MS,
            statement_timeout: ADMISSION_TIMEOUT_MS,
          }),
        })
      : undefined;
  }

  /**
   * Counts one business command against the allowance, or refuses it with 429 when the allowance
   * is used up. Call it once per command, where nothing has been written or staged yet.
   */
  async admit(): Promise<void> {
    if (!this.budget.enabled || this.connection === undefined) return;
    let admitted: unknown[];
    try {
      // The first command creates the row at 1 (an allowance is at least 1); every later one
      // raises it only while it is below the allowance. ON CONFLICT DO UPDATE locks the row and
      // judges the WHERE clause on its latest committed count.
      admitted = await this.connection.$queryRaw`
        INSERT INTO demo_write_budget AS budget (id, admitted) VALUES (1, 1)
        ON CONFLICT (id) DO UPDATE SET admitted = budget.admitted + 1
        WHERE budget.admitted < ${this.budget.allowance}::int
        RETURNING budget.admitted`;
    } catch (error) {
      // The cause, by bounded fields, on the request's lifecycle record (HTTP diagnostics): the
      // first failure noted wins over the 503 the exception filter then sees.
      currentRequestContext()?.noteFailure(describeFailure('exception', error));
      throw new ServiceUnavailableException('Changes are temporarily unavailable.');
    }
    if (admitted.length === 0) {
      throw new DemoWriteBudgetExhaustedException();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.$disconnect();
  }
}

/** Documents the 429 of a business command covered by the write budget. */
export const ApiDemoWriteBudgetResponse = () =>
  ApiTooManyRequestsResponse({
    description:
      'Only on a portfolio demo with write protection enabled: the demo has admitted every ' +
      'business command it allows. Nothing was changed or stored. Waiting does not help and ' +
      'there is no Retry-After: only an operator resetting the demo allows changes again. ' +
      'Reads, downloads and signing in and out still work.',
    schema: schemaRef('ProblemDetails'),
  });
