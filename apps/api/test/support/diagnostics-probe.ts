import { setImmediate as nextTurn } from 'node:timers/promises';
import { Body, Controller, Get, Module, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { currentRequestContext } from '../../src/common/http/request-context.js';
import { Public } from '../../src/modules/auth/auth.decorators.js';

/** In the message, properties and cause of the probe's failure; never in a diagnostic record. */
export const PROBE_FAILURE_CANARY = 'canary-probe-failure-5b1d';

/** An error class of the probe's own, so its records can be told apart. */
export class ProbeFailure extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Test-only routes, loaded beside the real application by the HTTP diagnostics suite: they show
 * which request context the code of a handler sees after awaits, timers and body parsing, and
 * fail or answer late on demand. Never part of the application module.
 */
@Public()
@Controller('test-probe')
class DiagnosticsProbeController {
  /** The request id the handler sees after `delay` ms of timers and turns of the event loop. */
  @Get('context')
  async context(@Query('delay') delay = '0') {
    await sleep(Number(delay));
    await nextTurn();
    return { requestId: currentRequestContext()?.requestId };
  }

  /** The same after the JSON body was parsed. */
  @Post('context')
  async contextAfterBody(@Body() body: { delay?: number }) {
    await sleep(body.delay ?? 0);
    return { requestId: currentRequestContext()?.requestId };
  }

  /** A server bug carrying data in every place an error can. */
  @Get('failure')
  failure(): never {
    throw Object.assign(
      new ProbeFailure(`lookup of ${PROBE_FAILURE_CANARY} failed\n    at forged (/x.js:1:1)`, {
        cause: new Error(PROBE_FAILURE_CANARY),
      }),
      {
        code: 'EPROBE',
        query: `SELECT 1 WHERE token = '${PROBE_FAILURE_CANARY}'`,
        meta: { password: PROBE_FAILURE_CANARY },
      },
    );
  }

  /** Answers after `delay` ms, if the client is still there. */
  @Get('slow')
  async slow(@Query('delay') delay = '500', @Res() response: Response) {
    await sleep(Number(delay));
    if (!response.destroyed) response.json({ late: true });
  }
}

@Module({ controllers: [DiagnosticsProbeController] })
export class DiagnosticsProbeModule {}
