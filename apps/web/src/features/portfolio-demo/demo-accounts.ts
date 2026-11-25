/*
 * The seeded, fictional accounts the portfolio showcase is prepared for (apps/api/prisma/seed.ts).
 * Shown only in the portfolio demo's build. They grant nothing: the published password is the
 * seed's, sign-in goes through the API like any other, and the guide's wording is chosen by the
 * signed-in email only to explain what the API already allows that account.
 */

/** The seed's published password, shared by every demo account. */
export const DEMO_PASSWORD = 'tradeflow-demo';

export type DemoPart = 'seller' | 'buyer' | 'viewer' | 'outsider';

export interface DemoAccount {
  part: DemoPart;
  /** The part, as the picker labels it. */
  label: string;
  fullName: string;
  /** How the guide addresses them. */
  shortName: string;
  email: string;
  organization: string;
  /** One line on the sign-in page. */
  summary: string;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    part: 'seller',
    label: 'Seller',
    fullName: 'Ana Souza',
    shortName: 'Ana',
    email: 'ana.souza@cerrado-graos.example',
    organization: 'Cerrado Grãos',
    summary: 'Uploads the documents and replaces rejected ones.',
  },
  {
    part: 'buyer',
    label: 'Buyer',
    fullName: 'Tan Wei Ling',
    shortName: 'Wei Ling',
    email: 'wei.ling.tan@meridianagri.example',
    organization: 'Meridian Agri Trading',
    summary: 'Gave the instructions; approves or rejects documents.',
  },
  {
    part: 'viewer',
    label: 'Viewer',
    fullName: 'Rafael Lima',
    shortName: 'Rafael',
    email: 'rafael.lima@cerrado-graos.example',
    organization: 'Cerrado Grãos',
    summary: "Ana's colleague: reads and downloads, changes nothing.",
  },
  {
    part: 'outsider',
    label: 'Outsider',
    fullName: 'Lucía Ferreyra',
    shortName: 'Lucía',
    email: 'lucia.ferreyra@pampalitoral.example',
    organization: 'Pampa Litoral',
    summary: 'Not part of the showcase voyage, so cannot open it.',
  },
];

/** The demo account signed in, if it is one of them (emails compare case-insensitively). */
export const demoAccountOf = (email: string): DemoAccount | undefined =>
  DEMO_ACCOUNTS.find((account) => account.email === email.toLowerCase());
