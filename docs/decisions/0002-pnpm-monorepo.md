# 0002. pnpm workspace monorepo

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

The frontend and backend change together: almost every feature touches the API contract, the
API and the UI in the same change. We want one pull request per feature, one CI pipeline, and a
shared contract package without publishing to a registry.

## Decision

A single repository using **pnpm workspaces** with `apps/api`, `apps/web` and
`packages/contracts`.

- Exact dependency versions plus a committed lockfile.
- Root scripts orchestrate (`pnpm -r`). `pnpm codegen` builds the contracts package and generates
  the Prisma client before typecheck, lint, test and dev.
- Supply-chain settings in `pnpm-workspace.yaml`: dependency install scripts are denied unless
  allow-listed (`allowBuilds`), and pnpm's release-age quarantine is respected rather than bypassed.
  Auto-installed peers are pinned with `overrides` where they would otherwise pull a just-published
  version.

## Alternatives considered

- **Separate repositories.** Contract changes would need a published package and coordinated
  releases. That is too much ceremony for one team.
- **Nx or Turborepo.** Task caching and affected-project detection pay off with many packages and
  slow builds. With three packages and builds measured in seconds, they would be configuration
  without benefit. Turborepo can be added later without restructuring.
- **npm or Yarn workspaces.** Workable. pnpm's strict `node_modules` (no phantom dependencies),
  speed and install-script controls tipped the balance.

## Consequences

- One `pnpm install`, one CI workflow, atomic cross-cutting changes.
- `contracts` must be built before consumers typecheck. Root scripts handle this. A "live types"
  setup (custom export conditions pointing at source) could remove the step if it becomes a
  nuisance.
- Every package uses the same TypeScript base config (`tsconfig.base.json`, strict plus
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`).
