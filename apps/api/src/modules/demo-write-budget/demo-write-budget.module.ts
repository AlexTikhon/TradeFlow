import { Global, Module } from '@nestjs/common';
import { DemoWriteBudget } from './demo-write-budget.js';

/** The portfolio demo's write budget (ADR 0021), available to every command module. */
@Global()
@Module({
  providers: [DemoWriteBudget],
  exports: [DemoWriteBudget],
})
export class DemoWriteBudgetModule {}
