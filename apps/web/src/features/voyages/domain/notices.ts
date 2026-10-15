import type { CounterpartyContract, CurrentUser, Notice } from '@tradeflow/contracts';

/*
 * Presentation rules for notices. The API decides who may do what (ADR 0011) and checks again on
 * every request; these only decide what to offer.
 */

export type NoticeState = 'AWAITING' | 'OVERDUE' | 'ACKNOWLEDGED' | 'ACKNOWLEDGED_LATE';

/** Overdue comes from the server (derived when it answered); lateness from the two instants. */
export function noticeState(notice: Notice): NoticeState {
  if (notice.status === 'ACKNOWLEDGED') {
    const late =
      notice.acknowledgedAt !== null &&
      Date.parse(notice.acknowledgedAt) > Date.parse(notice.acknowledgementDueAt);
    return late ? 'ACKNOWLEDGED_LATE' : 'ACKNOWLEDGED';
  }
  return notice.overdue ? 'OVERDUE' : 'AWAITING';
}

/** The contracts this user may issue notices under: the organization sells, the user operates. */
export function issuableContracts(
  identity: CurrentUser,
  contracts: readonly CounterpartyContract[],
): CounterpartyContract[] {
  return identity.user.role === 'OPERATOR'
    ? contracts.filter((contract) => contract.side === 'SELLER')
    : [];
}

/** Whether to offer acknowledging: the organization buys under it, the user operates, it waits. */
export const canAcknowledge = (identity: CurrentUser, notice: Notice): boolean =>
  identity.user.role === 'OPERATOR' &&
  notice.contract.side === 'BUYER' &&
  notice.status === 'ISSUED';

/** "Contract 2 · Lacustra Commodities SA → Nordlys Trading B.V." */
export const describeContract = (contract: CounterpartyContract): string =>
  `Contract ${contract.position} · ${contract.seller.name} → ${contract.buyer.name}`;
