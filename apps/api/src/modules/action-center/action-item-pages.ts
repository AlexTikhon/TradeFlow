import {
  ACTION_ITEM_KEY_MAX_LENGTH,
  type ActionItem,
  type ActionItemPage,
  type ActionItemType,
} from '@tradeflow/contracts';
import { z } from 'zod';
import {
  type ActionItemPosition,
  type ContractFacts,
  comparePositions,
  positionOf,
  projectActionItems,
} from './action-items.js';

/*
 * Pages of the Action Center (ADR 0017): filters, then keyset pagination over the page order of
 * `action-items.ts`. A cursor is the position of the last action served, nothing more: each page
 * is projected again from the facts as they are when it is requested, so a page reflects the
 * records then, not a snapshot taken on the first page.
 */

export interface ActionItemFilters {
  type?: ActionItemType | undefined;
  /** Only overdue actions; only notices can be. */
  overdue?: true | undefined;
}

export interface ActionItemPageRequest extends ActionItemFilters {
  /** Actions strictly after this position; the first page when absent. */
  after?: ActionItemPosition | undefined;
  limit: number;
}

const matches = (item: ActionItem, { type, overdue }: ActionItemFilters): boolean =>
  (type === undefined || item.type === type) &&
  (overdue === undefined || (item.type === 'ACKNOWLEDGE_NOTICE' && item.overdue));

/** One page of `items` (in any order) for `request`, built at `generatedAt`. */
export function pageActionItems(
  items: readonly ActionItem[],
  { after, limit, ...filters }: ActionItemPageRequest,
  generatedAt: Date,
): ActionItemPage {
  const following = items
    .map((item) => ({ item, position: positionOf(item) }))
    .filter(({ item }) => matches(item, filters))
    .filter(({ position }) => !after || comparePositions(position, after) > 0)
    .sort((a, b) => comparePositions(a.position, b.position));
  const served = following.slice(0, limit);
  const last = served.at(-1);
  return {
    items: served.map(({ item }) => item),
    generatedAt: generatedAt.toISOString(),
    nextCursor: following.length > limit && last ? encodeActionItemCursor(last.position) : null,
  };
}

/** The organization's page for `request`, projected from `contracts` as of `now`. */
export const actionItemPage = (
  contracts: readonly ContractFacts[],
  organizationId: string,
  request: ActionItemPageRequest,
  now: Date,
): ActionItemPage =>
  pageActionItems(projectActionItems(contracts, organizationId, now), request, now);

/*
 * Cursors are the last served position as base64url JSON. They carry nothing the reader did not
 * just receive, and need no signature: the organization's scope is applied to every page, so a
 * cursor made up by hand can only move within what its bearer may see anyway.
 */
const CursorSchema = z.tuple([
  z.union([z.literal(0), z.literal(1)]),
  z.iso.datetime(),
  z.string().min(1).max(ACTION_ITEM_KEY_MAX_LENGTH),
]);

export function encodeActionItemCursor({ dated, at, key }: ActionItemPosition): string {
  return Buffer.from(JSON.stringify([dated ? 1 : 0, at.toISOString(), key])).toString('base64url');
}

/**
 * The position a cursor names, or null for a cursor the API did not produce. The endpoint
 * answers null with a 400 before reading anything, the same for every organization.
 */
export function decodeActionItemCursor(cursor: string): ActionItemPosition | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = CursorSchema.safeParse(decoded);
  if (!parsed.success) {
    return null;
  }
  const [dated, at, key] = parsed.data;
  return { dated: dated === 1, at: new Date(at), key };
}
