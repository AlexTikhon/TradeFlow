import { describe, expect, it } from 'vitest';
import { loadConfig } from './app-config.js';

describe('loadConfig', () => {
  it('applies defaults and parses the port', () => {
    expect(
      loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5433/tradeflow', PORT: '4000' }),
    ).toEqual({
      nodeEnv: 'development',
      port: 4000,
      databaseUrl: 'postgresql://u:p@localhost:5433/tradeflow',
    });
  });

  it('fails fast listing every invalid variable', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/db', PORT: 'abc' })).toThrow(
      /DATABASE_URL[\s\S]*PORT|PORT[\s\S]*DATABASE_URL/,
    );
  });
});
