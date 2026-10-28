import type { Party } from '../support/scenario.js';

/*
 * Seeded users of the fresh-voyage walkthrough (docs/demo.md, walkthrough 2), exactly as
 * apps/api/prisma/seed.ts writes them. All names are fictional; the password is published.
 */

/** Every seeded user's password (DEMO_PASSWORD in the seed). */
export const DEMO_PASSWORD = 'tradeflow-demo';

/** Exporter: creates the voyage, sets up its trade string; seller under contract 1. */
export const ANA: Party = {
  email: 'ana.souza@cerrado-graos.example',
  fullName: 'Ana Souza',
  organizationName: 'Cerrado Grãos Exportadora S.A.',
  password: DEMO_PASSWORD,
};

/** Trader named in setup: buyer under contract 1, seller under contract 2. */
export const WEI_LING: Party = {
  email: 'wei.ling.tan@meridianagri.example',
  fullName: 'Tan Wei Ling',
  organizationName: 'Meridian Agri Trading Pte. Ltd.',
  password: DEMO_PASSWORD,
};

/** Final buyer named in setup: buyer under contract 2 only. */
export const EMRE: Party = {
  email: 'emre.kaya@anatoliamills.example',
  fullName: 'Emre Kaya',
  organizationName: 'Anatolia Flour Mills A.Ş.',
  password: DEMO_PASSWORD,
};

/** Takes no part in the new voyage. */
export const LUCIA: Party = {
  email: 'lucia.ferreyra@pampalitoral.example',
  fullName: 'Lucía Ferreyra',
  organizationName: 'Pampa Litoral Agroexport S.A.',
  password: DEMO_PASSWORD,
};
