# TradeFlow: local portfolio freeze

Date: **2026-11-26**. Implementation baseline: **`7141c1e`**. The commit containing this
document closes the local portfolio scope; its application, deployment and infrastructure
code is unchanged from that baseline.

The owner has frozen the project and will publish and verify it later. There is no active
deployment or feature task. An AWS account, region, domain and budget have not been selected.
The local freeze is complete independently of those future decisions.

## Show the project

Requires Node 24.11+, pnpm 11.9.0 and a running Docker daemon:

```sh
pnpm install --frozen-lockfile
pnpm demo:portfolio
```

Open the loopback URL printed by the command. The guided sign-in identifies the fictional
seller, buyer, viewer and outsider. The showcase includes missing documents, review pending,
rejection, replacement and approval; its Action Center links to the exact work to do.
Use separate browser profiles or a normal and a private window to show both counterparties.
Published demo credentials are for this disposable local environment only.

Stop with Ctrl+C or `q` and Enter. The run owns its PostgreSQL container, application servers,
uploads and temporary files; stopping it discards that dataset. Starting it again prepares
a fresh showcase and write budget. It does not use the development database or `.env` files.
The [demo guide](demo.md#the-portfolio-showcase-pnpm-demoportfolio) contains the walkthrough,
account roles, write-budget behavior and interrupted-run cleanup.

## Engineering case study

One physical cargo can pass through several sale contracts. Each counterparty needs a shared
view of the voyage, but its instructions, documents and decisions belong to its own contract.
TradeFlow makes those boundaries explicit instead of treating the shipment as one shared folder.

- **Full-stack contract:** a React SPA and NestJS modular monolith share runtime Zod schemas;
  PostgreSQL 18 and Prisma enforce the persisted model. Same-origin HTTP and server-side sessions
  keep authorization on the API. See [architecture](architecture.md) and [domain model](domain-model.md).
- **Privacy:** participation scopes voyage queries; contract counterparties alone see documents
  and instructions. An outsider receives the same 404 as for a missing resource. Viewer and
  operator permissions are checked for each command.
- **Concurrent writes:** `ETag`/`If-Match`, conditional database updates and immutable revisions
  prevent silent overwrites. Business writes and audit events commit together; database
  constraints preserve invariants when requests race.
- **Live UI:** one API process publishes type-only SSE invalidations. REST remains authoritative;
  reconnects refetch state and disconnected pages poll. This keeps the current system small,
  at the cost of no durable replay or delivery across API processes.
- **Private bytes:** local storage and S3-compatible adapters share a boundary. An interrupted or
  uncertain database commit does not justify deleting possibly referenced bytes. Reconciliation
  and a paired offline DB/object restore trade writer downtime for a consistent recovery point.
- **Operations:** production Docker targets, Caddy HTTPS, explicit proxy trust, bounded request
  diagnostics and log rotation are exercised locally. The AWS design uses one EC2 instance,
  private single-AZ RDS and private versioned S3, with SSM administration. Its availability and
  cost trade-offs are documented; real AWS behavior is still to be verified.

The [ADRs](decisions/) record alternatives and consequences. The project demonstrates application
architecture, transactions, browser state and operational boundaries.

## Delivered and deferred scope

| Area                       | Freeze status                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original product MVP       | Implemented: auth, participation/roles, voyages/trade string, notices, instructions, private versioned documents/review, timeline and live updates                               |
| Portfolio journey          | Implemented: guided accounts, showcase scenarios, document progress, Action Center, bounded writes and explicit local reset                                                      |
| Storage and operations     | Implemented: S3-compatible storage, paired recovery tools, production HTTPS mock and bounded request diagnostics                                                                 |
| Roadmap step 8             | Terraform foundation, offline tests, deployment contract and example cost worksheet delivered; provisioning decisions deferred                                                   |
| Roadmap step 9             | Verification suite, operator shell checks and local recovery rehearsal delivered; real hosted verification and AWS recovery deferred to the owner                                |
| Roadmap step 10            | Local case study, demo instructions, evidence boundaries and freeze handoff delivered; public URL, hosted evidence, showcase media and release publication deferred to the owner |
| Further product/cloud work | Frozen; see the deferred [roadmap](../README.md#roadmap) and [future directions](handoff.md#future-directions)                                                                   |

## Verification boundary

Independent review in this session verified the following on `7141c1e`, before this documentation
closeout, using Windows, Node 24.11.1, pnpm 11.9.0 and Docker Desktop. These are local results:

| Check                                    | Observed result                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm hosted:runbook-check`              | Passed: real PostgreSQL restore over verified TLS into the intended target despite conflicting host variables; root-only fixture stdin from a non-root sudo caller; reviewed broken commands fail; Docker state unchanged afterwards |
| `pnpm --filter @tradeflow/e2e test`      | 11 passed: input validation and deterministic READY timing/absence/old-document checks                                                                                                                                               |
| `pnpm hosted:rehearse-mock`              | 22 full-run and 8 restored-mode checks passed, including an actual API restart and guarded paired DB/object restore                                                                                                                  |
| Real-browser timing probe                | READY was observed before the visibility wait returned, with its return delayed by 100 ms; the formerly failing `restart.session` check passed                                                                                       |
| Local restore measurement                | 23.579 s from target creation to verified restored API, one approximately 6 MiB PDF; a local rehearsal measurement, not an AWS RTO                                                                                                   |
| `pnpm deploy:verify`                     | One production-container HTTPS scenario, all 8 steps passed                                                                                                                                                                          |
| Formatting, lint, typecheck, diff checks | Passed                                                                                                                                                                                                                               |

The documentation closeout also ran the portfolio and fresh-voyage smoke commands; their
results are recorded below. Existing implementation evidence stays in
[deployment mock](deployment-mock.md), [hosted verification](hosted-verification.md#review-fixes-2026-11-26)
and [MVP status](mvp-status.md). Historical full-suite and hosted CI results apply to the SHAs
named in those records. This documentation-only closeout does not rerun `pnpm check`, Terraform
mock tests or the storage suite, and does not turn earlier evidence into an exact-freeze CI pass.

## Limits of the frozen portfolio

- One API process, in-process SSE and sign-in admission, no broker/outbox or multi-instance guarantee.
- Demo writes share one allowance; an individual visitor can exhaust it. Reset is explicit,
  and the public-password demo is not configured for unrestricted public hosting.
- No account-management UI, password reset or SSO; no document virus scanner; orphan cleanup
  and paired backups remain operator tasks. PDF signature checking is not malware detection.
- Chromium automation and scripted walkthroughs provide local evidence; no human walkthrough,
  real AWS deployment, public ACME issuance or cloud restore has been established for this freeze.
- The example cost worksheet is dated and region-specific; it is not a selected budget.

## Resume for publication

1. Inspect `git status`, `git log` and the freeze commit; preserve local work. Verify Node/pnpm,
   install from the frozen lockfile and run `pnpm demo:portfolio` before preparing showcase media.
2. When ready to publish source, choose and push the intended commit explicitly. Run the existing
   hosted CI and record results on that exact SHA, including `verify`, `e2e`, `demo`, `storage`,
   `deploy` and `iac`. Until then, use the local evidence above and label historical CI by SHA.
3. Follow [the deployment gate](hosted-verification.md#deployment-gate-inputs-still-needed): select
   account/operator and maintenance identities, region, domain/DNS control, resource sizes and
   architecture, monthly budget and retention/backup decisions. Refresh official prices then.
4. Review the bootstrap plan before creating the state bucket, then review the main plan using
   the protected remote backend. Keep real inputs, credentials, state and saved plans out of Git.
   Build the existing images for the chosen architecture, retain release/rollback digests, and
   use the explicit migration and controlled-fixture operations in the runbook.
5. Run [hosted verification and paired recovery](hosted-verification.md), including the API
   restart and restore into separate empty targets. Save sanitized results in the
   [results template](hosted-verification-results.md). Only an observed pass completes step 9.
6. Add the actual public URL, screenshots/video and exact-SHA evidence when available. Publish
   the chosen tag/release and record the final deployment identifiers then. Broader product work
   requires a separate decision to reopen the freeze.

## Documentation closeout checks

Run on the documentation-only closeout over `7141c1e`, 2026-11-26:

| Check                        | Observed result                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm demo:portfolio:verify` | 3 Chromium tests passed, no retries (43.2 s): guided sign-in, 390 px layout, four document states, history/download hashes, viewer/outsider access and write-budget exhaustion |
| `pnpm demo:verify`           | 1 Chromium walkthrough passed, no retries (29.8 s): fresh voyage, trade string, instructions, rejected/replaced/approved document, queues and timeline                         |
| `pnpm format:check`          | Passed on the final documentation                                                                                                                                              |
| Local Markdown links         | 137 relative file/directory links and their referenced heading anchors checked; no failures                                                                                    |
| `git diff --check`           | Passed                                                                                                                                                                         |
| Cleanup                      | Both demo containers and their temporary directories were removed; the unrelated running container was left untouched                                                          |

Only `README.md`, this freeze record, `handoff.md` and `mvp-status.md` are changed in the
closeout. No application, test, dependency, migration or infrastructure configuration changes
are included. Account setup, push, workflow triggering and publication remain with the owner.
