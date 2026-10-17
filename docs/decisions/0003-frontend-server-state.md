# 0003. Server state in TanStack Query; no global client store yet

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

Nearly all data in TradeFlow is server-owned: voyages, participants, and later notices, documents
and tasks. Several organizations edit the same voyage, so data goes stale, needs refetching,
invalidation after mutations, and (later) live updates via SSE. A common failure in React
codebases is copying API responses into a global store (Redux, Zustand) and then hand-writing
loading flags, caching, deduplication and invalidation.

## Decision

- **Server state:** TanStack Query only. Each feature exposes query-option factories with
  hierarchical keys (`voyageQueries.list(filters)`, `voyageQueries.detail(id)`).
- **Shareable UI state** (filters, selected tab): the **URL**, validated with contract schemas.
- **Local UI state:** component state.
- **Global client-owned state:** none today. Zustand will be introduced only for state that is
  genuinely client-owned and shared across distant components (for example an "acting as
  organization" switcher, or a multi-step document review session), never for API data.

## Alternatives considered

- **Redux Toolkit plus RTK Query.** A capable combination, but it brings a global store we do not
  need yet. RTK Query's cache model is comparable to TanStack Query's; TanStack Query integrates
  more directly with per-feature query factories.
- **Zustand or Redux for API data.** Rejected: re-implements caching and staleness badly.
- **React Router loaders as the data layer.** Good for initial page data, but weaker for
  background refetching, polling, mutations and SSE-driven invalidation. Loaders can still call
  `queryClient.ensureQueryData` later for prefetching on navigation.

## Consequences

- Filter state survives reloads, works with back and forward, and can be shared as a link.
- SSE signals map to `invalidateQueries` on the exact keys they affect, under the current
  identity scope (today the notices, documentary instructions, documents and timeline of one
  voyage; [ADR 0015](0015-voyage-event-streams.md)).
- Teams must resist "just put it in the store". This ADR is the reference.
