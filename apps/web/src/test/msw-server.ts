import type { ProblemDetails } from '@tradeflow/contracts';
import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/** Handlers are registered per test with `server.use(...)` so each test states its API. */
export const server = setupServer();

export function problemResponse(status: number, detail: string) {
  const problem: ProblemDetails = {
    type: 'about:blank',
    title: status === 404 ? 'Not Found' : 'Internal Server Error',
    status,
    detail,
  };
  return HttpResponse.json(problem, {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}
