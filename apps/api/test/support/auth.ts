import type { Server } from 'node:http';
import request from 'supertest';
import { TEST_PASSWORD } from './database.js';

/** Cookie name outside production (see SessionCookie). */
export const SESSION_COOKIE = 'tradeflow_session';

export const sessionCookie = (token: string) => `${SESSION_COOKIE}=${token}`;

/** Extracts the session token from a response's Set-Cookie header, if one was set. */
export function sessionTokenFrom(setCookie: string[] | string | undefined): string | undefined {
  const headers = typeof setCookie === 'string' ? [setCookie] : (setCookie ?? []);
  const prefix = `${SESSION_COOKIE}=`;
  const cookie = headers.find((header) => header.startsWith(prefix));
  const token = cookie?.slice(prefix.length).split(';')[0];
  return token === '' ? undefined : token;
}

/** Signs in through the real endpoint and returns a `Cookie` header value for later requests. */
export async function signIn(server: Server, email: string, password = TEST_PASSWORD) {
  const response = await request(server)
    .post('/api/auth/sign-in')
    .send({ email, password })
    .expect(200);
  const token = sessionTokenFrom(response.headers['set-cookie']);
  if (!token) {
    throw new Error('Sign-in succeeded without setting a session cookie');
  }
  return sessionCookie(token);
}
