import type { ParticipantRole } from '@tradeflow/contracts';
import { describe, expect, it } from 'vitest';
import {
  InvalidTradeStringError,
  type TradeStringContract,
  type TradeStringParticipant,
  toLinearTradeString,
  validateTradeString,
} from './trade-string.js';

const party = (name: string, role: ParticipantRole): TradeStringParticipant => ({
  participantId: `participant:${name}:${role}`,
  organizationId: `organization:${name}`,
  role,
});

const exporter = party('Cerrado', 'EXPORTER');
const meridian = party('Meridian', 'TRADER');
const lacustra = party('Lacustra', 'TRADER');
const nordlys = party('Nordlys', 'TRADER');
const buyer = party('Bohai', 'FINAL_BUYER');
const surveyor = party('Atlas', 'SURVEYOR');
const agent = party('Costa', 'SHIPPING_AGENT');

const sale = (
  position: number,
  seller: TradeStringParticipant,
  buyerParty: TradeStringParticipant,
): TradeStringContract => ({ position, seller, buyer: buyerParty });

/** Contracts along the given parties, numbered from 1: each sells to the next. */
function chain(first: TradeStringParticipant, ...rest: TradeStringParticipant[]) {
  let seller = first;
  return rest.map((next, index) => {
    const contract = sale(index + 1, seller, next);
    seller = next;
    return contract;
  });
}

const codes = (contracts: TradeStringContract[]) =>
  validateTradeString(contracts).map((violation) => violation.code);

describe('validateTradeString', () => {
  describe('valid strings', () => {
    it('accepts an empty string, as on a newly created voyage', () => {
      expect(validateTradeString([])).toEqual([]);
    });

    it('accepts a direct sale from the exporter to the final buyer', () => {
      expect(validateTradeString(chain(exporter, buyer))).toEqual([]);
    });

    it('accepts several traders between them', () => {
      expect(validateTradeString(chain(exporter, meridian, lacustra, nordlys, buyer))).toEqual([]);
    });

    it('does not depend on the order contracts are supplied in', () => {
      expect(validateTradeString(chain(exporter, meridian, lacustra, buyer).reverse())).toEqual([]);
    });
  });

  describe('positions', () => {
    it('rejects a gap', () => {
      expect(codes([sale(1, exporter, meridian), sale(3, meridian, buyer)])).toEqual([
        'POSITIONS_NOT_CONTIGUOUS',
      ]);
    });

    it('rejects a string that does not start at 1', () => {
      expect(codes([sale(2, exporter, buyer)])).toEqual(['POSITIONS_NOT_CONTIGUOUS']);
    });

    it('rejects a repeated position', () => {
      expect(codes([sale(1, exporter, meridian), sale(1, meridian, buyer)])).toContain(
        'POSITIONS_NOT_CONTIGUOUS',
      );
    });
  });

  describe('counterparties', () => {
    it('rejects a sale to oneself', () => {
      expect(codes([sale(1, exporter, exporter)])).toContain('SAME_COUNTERPARTY');
    });

    it('rejects a sale between two roles of the same organization', () => {
      const sameOrganization = { ...meridian, organizationId: exporter.organizationId };
      expect(
        codes([sale(1, exporter, sameOrganization), sale(2, sameOrganization, buyer)]),
      ).toContain('SAME_COUNTERPARTY');
    });

    it.each([surveyor, agent])('rejects a $role as seller or buyer', (provider) => {
      expect(codes(chain(exporter, provider, buyer))).toEqual([
        'SERVICE_PROVIDER_COUNTERPARTY',
        'SERVICE_PROVIDER_COUNTERPARTY',
      ]);
    });
  });

  describe('shape', () => {
    it('rejects adjacent contracts that do not connect', () => {
      expect(codes([sale(1, exporter, meridian), sale(2, lacustra, buyer)])).toEqual([
        'DISCONNECTED',
      ]);
    });

    it('rejects a branch: one seller selling under two contracts', () => {
      expect(codes([sale(1, exporter, meridian), sale(2, exporter, buyer)])).toEqual(
        expect.arrayContaining(['BRANCH', 'DISCONNECTED']),
      );
    });

    it('rejects a branch: one buyer buying under two contracts', () => {
      expect(
        codes([
          sale(1, exporter, meridian),
          sale(2, meridian, lacustra),
          sale(3, nordlys, lacustra),
        ]),
      ).toEqual(expect.arrayContaining(['BRANCH', 'DISCONNECTED']));
    });

    it('rejects a cycle back to the exporter', () => {
      expect(codes([sale(1, exporter, meridian), sale(2, meridian, exporter)])).toEqual([
        'MUST_END_WITH_FINAL_BUYER',
        'CYCLE',
      ]);
    });

    it('rejects a cycle back to an earlier trader, who then buys twice', () => {
      expect(
        codes([
          sale(1, exporter, meridian),
          sale(2, meridian, lacustra),
          sale(3, lacustra, meridian),
        ]),
      ).toEqual(['MUST_END_WITH_FINAL_BUYER', 'BRANCH', 'CYCLE']);
    });

    it('rejects an organization reappearing under another role', () => {
      const meridianAsBuyer = party('Meridian', 'FINAL_BUYER');
      expect(codes(chain(exporter, meridian, lacustra, meridianAsBuyer))).toContain('CYCLE');
    });
  });

  describe('roles along the string', () => {
    it('rejects a string that does not start with the exporter', () => {
      expect(codes(chain(meridian, lacustra, buyer))).toEqual(['MUST_START_WITH_EXPORTER']);
    });

    it('rejects a string that does not end with the final buyer', () => {
      expect(codes(chain(exporter, meridian, lacustra))).toEqual(['MUST_END_WITH_FINAL_BUYER']);
    });

    it('rejects anyone but a trader between the ends', () => {
      const secondBuyer = party('Rhine', 'FINAL_BUYER');
      expect(codes(chain(exporter, secondBuyer, buyer))).toEqual([
        'INTERMEDIARY_MUST_BE_TRADER',
        'INTERMEDIARY_MUST_BE_TRADER',
      ]);
    });

    it('explains each violation with the contract position', () => {
      expect(validateTradeString(chain(meridian, buyer))).toEqual([
        {
          code: 'MUST_START_WITH_EXPORTER',
          position: 1,
          message: 'Contract 1: the seller must be the exporter, not a trader',
        },
      ]);
    });
  });
});

describe('toLinearTradeString', () => {
  it('orders contracts by position and parties along the chain, not by name', () => {
    const contracts = chain(exporter, nordlys, meridian, lacustra, buyer).reverse();

    const result = toLinearTradeString(contracts);

    expect(result.contracts.map((contract) => contract.position)).toEqual([1, 2, 3, 4]);
    expect(result.parties.map((p) => p.organizationId)).toEqual([
      'organization:Cerrado',
      'organization:Nordlys',
      'organization:Meridian',
      'organization:Lacustra',
      'organization:Bohai',
    ]);
  });

  it('returns no parties for an empty string', () => {
    expect(toLinearTradeString([])).toEqual({ contracts: [], parties: [] });
  });

  it('throws with every violation when the string is invalid', () => {
    const attempt = () => toLinearTradeString(chain(exporter, surveyor, buyer));

    expect(attempt).toThrow(InvalidTradeStringError);
    try {
      attempt();
    } catch (error) {
      expect((error as InvalidTradeStringError).violations).toHaveLength(2);
    }
  });
});
