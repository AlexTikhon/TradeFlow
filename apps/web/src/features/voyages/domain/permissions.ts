import type { CurrentUser } from '@tradeflow/contracts';

/**
 * Whether to offer voyage creation to this user. Only a convenience for the UI: the API checks
 * the role again, current at the time of the request, and answers 403 to anyone else.
 */
export const canCreateVoyages = (identity: CurrentUser): boolean =>
  identity.user.role === 'OPERATOR';
