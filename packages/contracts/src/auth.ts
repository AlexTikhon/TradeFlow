import { z } from 'zod';
import { apiSchemaRegistry } from './registry.js';
import { OrganizationRefSchema } from './voyages.js';

/**
 * Credentials for `POST /api/auth/sign-in`. Emails are compared case-insensitively
 * (the database stores them lowercase), so the schema normalises before validating.
 */
export const SignInRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
    // Bounded so a request cannot make the server hash an arbitrarily large input.
    password: z.string().min(1).max(1024),
  })
  .register(apiSchemaRegistry, { id: 'SignInRequest' });

export const UserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    fullName: z.string(),
  })
  .register(apiSchemaRegistry, { id: 'User' });

/**
 * The signed-in identity, as resolved by the server from the session cookie.
 * A user acts for exactly one organization; the client never chooses it.
 */
export const CurrentUserSchema = z
  .object({
    user: UserSchema,
    organization: OrganizationRefSchema,
  })
  .register(apiSchemaRegistry, { id: 'CurrentUser' });

export type SignInRequest = z.infer<typeof SignInRequestSchema>;
export type User = z.infer<typeof UserSchema>;
export type CurrentUser = z.infer<typeof CurrentUserSchema>;
