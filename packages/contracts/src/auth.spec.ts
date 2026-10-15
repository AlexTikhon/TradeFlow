import { describe, expect, it } from 'vitest';
import { SignInRequestSchema } from './auth.js';

describe('SignInRequestSchema', () => {
  it('normalises the email to the lowercase form the database stores', () => {
    expect(
      SignInRequestSchema.parse({ email: '  Ana.Souza@Cerrado-Graos.example ', password: 'x' }),
    ).toEqual({ email: 'ana.souza@cerrado-graos.example', password: 'x' });
  });

  it.each([
    { email: 'not-an-email', password: 'x' },
    { email: 'ana@example.com', password: '' },
    { email: 'ana@example.com', password: 'x'.repeat(1025) },
    { email: 'ana@example.com' },
  ])('rejects %j', (input) => {
    expect(SignInRequestSchema.safeParse(input).success).toBe(false);
  });
});
