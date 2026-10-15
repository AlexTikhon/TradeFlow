import type { CurrentUser } from '@tradeflow/contracts';

/** Password the fake auth API accepts for every account. */
export const TEST_PASSWORD = 'tradeflow-demo';

/** Typed against the shared contract, so fixtures cannot drift from what the API returns. */
export function aCurrentUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    user: {
      id: '01990000-0000-7000-8002-000000000001',
      email: 'ana.souza@cerrado-graos.example',
      fullName: 'Ana Souza',
      role: 'OPERATOR',
    },
    organization: {
      id: '01990000-0000-7000-8001-000000000001',
      name: 'Cerrado Grãos Exportadora S.A.',
      countryCode: 'BR',
    },
    ...overrides,
  };
}

/** A second identity, in a different organization. */
export const anotherUser = (): CurrentUser =>
  aCurrentUser({
    user: {
      id: '01990000-0000-7000-8002-000000000005',
      email: 'claire.morel@lacustra.example',
      fullName: 'Claire Morel',
      role: 'OPERATOR',
    },
    organization: {
      id: '01990000-0000-7000-8001-000000000004',
      name: 'Lacustra Commodities SA',
      countryCode: 'CH',
    },
  });
