import { describe, expect, it } from 'vitest';
import {
  candidateTradeString,
  failedSetupPrecondition,
  tradeStringFieldErrors,
} from './trade-string-setup.js';
import { type TradeStringParticipant, validateTradeString } from './trade-string.js';

const exporter: TradeStringParticipant = {
  participantId: 'participant:Cerrado',
  organizationId: 'organization:Cerrado',
  role: 'EXPORTER',
};

describe('candidateTradeString', () => {
  it('sells straight from the exporter to a final buyer', () => {
    const { parties, contracts } = candidateTradeString(exporter, ['organization:Rhine']);

    expect(parties).toEqual([
      exporter,
      { participantId: 'provisional-1', organizationId: 'organization:Rhine', role: 'FINAL_BUYER' },
    ]);
    expect(contracts).toEqual([{ position: 1, seller: parties[0], buyer: parties[1] }]);
    expect(validateTradeString(contracts)).toEqual([]);
  });

  it('makes everyone between the exporter and the last organization a trader', () => {
    const { parties, contracts } = candidateTradeString(exporter, [
      'organization:Lacustra',
      'organization:Nordlys',
      'organization:Rhine',
    ]);

    expect(parties.map(({ organizationId, role }) => [organizationId, role])).toEqual([
      ['organization:Cerrado', 'EXPORTER'],
      ['organization:Lacustra', 'TRADER'],
      ['organization:Nordlys', 'TRADER'],
      ['organization:Rhine', 'FINAL_BUYER'],
    ]);
    expect(
      contracts.map(({ position, seller, buyer }) => [
        position,
        seller.organizationId,
        buyer.organizationId,
      ]),
    ).toEqual([
      [1, 'organization:Cerrado', 'organization:Lacustra'],
      [2, 'organization:Lacustra', 'organization:Nordlys'],
      [3, 'organization:Nordlys', 'organization:Rhine'],
    ]);
    // Each contract's buyer is the next one's seller: the same participant, not a copy.
    expect(contracts[1]?.seller).toBe(contracts[0]?.buyer);
    expect(new Set(parties.map(({ participantId }) => participantId)).size).toBe(4);
    expect(validateTradeString(contracts)).toEqual([]);
  });

  it('leaves the rules to the validation: an organization named twice is a cycle', () => {
    const { contracts } = candidateTradeString(exporter, [
      'organization:Lacustra',
      'organization:Cerrado',
      'organization:Rhine',
    ]);

    expect(validateTradeString(contracts).map(({ code }) => code)).toContain('CYCLE');
  });

  it('keeps the participation’s own role, so a participant that is not the exporter fails', () => {
    const { contracts } = candidateTradeString({ ...exporter, role: 'TRADER' }, [
      'organization:Rhine',
    ]);

    expect(validateTradeString(contracts).map(({ code }) => code)).toEqual([
      'MUST_START_WITH_EXPORTER',
    ]);
  });
});

describe('tradeStringFieldErrors', () => {
  it('reports every violation against the parties as named', () => {
    expect(
      tradeStringFieldErrors([
        { code: 'CYCLE', message: 'The trade string loops' },
        { code: 'BRANCH', message: 'The trade string branches' },
      ]),
    ).toEqual([
      { path: 'body.parties', message: 'The trade string loops' },
      { path: 'body.parties', message: 'The trade string branches' },
    ]);
  });
});

describe('failedSetupPrecondition', () => {
  const tags = (...values: string[]) => ({ kind: 'tags' as const, tags: values });
  const any = { kind: 'any' as const };

  it('holds without any precondition', () => {
    expect(failedSetupPrecondition({})).toBeNull();
  });

  it('holds for If-Match: *, since the trade string always exists', () => {
    expect(failedSetupPrecondition({ ifMatch: any })).toBeNull();
  });

  it('fails for If-Match with entity tags, since the trade string has none', () => {
    expect(failedSetupPrecondition({ ifMatch: tags('"1"') })).toMatch(/^If-Match names/);
    expect(failedSetupPrecondition({ ifMatch: tags('W/"1"', '"2"') })).toMatch(/^If-Match/);
  });

  it('fails for If-None-Match: *, since the trade string always exists', () => {
    expect(failedSetupPrecondition({ ifNoneMatch: any })).toMatch(/^If-None-Match: \*/);
  });

  it('holds for If-None-Match with entity tags, since none can match', () => {
    expect(failedSetupPrecondition({ ifNoneMatch: tags('"1"') })).toBeNull();
  });

  it('evaluates If-Match first', () => {
    expect(failedSetupPrecondition({ ifMatch: tags('"1"'), ifNoneMatch: any })).toMatch(
      /^If-Match/,
    );
    expect(failedSetupPrecondition({ ifMatch: any, ifNoneMatch: any })).toMatch(/^If-None-Match/);
  });
});
