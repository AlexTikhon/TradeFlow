import { describe, expect, it } from 'vitest';
import type { Principal } from '../auth/principal.js';
import { counterpartyContracts } from './counterparty-contracts.js';
import { accessibleVoyages } from './voyage-access.js';

const principal: Principal = {
  sessionId: '01990000-0000-7000-8000-000000000001',
  userId: '01990000-0000-7000-8002-000000000005',
  organizationId: '01990000-0000-7000-8001-000000000004',
  role: 'VIEWER',
};

describe('counterpartyContracts', () => {
  // The composite foreign keys make counterparty status imply participation today, so no
  // database state can tell the two conditions apart. This pins that both are stated.
  it('requires current participation in the voyage and a side of the contract', () => {
    expect(counterpartyContracts(principal)).toEqual({
      AND: [
        { voyage: accessibleVoyages(principal) },
        {
          OR: [
            { seller: { organizationId: principal.organizationId } },
            { buyer: { organizationId: principal.organizationId } },
          ],
        },
      ],
    });
  });
});
