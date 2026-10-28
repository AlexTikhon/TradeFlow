# Demo: one voyage, seller and buyer side by side

A walkthrough of about ten minutes on seeded voyage **TF-2026-0001**, with the seller and the
buyer under its first sale contract in two isolated browser profiles. It shows each MVP flow
once, explains what it means for the business, and what the system guarantees while it happens.
A second walkthrough, [on a fresh voyage](#walkthrough-2-a-fresh-voyage), starts from nothing:
the exporter creates a voyage and sets up its trade string in the app, then the same flows run
under the contract that setup recorded. A third, [the Action Center in three
minutes](#walkthrough-3-the-action-center-in-three-minutes), is the short one for an interview:
each side's queue leads to the exact record, the decision there changes the counterparty's
queue. What is implemented and how it is verified: [MVP status](mvp-status.md).

> **Verification status.** On 2026-10-18 all six steps were driven through the real web UI in
> Chromium by a script (Playwright, two isolated browser contexts) against a throwaway database,
> and the expectations below are what that run observed. See
> [Walkthrough record](#walkthrough-record). **No person has run this demo yet.** The scripted run
> proves the flows, the wording and the live updates, but not the pacing, the native file and
> download dialogs, or how it reads to an audience.
>
> **The fresh-voyage walkthrough (steps F1 to F8)** is automated: `pnpm demo:verify` drives it
> through the UI in headless Chromium against a fresh `pnpm demo` instance on the real seed. On
> 2026-10-28 it passed twice, from two independently fresh runs
> ([automated runs](#automated-runs-of-walkthrough-2)); its expectations below are what those
> runs observed. **No person has run it yet**: its [human record](#record-of-walkthrough-2) is
> empty. Until that date its expectations came from the code and ADR 0016 only.
>
> **The Action Center walkthrough (steps A1 to A5)** was driven once by a script on 2026-10-23,
> setup included, and its expectations are what that run observed
> ([record](#record-of-walkthrough-3)). No person has run it yet.

## Starting the demo: `pnpm demo`

One command starts a complete, isolated demo, and stopping it throws everything away.

**Prerequisites.** Node.js ≥ 24.11, pnpm 11, `pnpm install` run once, and a running Docker
daemon (Docker Desktop on Windows). Nothing else: no `.env` file, no `pnpm db:up`, no database.
The first run pulls the `postgres:18-alpine` image if Docker does not have it yet.

```bash
pnpm demo
```

The same command in PowerShell, cmd or a Linux shell. It prints each step, then where to go:

1. Creates a PostgreSQL 18 container of its own, `tradeflow-demo-<random>`, labelled
   `io.tradeflow.demo.run`. Its data lives on a tmpfs inside the container (no volume). Its port
   is published on 127.0.0.1 only, at a port Docker picks.
2. Creates a temporary directory, `tradeflow-demo-<random>` in the system temp directory, for the
   builds, the uploaded documents and the server logs.
3. Compiles the API and builds the web app into that directory. `apps/api/dist`, `apps/web/dist`
   and `.env` files are not written. (Like `pnpm test:e2e`, it first runs `pnpm codegen`.)
4. Applies every migration with `prisma migrate deploy`, then runs the real demo seed
   (`apps/api/prisma/seed.ts`).
5. Starts the API and the web app (`vite preview` of the production build, whose same-origin
   `/api` proxy forwards to the API), both on 127.0.0.1, on free ports.
6. Waits until the web app answers through its proxy, then prints the address to open, the
   accounts, the walkthrough, what it owns, and how to stop.

**Every run starts fresh, and nothing is kept.** The database, the uploaded PDFs, the builds and
the logs exist only while the demo runs, and are discarded when it stops. The demo never reads
`DATABASE_URL`, from your environment or from `apps/api/.env`: it removes the app's variables
from what it passes on and sets each one itself. It never connects to, resets, seeds, stops or
removes the development (`tradeflow`) or test databases, other containers or volumes, or a
running `pnpm dev`.

**Configuration.** The API runs with its normal sign-in and sessions, and with sign-in admission
at its production defaults (20 attempts per client address a minute, 4 at once;
[ADR 0018](decisions/0018-sign-in-admission.md)). Every browser on the machine reaches the API
through the one web-server proxy, so they share that budget; a walkthrough needs a handful of
sign-ins. One setting is explicit for local HTTP: `NODE_ENV=development`, because in production
the session cookie is `Secure`, under a `__Host-` name, and a browser never sends it back over
plain HTTP. This is a local demo, not a check of a deployment.

**Accounts.** Every seeded user's password is `tradeflow-demo`. The banner lists the four of
[walkthrough 2](#walkthrough-2-a-fresh-voyage): Ana Souza (`ana.souza@cerrado-graos.example`,
seller), Tan Wei Ling (`wei.ling.tan@meridianagri.example`, buyer), Emre Kaya
(`emre.kaya@anatoliamills.example`, final buyer in F8) and Lucía Ferreyra
(`lucia.ferreyra@pampalitoral.example`, outsider). The casts below list the others. Use two
browser profiles (or a normal and a private window), one per signed-in user. The address
changes with every run: open the one printed, not `localhost:5173`.

**Stopping.** Press **Ctrl+C** in the demo's terminal, or type `q` and press Enter. The demo
stops the API and the web server, removes its container (`docker rm --force --volumes`) and its
temporary directory, and says what it removed ("Stopped. Removed container …"). A second Ctrl+C
while it cleans up changes nothing; every wait is bounded. On Windows, pnpm itself exits at the
Ctrl+C, so the prompt can come back a few seconds before the demo prints its last lines: the
cleanup carries on and finishes regardless (observed; see the
[automated runs](#automated-runs-of-walkthrough-2)). A failed startup, or a server exiting on its own while the demo
runs, ends the same way: the last lines of the failing step's log are printed first, since the
logs go with the directory.

**If cleanup fails, or the demo is killed** before it can clean up (Task Manager, `kill -9`, a
crash): what is left keeps running. The banner printed at startup lists the run's container,
directory and process ids, with the command that removes each. A cleanup failure prints the same
commands for what it could not remove. Without the banner:

- **Container.** `docker ps --all --filter label=io.tradeflow.demo.run` lists demo containers.
  Check the name, then `docker rm --force --volumes tradeflow-demo-<random>`.
- **Processes.** Two `node` processes, one running `…/tradeflow-demo-<random>/api/dist/main.js`
  (the API) and one running `vite.js preview` with that directory's `web` folder. Stop those two
  by process id (`taskkill /PID <id> /F`, or `kill <id>`). Never stop node processes by name: a
  `pnpm dev` or your editor may be among them.
- **Directory.** `tradeflow-demo-<random>` in `%TEMP%` (Windows) or `$TMPDIR`, usually `/tmp`
  (Linux). Remove its link `api/node_modules` first, if it is still there, then the directory.
  In cmd: `(if exist "<dir>\api\node_modules" rmdir "<dir>\api\node_modules") & rmdir /s /q "<dir>"`.
  On Linux: `rm -f <dir>/api/node_modules && rm -rf <dir>`. Do not use Windows PowerShell 5.1's
  `Remove-Item -Recurse` while the link exists: it can follow the link into the repository's
  `apps/api/node_modules`.

### The automated walkthrough: `pnpm demo:verify`

Starts a demo with the same code as `pnpm demo`, drives
[walkthrough 2](#walkthrough-2-a-fresh-voyage) through it in headless Chromium, then stops it and
removes everything, pass or fail. It needs Playwright's Chromium once per machine:
`pnpm --filter @tradeflow/e2e exec playwright install chromium`. On failure, a screenshot is
kept in `e2e/.output/demo/` (ignored by Git). CI runs the same command as its `demo` job, on
Linux, and uploads that directory as `demo-diagnostics` when the walkthrough fails; which
commits it has run on is recorded in [MVP status](mvp-status.md#verification-at-a-glance).

```bash
pnpm demo:verify
```

It is a test, not a person: see [what it proves](#automated-runs-of-walkthrough-2), and what it
does not.

## Cast

Every seeded user's password is `tradeflow-demo`.

| Profile        | User           | Email                                 | Organization                   | On TF-2026-0001                   | User role |
| -------------- | -------------- | ------------------------------------- | ------------------------------ | --------------------------------- | --------- |
| **S** (seller) | Ana Souza      | `ana.souza@cerrado-graos.example`     | Cerrado Grãos Exportadora S.A. | Exporter; seller under contract 1 | Operator  |
| **B** (buyer)  | Claire Morel   | `claire.morel@lacustra.example`       | Lacustra Commodities SA        | Trader; buyer under contract 1    | Operator  |
| B, step 6      | Lucía Ferreyra | `lucia.ferreyra@pampalitoral.example` | Pampa Litoral Agroexport S.A.  | Not a participant                 | Operator  |
| B, optional    | Jonas Weber    | `jonas.weber@lacustra.example`        | Lacustra Commodities SA        | Claire's colleague                | Viewer    |

Claire's organization is also the **seller** under contract 2 (to Nordlys). Her panels therefore
show two contract blocks, and she has an **Issue ETA notice** button of her own (for contract 2).
Everything in this demo happens in the block headed
**Contract 1 · Cerrado Grãos Exportadora S.A. → Lacustra Commodities SA**.

## Before you start (not part of the ten minutes)

**The simplest setup is [`pnpm demo`](#starting-the-demo-pnpm-demo)**: a fresh, migrated and
seeded database every time, so items 1 to 3 below are done for you. Open the address it prints
instead of `localhost:5173` (in item 6, replace `http://localhost:5173` with it). This first
walkthrough has not yet been run on a `pnpm demo` instance, by a script or a person. Items 1 to 3
describe the alternative, on your development database:

1. **Database.** `pnpm db:up`, then apply any pending migrations without touching data:
   `pnpm --filter @tradeflow/api db:deploy` (`prisma migrate deploy`, which only applies
   migrations). This walkthrough needs the first twelve migrations: documents and reviews arrive
   in the ninth to the twelfth. The [fresh-voyage walkthrough](#walkthrough-2-a-fresh-voyage)
   needs all fourteen: the last two are ADR 0016's. On 2026-10-18 the local development database
   had only the first eight, so it could not yet run steps 5 and 6. `pnpm db:migrate` (`prisma migrate dev`) also applies them, but it can
   offer to reset a database it finds drifted. To keep your development data out of it entirely,
   use a database of your own instead: see [An isolated run](#an-isolated-run).
2. **Data.** The demo does not need a fresh seed. It needs the seeded users and voyages, and no
   documentary instructions yet under TF-2026-0001's contract 1. To check, open the voyage as
   Claire: the contract 1 block should read "Your organization has not given documentary
   instructions under this contract yet." If it shows a revision instead, see
   [Running it again](#running-it-again).
3. **Servers.** `pnpm dev`. The web app is on <http://localhost:5173> and the API on port 3000;
   the browser talks only to the web origin, which proxies `/api`.
4. **Two isolated profiles.** Use two Chromium-based browser profiles, or one normal window and
   one Incognito/InPrivate window. Each has its own cookie jar, so each holds its own session,
   like two people on two machines. Tabs of one profile share a session. Put the two windows side
   by side. Chromium is the only browser the automated suite and the scripted walkthrough used.
5. **Two PDFs**, for example `bl-v1.pdf` and `bl-v2.pdf`: any real PDF up to 10 MiB, such as a
   page printed to PDF. For the optional signature check in step 5, also a plain text file
   renamed to `not-a-pdf.pdf`.
6. **Sign in.** In both profiles, open
   <http://localhost:5173/voyages/01990000-0000-7000-8006-000000000001> (the seeded id is fixed).
   You are sent to sign in: Ana in profile S, Claire in profile B. Afterwards you land back on
   the voyage.

### An isolated run

[`pnpm demo`](#starting-the-demo-pnpm-demo) now does all of this, and cleans up after itself. The
manual steps are kept because the walkthrough records of 2026-10-18 and 2026-10-23 used them.

The API and Prisma read `apps/api/.env`, but variables already set in the environment take
precedence over it. To run the demo against a database and document directory of its own, as the
scripted walkthrough did, create an empty database on the same PostgreSQL server (for example
`CREATE DATABASE tradeflow_demo;`), then pass the same values to every process, the seed
included. After `pnpm codegen` (which `pnpm dev` would otherwise run), in Git Bash, from
`apps/api`:

```bash
export DATABASE_URL=postgresql://tradeflow:tradeflow@localhost:5433/tradeflow_demo
export DOCUMENT_STORAGE_DIR=/path/to/demo-documents
pnpm exec prisma migrate deploy
pnpm exec prisma db seed
PORT=3471 pnpm exec nest start --watch     # the API, on a port of its own
```

and, in another shell, from `apps/web`:
`API_PROXY_TARGET=http://localhost:3471 pnpm exec vite --port 5471 --strictPort`. Open
`http://localhost:5471` instead of 5173. Afterwards, stop both and drop the database.

## The walkthrough

| Step | Flow                                                   | Time   |
| ---- | ------------------------------------------------------ | ------ |
| 1    | Voyage access and trade-string visibility              | 1½ min |
| 2    | ETA notice issued and acknowledged, live               | 1½ min |
| 3    | Documentary instructions given, acknowledged, revised  | 2 min  |
| 4    | A stale draft, and explicit recovery                   | 1½ min |
| 5    | PDF upload, download, approval, replacement, rejection | 2½ min |
| 6    | Audit timeline and a non-participant access check      | 1 min  |

The times are a plan; nobody has timed a spoken run yet. From step 2 on, **do not reload either
page**. Every change on the other side arrives by itself, within a fraction of a second. That is
part of what the demo shows.

### 1. Voyage access and the trade string

**Do.** In each profile, click **Voyages** in the breadcrumb, then go back to TF-2026-0001.

**Expect.**

- Ana's list shows TF-2026-0007, 0002 and 0001; Claire's shows TF-2026-0005, 0003 and 0001.
  Each sees only the voyages its organization takes part in. Both have a **New voyage** button.
- On TF-2026-0001, both see the same **Trade string**: Cerrado Grãos (Exporter) → Contract 1 →
  Lacustra (Trader) → Contract 2 → Nordlys (Trader) → Contract 3 → Rhine Valley Crushers
  (Final buyer). Each sees its own organization marked "Your organization".
- **Participating organizations** lists the four trade parties, and separately the surveyor and
  the shipping agent, who are not in the string. The **Shipment** card shows the voyage's total
  quantity (50,000 MT). No contract's price, quantity or terms appear anywhere.

**Business meaning.** One physical cargo is sold several times. Everyone working on it needs to
know who sits where in the chain, but a party's commercial terms are its own business.

**Engineering guarantee.** Access follows participation: every voyage query is filtered by the
caller's organization, and a non-participant gets the same 404 as for a voyage that does not
exist ([ADR 0006](decisions/0006-participation-based-access.md)). The trade-string response
carries topology only, validated as one linear chain
([ADR 0010](decisions/0010-trade-string-visibility.md)).

**Evidence.** PostgreSQL/HTTP: `voyages.int-spec.ts`, `trade-string.int-spec.ts`. jsdom:
`VoyageListPage.test.tsx`, the trade-string tests in `VoyageDetailsPage.test.tsx`. Chromium
suite: none for the list or the string. Scripted walkthrough: exercised.

### 2. An ETA notice, issued and acknowledged

**Do (Ana).** In **ETA notices**, click **Issue ETA notice**. The contract is preselected
(Contract 1 · Cerrado Grãos Exportadora S.A. → Lacustra Commodities SA). Enter an
**Estimated arrival** three days ahead and an **Acknowledge by** time tomorrow. The deadline
must be in the future and not after the arrival; the form names the browser's time zone. Add a
message such as `Demo: ETA Rotterdam confirmed`, then click **Issue notice**.

**Expect.** Ana sees "Your ETA notice to Lacustra Commodities SA has been issued." Without a
reload, Claire's panel shows the new notice, marked **Awaiting acknowledgement** and
**Sent to you**. Her timeline gains "Issued a notice" by Ana Souza, for contract 1.

**Do (Claire).** Click **Acknowledge receipt** on that notice.

**Expect.** On Claire's side the notice becomes **Acknowledged**. On Ana's side, without a
reload, it shows "… by Claire Morel (Lacustra Commodities SA)", and her timeline gains
"Acknowledged receipt of a notice".

Claire also sees two seeded notices: Cerrado's on contract 1 (acknowledged) and her own on
contract 2 (sent by her, awaiting Nordlys). Their times are relative to when the seed last ran,
so on an older seed the one awaiting acknowledgement shows as **Overdue**. Overdue is derived
from the deadline and the current time, not stored.

**Business meaning.** The seller tells its buyer when the vessel is expected; the buyer confirms
receipt (not acceptance of anything) by a deadline. Only those two organizations see it.

**Engineering guarantee.** An issued notice cannot change. The acknowledgement is one
conditional update, so two racing acknowledgements end in one success and one 409. Each command
and its audit event commit in one transaction
([ADR 0011](decisions/0011-counterparty-notices.md),
[ADR 0009](decisions/0009-transactional-audit-events.md)). After commit, the API pushes a signal
carrying only its type (`NOTICE_ISSUED`) over the voyage's event stream, and only to the
contract's two counterparties. The page then re-reads notices and the timeline over REST
([ADR 0015](decisions/0015-voyage-event-streams.md)).

**Evidence.** Chromium suite: `live-notices.spec.ts`, the same flow between two browser
contexts, proving from the network log that the stream message (not polling) caused the
refresh. PostgreSQL/HTTP: `notices.int-spec.ts` (roles, outsiders, race, audit rollback) and
`voyage-events.int-spec.ts`. jsdom: `VoyageNotices.test.tsx`. Scripted walkthrough: exercised,
including the stream message and the two re-reads on the receiving page.

### 3. Documentary instructions: given, acknowledged, revised

**Do (Claire).** In **Documentary instructions**, in the contract 1 block (chip "You buy: you
give them"), click **Give documentary instructions**. Fill in:

- **Consignee:** `To order of Banco Demo`
- **Required document 1:** **Document** Bill of lading (the list starts at "Select…"),
  **Originals** 3, **Copies** 2 (both start empty)

Click **Send instructions**.

**Expect.** Claire sees "Revision 1 has been sent to Cerrado Grãos Exportadora S.A. for
acknowledgement." Ana's page shows revision 1, **Not acknowledged**, with a button
**Acknowledge receipt of revision 1**, and already a **Documents** section with an upload form
for the bill of lading: uploading does not wait for the acknowledgement. Both timelines gain
"Gave documentary instructions".

**Do (Ana).** Click **Acknowledge receipt of revision 1**.

**Expect.** Both pages show **Acknowledged by the seller**, with Ana's name. The timelines gain
"Acknowledged revision 1 of the documentary instructions".

**Do (Claire).** Click **Revise instructions**, change the consignee to
`To order of Banco Demo, Rotterdam branch`, and click **Send revision 2**.

**Expect.** Ana's page shows revision 2, **Not acknowledged**, with revision 1 kept under
**Earlier revisions (1)**. The timelines gain "Revised the documentary instructions (revision 2)".
**Leave revision 2 unacknowledged** for step 4.

**Business meaning.** The buyer tells its seller whom the shipping documents must name and which
documents to present. The seller confirms receipt of an exact revision. A change is a new
revision that needs a new acknowledgement, so nobody can claim the old wording was confirmed for
the new.

**Engineering guarantee.** Revisions are immutable, and the database rejects changes to them.
Every write is a single conditional SQL statement carrying the version the client read
(`If-Match`). A stale version gets 412 and a missing precondition 428. A race therefore ends in
one success and one 412, never a lost update
([ADR 0012](decisions/0012-documentary-instructions.md)).

**Evidence.** Chromium suite: the first test in `live-instructions.spec.ts` (the same give,
acknowledge and revise sequence across two contexts). PostgreSQL/HTTP:
`documentary-instructions.int-spec.ts`, including four real races on held row locks. jsdom:
`VoyageDocumentaryInstructions.test.tsx`. Scripted walkthrough: exercised.

### 4. A stale draft, and explicit recovery

**Do (Claire).** Click **Revise instructions**. In **Notify party (optional)**, type
`Lacustra Commodities SA, attn. execution desk`. **Do not send.**

**Do (Ana).** Click **Acknowledge receipt of revision 2**.

**Expect (Claire, without touching anything).** Above her draft appears a warning, **The
instructions have changed**: "The seller (Ana Souza) acknowledged revision 2 after you started
this draft. Your draft below is kept as you wrote it; review the latest version, then base your
draft on it before sending." Inside it, revision 2 is shown as acknowledged. The notify party she
typed is still there. **Send revision 3** is disabled, with the hint "Review the latest version
above before sending." Nothing has been sent.

**Do (Claire).** Click **Base my draft on revision 2**, then **Send revision 3**.

**Expect.** The warning disappears and the draft is unchanged. After sending: "Revision 3 has
been sent to Cerrado Grãos Exportadora S.A. for acknowledgement." Ana's page shows revision 3,
**Not acknowledged**, with the new notify party. Ana may acknowledge it; step 5 does not depend
on it.

**Business meaning.** An acknowledgement changes what the buyer is revising: sending a new
revision now resets something the seller has just confirmed. The buyer gets to see that before
deciding, and loses none of the typing.

**Engineering guarantee.** A draft remembers the version it started from, and a background
refresh never moves that basis. The acknowledgement advanced the instruction's version, so the
draft is stale, and the form refuses to send it until the user explicitly re-bases it. Nothing
is re-sent automatically. Had Claire sent the draft in the instant before the push arrived, the
server would have answered 412. The form then shows **Not sent** ("The instructions changed after
you started this draft. Your draft is kept.") with **Review the latest version**, leading to the
same re-base.

**Evidence.** Scripted walkthrough: exercised in Chromium, the acknowledgement arriving over the
real stream into the open draft. No write was sent until the re-base, then exactly one `PUT`.
This exact path is not in the Chromium suite, whose second `live-instructions.spec.ts` test
pushes a colleague's revision instead. jsdom: in `VoyageDocumentaryInstructions.test.tsx`, "shows
a newer version that a refresh brings in, before anything is sent" (this acknowledgement case)
and the 412 tests. **Not exercised in a browser:** the 412 path, because the push normally wins
the race.

### 5. Documents: upload, download, approval, replacement and rejection

The documents of the current revision appear inside the contract 1 block, under the revision.
Revision 3 requires a bill of lading, which shows **Not uploaded yet**.

**Optional (+20 s): the signature check.** At **Bill of lading**, click **Choose a PDF**, pick
`not-a-pdf.pdf` (text renamed to `.pdf`), then **Upload**. The browser accepts it, because it
judges by the extension. The server refuses it: "The file is not a PDF: a PDF file starts with
"%PDF-"." The file stays chosen; nothing is recorded or kept.

**Do (Ana).** At **Bill of lading**, click **Choose a PDF**, pick `bl-v1.pdf`, then **Upload**.

**Expect.** "Version 1 of the bill of lading has been uploaded." Claire's page shows
"Version 1: bl-v1.pdf (size)", who uploaded it and when, the first 12 characters of its SHA-256,
**Pending review**, and "Pending review by Lacustra Commodities SA". Her timeline gains
"Uploaded version 1 of the bill of lading (instructions revision 3)".

**Do (Claire).** Click **Download** next to version 1. The browser saves `bl-v1.pdf`. To compare
it with the uploaded file, run `Get-FileHash bl-v1.pdf` (PowerShell) or `sha256sum bl-v1.pdf`.
The result starts with the checksum the page shows. Then, under "Your decision on version 1",
select **Approve**: the **Record decision** button becomes **Approve version 1**. Click it.

**Expect.** "Version 1 of the bill of lading has been approved." Ana's page shows "Approved by
Claire Morel (Lacustra Commodities SA) on …".

**Do (Ana).** Choose `bl-v2.pdf`; the button now reads **Upload as version 2**. Click it.

**Expect.** Claire's page shows version 2, **Pending review**. Under **Earlier versions (1)**,
version 1 still carries its approval.

**Do (Claire).** Select **Reject**, type a **Reason for rejecting** such as `Consignee does not
match revision 3.`, and click **Reject version 2**.

**Expect.** Ana's page shows "Rejected by Claire Morel …" with the reason. Under **Earlier
versions (1)**, version 1 is still approved. Both timelines list the upload, approval, second
upload and rejection.

A known cosmetic flaw: after the replacement succeeds, Ana's emptied upload form keeps its
disabled button labelled **Upload as version 2**, although version 2 now exists. Choosing a file
corrects it to **Upload as version 3**. See [Walkthrough record](#walkthrough-record).

**Business meaning.** The seller presents the documents the buyer asked for, against an exact
revision of the instructions. The buyer decides on each exact file. A replacement is reviewed
afresh, and the history of what was approved or rejected, and why, is never rewritten.

**Engineering guarantee.**

- **What counts as a PDF.** Before sending, the browser refuses an empty file, a file over
  10 MiB, or one it does not report as `application/pdf` ("Choose a PDF file"). That is a
  convenience: browsers infer the type from the file name. The server decides:
  - the multipart part must declare `application/pdf` (otherwise 415);
  - the bytes are counted and hashed as they stream into a private staging area, and more than
    10 MiB aborts the upload (413);
  - an empty file gets 400;
  - a file whose first bytes are not `%PDF-` gets 415.

  This is a signature check only. The server does not parse or validate the PDF's structure, and
  does not scan it.

- **Upload compensation.** Files and rows cannot commit together, so an accepted file is first
  moved from staging to a server-generated key. Then one database transaction re-checks the
  session, the contract and the revision, makes a conditional write, and records the version and
  its audit event. A refused file is discarded from staging. If the transaction certainly rolled
  back (a lost race, a superseded revision, an audit failure), the kept bytes are removed again.
  If it failed while committing, so that it may have committed after all, the bytes are kept and
  logged for reconciliation. A crash between keeping and committing, or a removal that fails,
  leaves an orphaned file. It is logged and removed by a manual procedure
  ([ADR 0013](decisions/0013-documents.md),
  [architecture](architecture.md#documents-files-outside-the-transaction)).
- A first upload must not overwrite one that already exists (`If-None-Match: *`), and a
  replacement must name the version it replaces (`If-Match`). Every version keeps its size,
  SHA-256, uploader and time, and none is ever changed.
- There is one final decision per file version. The document's version counts uploads and
  decisions together, so a decision can never land on a file the buyer has not seen, nor a
  replacement pass over a decision unseen ([ADR 0014](decisions/0014-document-review.md)).
- Downloads go only to the two counterparties, as attachments.

**Evidence.** Chromium suite: `live-documents.spec.ts`, the same sequence. It uploads through the
form, downloads through the browser and compares SHA-256 byte for byte. PostgreSQL/HTTP:
`documents.int-spec.ts` (real multipart, the files on disk checked after every failure) and
`document-reviews.int-spec.ts` (including a review racing a replacement in both orders). jsdom:
`VoyageDocuments.test.tsx`, `VoyageDocumentReviews.test.tsx`. Scripted walkthrough: exercised,
including the signature refusal; the downloaded file was byte-identical by SHA-256.

### 6. Audit timeline and an access check

**Do (Claire).** Scroll to **Timeline**.

**Expect.** Newest first: every action of this demo, each with who, for which organization,
when, and the contract it was under. Only identifiers appear: no consignee, notice message, file
name or rejection reason. On a freshly seeded database those are the only entries: eleven, or
twelve if Ana acknowledged revision 3. The seed writes no audit events, so a seeded voyage has no "Created the voyage"
entry. On a database used before, earlier entries appear too, and **Load more** fetches older
pages; re-seeding does not remove audit events.

**Do (profile B).** Click **Sign out**, and sign in as **Lucía Ferreyra**.

**Expect.** She lands on her voyage list, which shows TF-2026-0003 and 0004 only. A sign-in
after an explicit sign-out starts on the list, not on the page left behind.

**Do.** Paste the voyage URL.

**Expect.** **Voyage not found**: "This voyage does not exist, or you do not have access to it."
An id that does not exist at all, such as `/voyages/01990000-0000-7000-8006-000000000099`, gives
exactly the same page. Behind it, both get the same `404` problem details ("Voyage was not
found.") from every endpoint, and no event stream is opened.

**Optional (+30 s).** Sign out, and sign in as **Jonas Weber**, Claire's viewer colleague. His
list has no **New voyage** button. On TF-2026-0001 he sees the same notices, instructions,
documents and timeline as Claire, and can download files. He is offered nothing to issue,
acknowledge, revise, upload, approve or reject.

**Business meaning.** Who did what, and when, is on record for each pair of counterparties,
without spreading their contents to anyone else. An outsider cannot even learn that the voyage
exists.

**Engineering guarantee.** Audit events are append-only and written in the same transaction as
the action, so the record cannot disagree with the data
([ADR 0009](decisions/0009-transactional-audit-events.md)). The timeline applies the same
counterparty rules as the panels. Outsiders get an identical 404 everywhere. Roles are read on
every request and checked in the service that performs the command
([ADR 0008](decisions/0008-user-roles.md)), so hiding buttons is a convenience, not the control.

**Evidence.** PostgreSQL/HTTP: `voyage-timeline.int-spec.ts`; outsider 404s in every
`*.int-spec.ts`; viewers refused with 403 in `notices`, `documentary-instructions`, `documents`
and `document-reviews`. jsdom: `VoyageTimeline.test.tsx`, "shows "not found" when the API
returns 404" in `VoyageDetailsPage.test.tsx`, and the viewer tests in each panel's file.
Chromium suite: timeline entries are asserted in the three `live-*.spec.ts` tests, but not the
non-participant and viewer checks. Scripted walkthrough: all of step 6 exercised, the viewer
included.

## Running it again

The demo leaves revisions 1 to 3 and two document versions on contract 1, so **Give documentary
instructions** is gone on a second run. Without re-seeding, either:

- run steps 3 to 5 on **contract 2**, with Claire as the seller and
  **Sanne de Vries** (`sanne.devries@nordlys.example`, Nordlys Trading) as the buyer; or on
  **contract 3**, with Sanne as the seller and **Katrin Vogel**
  (`katrin.vogel@rhinevalley.example`, Rhine Valley Crushers) as the buyer; or
- start step 3 at **Revise instructions** on contract 1. Revision and document version numbers
  continue from where they are.

Neither variant has been exercised. `pnpm db:seed` restores the seeded voyages, but it **deletes
every notice, documentary instruction and document on them, and the stored PDF bytes**, then
recreates the seeded notices. Audit events stay. Run it only on a database whose demo data you
do not need, or use [an isolated run](#an-isolated-run) and drop the database afterwards.

## Walkthrough record

**What ran.** On 2026-10-18 a Playwright script drove headless Chromium through all six steps,
the optional signature check and the optional viewer check, clicking and typing through the UI by
its visible labels. Each profile was a separate browser context with its own cookie jar.
Observation was read-only: the page, its network log and, through the DevTools protocol, the
event-stream messages it received. No request was faked, intercepted or sent around the UI.

**Environment.**

| Item        | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Code        | `6018cca` (application code as verified in CI at `e0f698d`; `6018cca` adds documentation only)            |
| Machine     | Windows 11, Node.js 24.11.1, browser time zone Europe/Warsaw                                              |
| Browser     | Playwright 1.63.0, Chromium 153.0.8010.12, headless                                                       |
| Database    | Throwaway `tradeflow_walk_…` on the Docker Compose PostgreSQL 18 server: all 12 migrations, then the seed |
| Storage     | Throwaway directory, passed as `DOCUMENT_STORAGE_DIR` to the seed and the API                             |
| Servers     | API with `nest start --watch` on port 3471; Vite dev server on 5471, proxying `/api` to it                |
| Not touched | The development (`tradeflow`) and test (`tradeflow_test`) databases: checked before and after             |

**Observed.**

| Step | Result                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Lists, trade string, "Your organization" on each side, two contract blocks for Claire, as described                                                                                       |
| 2    | Notice and acknowledgement each reached the other page about 0.1 s after the sender's confirmation: one stream message, then one re-read of notices and timeline; no navigation           |
| 3    | Revision 1, its acknowledgement and revision 2 each arrived over the stream in under 0.1 s                                                                                                |
| 4    | Stale-draft warning within 0.2 s of Ana's acknowledgement; draft kept; send disabled; no write until the re-base, then exactly one `PUT`                                                  |
| 5    | Fake PDF refused with 415 and nothing kept; upload, approval, replacement and rejection each pushed live; download byte-identical; history as described; two files in storage             |
| 6    | Twelve timeline entries (revision 3 was acknowledged), no contents; Lucía's list and identical 404s for the real and a made-up voyage; no stream opened for her; Jonas offered no actions |

Server logs showed no errors. The browser's console showed only the expected 401 (the session
check before signing in), 415 (the signature check) and 404 responses (Lucía).

**Deviations.** Before step 5 the script's own file-chooser selector failed and the script
stopped. Browser state was lost; the server and its data were not affected. Both profiles signed
in again and the walkthrough continued from step 5. File selection then went through the real
**Choose a PDF** control and the browser's file-chooser event, but the native file dialog itself
was bypassed, as it always is under automation. The save-download prompt was also handled by the
script.

**Defect found (cosmetic, not blocking).** After a successful upload, the document upload form
clears the chosen file but keeps the basis of that upload. Its disabled button then shows a
version number from before the upload: "Upload as version 2" right after version 2 was
uploaded. Choosing a file recomputes it correctly, so nothing wrong can be sent. Reproduce: upload
a replacement as the seller and look at the emptied form. Bounded fix: in
`apps/web/src/features/voyages/components/DocumentUploadForm.tsx`, label the button from the
latest document when no file is chosen (`basisOf(latest)` rather than the remembered basis), with
one jsdom assertion in `VoyageDocuments.test.tsx`. Not implemented here.

**Not exercised.** A person running the demo with real windows and the native file and download
dialogs; the ten-minute timing; `pnpm dev` as one command (the two servers were started with the
same commands it runs, except for the contracts watcher); the 412 path of step 4; the second-run
variants above; browsers other than Chromium.

## Walkthrough 2: a fresh voyage

> **Automated in Chromium; not yet performed by a person.** `pnpm demo:verify` drives F1 to F8
> through the UI against a fresh [`pnpm demo`](#starting-the-demo-pnpm-demo) instance and passed
> twice on 2026-10-28 ([automated runs](#automated-runs-of-walkthrough-2)). Each step's
> **Automated check** says exactly what that test asserts; the other expectations in a step come
> from the code and [ADR 0016](decisions/0016-initial-voyage-setup.md), not from an observed
> run. Steps F4 to F7 were rewritten on that date to follow the verified journey (the seller's
> Action Center, then a rejection, a replacement and an approval), replacing the earlier
> unverified order (approval, replacement, rejection). Fill in the
> [human record](#record-of-walkthrough-2) when a person runs it.

A walkthrough by hand of about fifteen minutes, in two browser profiles, from an empty voyage
to a reviewed document. The exporter creates a voyage, records whom the cargo is sold through,
and the buyer it named gains access. Then documentary instructions and a bill of lading run
under the contract that setup recorded, each handover arriving in the other side's Action
Center. Nothing is inserted into the database by hand: the organizations and users are the
seeded, curated set, and the voyage, its participants, its contracts, the instructions, files
and decisions are created through the UI.

It does not repeat what the first walkthrough already shows (ETA notices, a stale draft,
revisions): steps 2 to 4 above work the same on this voyage.

### Cast of walkthrough 2

Every seeded user's password is `tradeflow-demo`.

| Profile        | User           | Email                                 | Organization                    | On the new voyage, after setup                             | User role |
| -------------- | -------------- | ------------------------------------- | ------------------------------- | ---------------------------------------------------------- | --------- |
| **S** (seller) | Ana Souza      | `ana.souza@cerrado-graos.example`     | Cerrado Grãos Exportadora S.A.  | Exporter; seller under contract 1                          | Operator  |
| **B** (buyer)  | Tan Wei Ling   | `wei.ling.tan@meridianagri.example`   | Meridian Agri Trading Pte. Ltd. | Trader; buyer under contract 1 and seller under contract 2 | Operator  |
| B, step F8     | Emre Kaya      | `emre.kaya@anatoliamills.example`     | Anatolia Flour Mills A.Ş.       | Final buyer; buyer under contract 2                        | Operator  |
| B, optional    | Lucía Ferreyra | `lucia.ferreyra@pampalitoral.example` | Pampa Litoral Agroexport S.A.   | Not a participant                                          | Operator  |

Meridian and Anatolia are named in setup because they take no part in it beforehand: Wei Ling
and Emre cannot see the voyage until Ana names them. Everything in steps F4 to F7 happens in the
block headed **Contract 1 · Cerrado Grãos Exportadora S.A. → Meridian Agri Trading Pte. Ltd.**

### Before you start

**Simplest: `pnpm demo`** ([details](#starting-the-demo-pnpm-demo)). Every run is a fresh,
seeded database, so the new voyage is **TF-2026-0008** (in 2026) and nothing is left behind.
Sign in at the address it prints, followed by `/voyages`, instead of `localhost:5173`. Then
only the two profiles and the two PDFs below are needed.

On your development database instead, the same as
[for the first walkthrough](#before-you-start-not-part-of-the-ten-minutes), with these
differences:

- **Migrations.** All fourteen must be applied; the last two are ADR 0016's.
- **Data.** No fresh seed and no particular state are needed. Each run creates a voyage of its
  own, so the walkthrough can be repeated without re-seeding. A created voyage cannot be removed
  or cancelled through the app, and `pnpm db:seed` does not remove it either: every run leaves
  one more voyage in the lists of Cerrado, Meridian and Anatolia. Use
  [an isolated run](#an-isolated-run) if that matters.
- **Start.** Sign in at <http://localhost:5173/voyages>: Ana in profile S, Wei Ling in profile
  B. Wei Ling's list shows TF-2026-0002, 0005 and 0007, and any voyage that earlier runs created
  with Meridian in it.
- **PDFs.** `bl-v1.pdf` and `bl-v2.pdf` as before. The signature check is not repeated.

### F1. Create the voyage (Ana)

**Do.** Click **New voyage**. The form says "Cerrado Grãos Exportadora S.A. will be the exporter
on this voyage. It starts as planned, and its reference is assigned when it is created." Fill in:

| Field          | Value                        |
| -------------- | ---------------------------- |
| Vessel         | MV Cape Aurora (IMO 9812640) |
| Commodity      | Soybeans                     |
| Quantity (MT)  | `30000`                      |
| Load port      | Paranaguá (BRPNG)            |
| Discharge port | Mersin (TRMER)               |
| Laycan start   | 2026-12-01                   |
| Laycan end     | 2026-12-10                   |

The laycan fields are the browser's own date inputs: enter the dates in the format it shows.
Click **Create voyage**.

**Expect.**

- Ana lands on the new voyage's page. Its heading is the new reference: **TF-2026-0008** on a
  freshly seeded database, otherwise the next free number (numbers are never reused). Status
  **Planned**. Note the reference and the page's URL.
- **Trade string**: "Trade string not configured", and a **Set up trade string** button.
- **Participating organizations**: Cerrado Grãos only, as exporter.
- **ETA notices**: "Your organization is not a party to a sale contract on this voyage, so it
  neither sends nor receives notices here." **Documentary instructions**: "Documentary
  instructions pass only between the buyer and the seller under a sale contract, and your
  organization is party to none on this voyage."
- **Timeline**: one entry, "Created the voyage" by Ana Souza, with no contract label.

**Do (Wei Ling).** Reload her voyage list, then paste the new voyage's URL.

**Expect.** The voyage is not in her list. The URL shows **Voyage not found**: "This voyage does
not exist, or you do not have access to it."

**Evidence.** PostgreSQL/HTTP: `voyage-creation.int-spec.ts`. jsdom: `NewVoyagePage.test.tsx`.
Chromium suite: `trade-string-setup.spec.ts`, through the same form.

**Automated check** (`pnpm demo:verify`). The form's exporter sentence; the values above typed
into the form; the new URL and a `TF-<year>-<n>` heading that is none of the seeded ones
(observed: **TF-2026-0008** both times); "Trade string not configured" with **Set up trade
string**; Cerrado in **Trade parties**; the timeline's one entry with Ana's name and no contract
label. For Wei Ling: TF-2026-0002 listed and the new reference not; the URL shows "Voyage not
found" with the sentence above. Not checked: the status chip, the notices and instructions
wording.

### F2. Set up the trade string (Ana)

**Do.** Click **Set up trade string**. The form lists "1. Exporter, Cerrado Grãos Exportadora
S.A., Brazil · Your organization, always first". In **Find an organization**:

1. Type `Cerr`. **Expect** "No organization matches “Cerr”." The search matches any part of a
   name, ignoring case, but never offers your own organization.
2. Type `Meridian`, then click **Add** next to Meridian Agri Trading Pte. Ltd. **Expect** it as
   row 2, **Final buyer**.
3. Type `Anatolia`, then click **Add** next to Anatolia Flour Mills A.Ş. **Expect** row 3,
   **Final buyer**, and row 2 now **Trader**.
4. Optional: click **Move Anatolia Flour Mills A.Ş. up**. The two swap places and roles. Move it
   back down, so that Meridian is the trader again.

Click **Review the trade string**.

**Expect.** "The trade string, as it will be recorded": Cerrado Grãos (Brazil), Exporter;
Meridian Agri Trading (Singapore), Trader; Anatolia Flour Mills (Türkiye), Final buyer. Then
"Contract 1: Cerrado Grãos Exportadora S.A. sells to Meridian Agri Trading Pte. Ltd." and
"Contract 2: Meridian Agri Trading Pte. Ltd. sells to Anatolia Flour Mills A.Ş.". Under
**What setting it up does**: both organizations "take part in this voyage at once", the setup
"does not record that any of them agreed to it", and "Once set up, the trade string cannot be
changed or undone here."

**Check the review before going on.** A wrong chain cannot be corrected in the app: you would
need a new voyage, and the wrongly named organizations would keep their access to this one.

**Do.** Click **Set up trade string**.

**Expect.**

- **Trade string set up**: "Meridian Agri Trading Pte. Ltd. and Anatolia Flour Mills A.Ş. now
  take part in this voyage." No **Set up trade string** button is left.
- The trade string shows Cerrado Grãos (Exporter, "Your organization") → Contract 1 → Meridian
  (Trader) → Contract 2 → Anatolia (Final buyer). **Participating organizations** lists all
  three.
- **ETA notices** now offers **Issue ETA notice** for contract 1. **Documentary instructions**
  shows the contract 1 block, "You sell: you receive them", with "The buyer has not given
  documentary instructions under this contract yet."
- **Timeline**: "Set up the trade string" by Ana Souza, above "Created the voyage". The entry
  does not list the parties; the trade string does.

**Business meaning.** The exporter states once whom the cargo is sold through. Each named
organization gains access to the voyage and its own contracts, but nothing records that it
agreed.

**Engineering guarantee.** One `POST` records the whole chain, its participants and one audit
event in one transaction, or nothing. The server derives every role and position from the order,
and validates the chain as a whole. Only an operator of the exporter may do it, once: a second
attempt, from this page or any other, gets 409 and changes nothing
([ADR 0016](decisions/0016-initial-voyage-setup.md)).

**Evidence.** PostgreSQL/HTTP: `trade-string-setup.int-spec.ts` (60: refusals, two races,
revalidation after the lock, audit rollback), `organizations.int-spec.ts` (12). jsdom:
`VoyageTradeStringSetup.test.tsx` (26). Chromium suite: `trade-string-setup.spec.ts`, with a
two-party chain and generated organizations. This three-party chain on seeded organizations:
`pnpm demo:verify` (below).

**Automated check.** Items 1 to 3 (the optional move is not done); both contract sentences and
"It does not record that any of them agreed to it." in the review; **Trade string set up** and
"… now take part in this voyage."; no **Set up trade string** button left; three organizations in
the trade string; one contract block, "You sell: you receive them", with "The buyer has not
given documentary instructions under this contract yet."; the timeline's two entries in order,
neither with a contract label.

### F3. The buyer gains access (Wei Ling)

**Do.** Reload her voyage list. Nothing is pushed to a newly named organization, so this reload
is needed.

**Expect.** The new voyage is in her list, **Planned**. Open it:

- The same trade string, with Meridian marked "Your organization".
- **Documentary instructions**: two blocks. Contract 1 (Cerrado → Meridian), "You buy: you give
  them", "Your organization has not given documentary instructions under this contract yet.",
  with **Give documentary instructions**. Contract 2 (Meridian → Anatolia), "You sell: you
  receive them".
- **ETA notices**: an **Issue ETA notice** button of her own, for contract 2.
- **Timeline**: "Set up the trade string" and "Created the voyage", both by Ana Souza.

From here on, **do not reload either page**: the remaining changes arrive by themselves, on the
voyage pages over their event streams, and in the Action Center by its own reads (every 30
seconds, and at once when its window regains focus: click into the window you switch to).

**Evidence.** PostgreSQL/HTTP: "gives the named organizations the voyage and the existing
bilateral workflows" in `trade-string-setup.int-spec.ts`. Chromium suite:
`trade-string-setup.spec.ts` (the buyer's list, string and timeline entry).

**Automated check.** Opened from her list (no reload is needed in the test: her list is read
when she navigates to it); three organizations in the string, the one marked "Your organization"
being Meridian; two contract blocks, the first "You buy: you give them" with "Your organization
has not given documentary instructions under this contract yet.", the second "You sell: you
receive them"; the timeline's two entries. Not checked: the status chip and the notices button.

### F4. Instructions under the new contract, through Ana's Action Center

**Do (Ana).** Click **Action Center**. Nothing is waiting on the new voyage (an older voyage's
item may be listed; every item names its voyage).

**Do (Wei Ling).** In the contract 1 block, click **Give documentary instructions**. Consignee
`To order of Banco Demo`; **Required document 1**: Bill of lading, **Originals** 3, **Copies** 2.
Click **Send instructions**.

**Expect.** "Revision 1 has been sent to Cerrado Grãos Exportadora S.A. for acknowledgement."

**Do (Ana).** Click into her window. **Expect** in her queue, for the new voyage, one item:
**Acknowledge instructions**, "Meridian Agri Trading Pte. Ltd. · Contract 1", record
**Revision 1**. Click **Open revision 1**.

**Expect.** The voyage page, scrolled to revision 1, which has focus, showing the consignee.
Above the sections: "Revision 1 is waiting for your organization to acknowledge receipt …".
Opening it sent nothing.

**Do (Ana).** Click **Acknowledge receipt of revision 1**.

**Expect.** Revision 1 shows **Acknowledged by the seller**, on Ana's page and, without a reload,
on Wei Ling's. Back in **Action Center**, nothing is waiting on the new voyage.

**Engineering guarantee.** Ana's page opened its event stream before Cerrado had any contract on
this voyage. The stream re-reads her organization's contracts before every delivery, so signals
for the new contract reach it without a reload
([ADR 0015](decisions/0015-voyage-event-streams.md)). The queue item is derived from the
records on each read; there is no task table ([ADR 0017](decisions/0017-action-center.md)).

**Automated check.** Everything in this step, with Ana's queue reaching the item by its own
30-second poll (see [automated runs](#automated-runs-of-walkthrough-2)) and the browser's
network log showing no write sent by opening the link. Wei Ling's page received the
acknowledgement over its stream while untouched.

### F5. Ana uploads a PDF; Wei Ling downloads it

**Do (Wei Ling).** Click **Action Center**: nothing waiting on the new voyage.

**Do (Ana).** Open the new voyage from **Voyages**. At **Bill of lading**, click **Choose a PDF**,
pick `bl-v1.pdf`, then **Upload**.

**Expect.** "Version 1 of the bill of lading has been uploaded." Ana's queue: nothing waiting on
the new voyage.

**Do (Wei Ling).** Click into her window. **Expect** one item for the new voyage: **Review
document**, "Cerrado Grãos Exportadora S.A. · Contract 1", "Bill of lading, version 1
(instructions revision 1)". Click **Open version 1**.

**Expect.** "Version 1 of the bill of lading is waiting for your organization’s decision";
version 1 focused, showing "Version 1: bl-v1.pdf", **Pending review** and the first 12
characters of its SHA-256; the review form with neither **Approve** nor **Reject** chosen.

**Do (Wei Ling).** Click **Download** next to version 1. Compare the saved file with
`Get-FileHash bl-v1.pdf` (PowerShell) or `sha256sum bl-v1.pdf`.

**Expect.** The browser saves `bl-v1.pdf`, and its checksum starts with the 12 characters the
page shows.

**Automated check.** All of it; the PDF is generated (`%PDF-1.7` and random bytes) and the
download's SHA-256 equals the upload's, byte for byte. The browser's save dialog is bypassed, as
always under automation.

### F6. Wei Ling rejects version 1; Ana is asked to replace it

**Do (Wei Ling).** Select **Reject**, type the **Reason for rejecting**
`Consignee does not match revision 1.`, and click **Reject version 1**.

**Expect.** "Version 1 of the bill of lading has been rejected." Her **Action Center**: nothing
waiting on the new voyage.

**Do (Ana).** Click into her window (she is on **Action Center**). **Expect** one item for the
new voyage: **Replace rejected document**, with the reason, "Meridian Agri Trading Pte. Ltd. ·
Contract 1". Click **Open version 1**, and **wait for** "Version 1 of the bill of lading was
rejected and is waiting for your organization to replace it" before choosing a file (see
[A4](#a4-the-rejection-becomes-the-sellers-action-150-to-225)). Version 1 is focused and shows
"Rejected by Tan Wei Ling".

**Automated check.** All of it, Ana's queue again reaching the item by its own poll; no write
sent by opening the link.

### F7. The replacement, approved

**Do (Ana).** Choose `bl-v2.pdf`; the button reads **Upload as version 2**. Click it. Back in
**Action Center**: nothing waiting on the new voyage.

**Do (Wei Ling).** Click into her window. **Expect** one item for the new voyage: **Review
document**, "Bill of lading, version 2 (instructions revision 1)", a new action. Click **Open
version 2**: "Version 2 of the bill of lading is waiting for your organization’s decision",
version 2 focused. Select **Approve**, then click **Approve version 2**.

**Expect.** "Version 2 of the bill of lading has been approved", and above the sections "Version
2 of the bill of lading has already been approved". Both queues: nothing waiting on the new
voyage (Wei Ling's seeded TF-2026-0002 notice remains).

**Do (both).** Open the new voyage, and at **Bill of lading** click **Earlier versions (1)**.

**Expect.** "Version 2: bl-v2.pdf", **Approved by Tan Wei Ling**; under **Earlier versions**,
"Version 1: bl-v1.pdf", **Rejected by Tan Wei Ling**, with the reason as typed. The same on both
sides.

**Business meaning.** The seller presents the document; the buyer decides on that exact file; a
rejection comes back to the seller as work to do, with the reason; the replacement is reviewed
afresh, and the history of what was rejected, and why, stays.

**Evidence.** Chromium suite: `live-documents.spec.ts` (download by SHA-256, replacement,
rejection, history, over the event stream) and `action-center.spec.ts` (this queue journey, on a
voyage written into the database). PostgreSQL/HTTP: `documents.int-spec.ts`,
`document-reviews.int-spec.ts`, `action-items.int-spec.ts`; one upload and approval on a set-up
voyage in `trade-string-setup.int-spec.ts`.

**Automated check.** All of F7, on both sides.

### F8. Timeline and visibility

**Do (both).** Scroll to **Timeline**.

**Expect.** Eight entries, newest first, the same on both sides:

| #   | Entry                                                              | By           | Contract label |
| --- | ------------------------------------------------------------------ | ------------ | -------------- |
| 1   | Approved version 2 of the bill of lading (instructions revision 1) | Tan Wei Ling | Contract 1     |
| 2   | Uploaded version 2 of the bill of lading (instructions revision 1) | Ana Souza    | Contract 1     |
| 3   | Rejected version 1 of the bill of lading (instructions revision 1) | Tan Wei Ling | Contract 1     |
| 4   | Uploaded version 1 of the bill of lading (instructions revision 1) | Ana Souza    | Contract 1     |
| 5   | Acknowledged revision 1 of the documentary instructions            | Ana Souza    | Contract 1     |
| 6   | Gave documentary instructions                                      | Tan Wei Ling | Contract 1     |
| 7   | Set up the trade string                                            | Ana Souza    | None           |
| 8   | Created the voyage                                                 | Ana Souza    | None           |

Each shows who, for which organization, and when. No consignee, file name or rejection reason
appears.

**Do (a third profile).** Sign in as **Emre Kaya** and open the new voyage from his list.

**Expect.**

- The same trade string, with Anatolia marked "Your organization".
- **Documentary instructions**: only the contract 2 block (Meridian → Anatolia), "You buy: you
  give them". Nothing of contract 1: no consignee, file or reason anywhere on the page.
- **Timeline**: two entries only, "Set up the trade string" and "Created the voyage".

**Do (a fourth profile).** Open the voyage's URL and sign in as **Lucía Ferreyra**.

**Expect.** **Voyage not found**, as for a voyage that does not exist; the reference appears
nowhere.

**Evidence.** PostgreSQL/HTTP: "shows every participant the setup, without its parties, and
keeps contract events to their counterparties" in `trade-string-setup.int-spec.ts`;
`voyage-timeline.int-spec.ts`.

**Automated check.** The eight entries in this order, each with its actor and organization, and
the contract label exactly where the table says; none of the four contents on either timeline;
Emre's view as above (one block, its accessible name starting "Contract 2 · ", two timeline
entries, none of the contents on the page); Lucía's "Voyage not found" without the reference.

### Automated runs of walkthrough 2

**What ran.** `pnpm demo:verify` (`e2e/demo/walkthrough.spec.ts`): Playwright drives headless
Chromium through F1 to F8, by the UI's accessible names, against a demo started by the same
code as `pnpm demo`. Ana and Wei Ling each have a browser context of their own, Emre and Lucía
one each: four sign-ins, under the production admission budget. After the seed, every business
write is a click or a typed value; nothing is written to the database by the test, and no
response, session or `EventSource` is faked. Observation is read-only: the page, and the
browser's network log over the DevTools protocol.

**Stated clock control.** Ana's and Wei Ling's pages have Playwright's clock installed before
they load. Each time the other side acts, the test moves that page's clock forward 31 seconds,
which fires the queue's own 30-second refresh, then waits until the browser has sent that read
and received all of its answer. The queues are never refreshed by the button, and no window
focus is simulated. Opening the Action Center is followed by a wait for its fresh read (it keeps
nothing once left). Everything else runs at real time.

| Item     | Value                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------- |
| Date     | 2026-10-28, two runs one after the other, each from its own fresh `pnpm demo:verify`               |
| Code     | `42ee8f2` with this phase's uncommitted changes (the demo, its walkthrough, the API's `HOST`)      |
| Machine  | Windows 11 Home, Node.js 24.11.1, pnpm 11.9.0, Docker 29.7.2 (Linux engine)                        |
| Browser  | Playwright 1.63.0, Chromium 153.0.8010.12, headless, contexts in UTC, `en-GB`                      |
| Database | `postgres:18-alpine` (PostgreSQL 18.6), a new container per run: 14 migrations, then the real seed |
| Servers  | Built API (`node main.js`) and `vite preview`, on 127.0.0.1, `NODE_ENV=development`                |
| Voyage   | **TF-2026-0008** in both runs (each a fresh database)                                              |

| Step                              | Run A | Run B | Observed                                                                  |
| --------------------------------- | ----- | ----- | ------------------------------------------------------------------------- |
| Sign-in on both Action Centers    | 0.9 s | 0.8 s | Wei Ling's queue showed the seeded TF-2026-0002 notice                    |
| F1                                | 0.7 s | 0.7 s | As expected; TF-2026-0008; not found for Wei Ling                         |
| F2                                | 2.4 s | 2.9 s | As expected                                                               |
| F3                                | 0.3 s | 0.3 s | As expected                                                               |
| F4                                | 0.9 s | 0.9 s | Item by poll; link sent no write; acknowledgement live on Wei Ling's page |
| F5                                | 1.1 s | 1.1 s | Item by poll; download byte-identical by SHA-256                          |
| F6                                | 0.6 s | 0.6 s | Item with the reason by poll; link sent no write                          |
| F7                                | 0.8 s | 0.8 s | Item for version 2 by poll; approved; no action left on the voyage        |
| Earlier versions                  | 0.4 s | 0.4 s | Version 1 rejected with its reason, on both sides                         |
| F8                                | 1.3 s | 1.3 s | Eight entries as in the table; Emre's contract 2 only; Lucía: not found   |
| Whole command, codegen to cleanup | 31 s  | 32 s  | Container and directory removed after each run                            |

The step times are with a moved clock and no human pauses: they say nothing about how long a
person needs.

**Deviations.** Two earlier attempts on the same day failed on the test's own code, and no
application change was needed. The first used an ambiguous locator (Cerrado's trade-string item
also names Meridian). The second waited for the first queue read after opening the Action
Center, which the upload's own queue invalidation had cancelled and replaced, as ADR 0017
specifies; the shared helper now waits for a read that was answered in full. A third attempt
passed; then the two runs above passed on the final code.

**The demo's lifecycle, checked the same day on Windows 11** (not part of `demo:verify`):

- `pnpm demo` in a console of its own: the banner as described; the database, API and web server
  listening on 127.0.0.1 only; `/api/health` answered 200 through the web server's proxy.
- A real Ctrl+C (`CTRL_C_EVENT` sent to that console): "Stopping the demo." then "Stopped.
  Removed container … and …"; no container, directory or server process left. The console's
  `cmd` and pnpm exited about 2 s after the Ctrl+C, before the demo printed its last line.
- `q` and Enter on standard input: the same, with exit status 0.
- The API killed by its process id while the demo ran: "The API exited on its own (exit code
  1)", its last log lines, "The demo cannot continue without it. Stopping.", then the same
  cleanup and exit status 1.
- Startup interrupted at the web build, at the seed and at the web server's start, and failing
  at the API's start: each time, its container and directory were removed and no process was
  left.
- A directory held by another process at cleanup: "Cleanup was incomplete" naming the directory,
  the error and the cmd recovery command; following that command removed it, and the
  repository's `apps/api/node_modules` was intact. The container was removed regardless.

Not checked: Linux or macOS (no such machine was available; the code paths are the same, with
`kill` instead of `taskkill` in the recovery lines), closing the terminal window, browsers other
than Chromium, and a person.

### Record of walkthrough 2

**Human run: not yet performed.** Fill in this section when a person runs it, and keep it as
observed. The automated runs above do not count as one.

| Item     | Value                                               |
| -------- | --------------------------------------------------- |
| Date     | _not yet run by a person_                           |
| Run by   |                                                     |
| Code     | Commit:                                             |
| Machine  | OS, Node.js version, browser and version, time zone |
| Database | `pnpm demo`, or development / isolated; seeded when |
| Voyage   | Reference and id created in F1                      |

| Step | Result (as expected / differed: how) | Time taken |
| ---- | ------------------------------------ | ---------- |
| F1   |                                      |            |
| F2   |                                      |            |
| F3   |                                      |            |
| F4   |                                      |            |
| F5   |                                      |            |
| F6   |                                      |            |
| F7   |                                      |            |
| F8   |                                      |            |

**Usability issues.** One row per issue: what was confusing, slow or surprising, even when the
step worked as expected. Severity: _blocking_ (could not continue), _confusing_ (continued, but
unsure), _cosmetic_.

| #   | Step | What happened | Severity | Suggested change |
| --- | ---- | ------------- | -------- | ---------------- |
| 1   |      |               |          |                  |

## Walkthrough 3: the Action Center in three minutes

> **Performed once, by a script.** On 2026-10-23 a Playwright script drove two isolated
> Chromium contexts through the setup and steps A1 to A5 below, by the UI's visible labels, on
> a freshly seeded throwaway database. What follows is what it observed
> ([record](#record-of-walkthrough-3)). **No person has run it yet**: the spoken pacing, real
> window focus and the native file dialog are unobserved.

One fresh voyage between two seeded organizations. The buyer's instructions become the seller's
action; each action opens one exact record; the decision taken there becomes the counterparty's
next action, and the answered one disappears. Nothing in the Action Center sends a command.

### Cast of walkthrough 3

Every seeded user's password is `tradeflow-demo`. All names are fictional.

| Profile        | User         | Email                               | Organization                    | On the new voyage                   |
| -------------- | ------------ | ----------------------------------- | ------------------------------- | ----------------------------------- |
| **S** (seller) | Ana Souza    | `ana.souza@cerrado-graos.example`   | Cerrado Grãos Exportadora S.A.  | Exporter; seller under contract 1   |
| **B** (buyer)  | Tan Wei Ling | `wei.ling.tan@meridianagri.example` | Meridian Agri Trading Pte. Ltd. | Final buyer; buyer under contract 1 |

### Before you start (not part of the three minutes)

1. **Database.** All fourteen migrations, and the seeded organizations and users. The seed is
   not re-run for this walkthrough, and the development database is never reset: the walkthrough
   creates a voyage of its own, so it can be repeated (each run leaves one more voyage). To keep
   it away from your development data entirely, use [an isolated run](#an-isolated-run), seeded
   once, and drop the database afterwards. A database seeded before 2026-10-23 may have no voyage
   reference counter (the seed's counter query matched nothing), and then **Create voyage** fails
   with a server error; seeding with the current seed, or an isolated run, sets it.
2. **Servers and two profiles**, as for the first walkthrough: `pnpm dev`, then two isolated
   browser profiles side by side, Ana in **S** and Wei Ling in **B**.
3. **Two PDFs**, `bl-v1.pdf` and `bl-v2.pdf`.
4. **A fresh voyage (Ana, about a minute).** **Voyages** → **New voyage**: MV Cape Aurora,
   Soybeans, `30000`, Paranaguá (BRPNG) → Mersin (TRMER), laycan 2026-12-01 to 2026-12-10,
   **Create voyage**. Note its reference (**TF-2026-0008** on a freshly seeded database). Then
   **Set up trade string**, find `Meridian`, **Add**, **Review the trade string**, **Set up trade
   string**: one contract, Cerrado sells to Meridian.
5. **Start positions.** Ana on **Action Center**: "Nothing is waiting for your organization".
   Wei Ling on **Action Center**: one seeded item, **Acknowledge ETA notice** on TF-2026-0002
   (it stays there throughout; every item names its voyage), then she opens the new voyage from
   **Voyages**.

**Refreshing during the demo.** A queue on screen reads itself again every 30 seconds, and at
once when its window regains focus. When you switch to the other window, **click into it**: the
queue reads at once. Without focus, expect up to 30 seconds (the scripted run waited 29 to 30 s
for each of the three handovers, since a headless browser never changes focus). **Refresh** also
reads at once; say so if you use it, as it is a manual read, not the automatic one.

### A1. Instructions become the seller's action (0:00 to 0:30)

**Do (Wei Ling).** In **Contract 1 · Cerrado Grãos … → Meridian …**, **Give documentary
instructions**: consignee `To order of Banco Demo`, a bill of lading, 3 originals, 2 copies,
**Send instructions**.

**Expect (Ana, after clicking into her window).** **Acknowledge instructions** on the new voyage:
"Acknowledge receipt of revision 1 of the documentary instructions Meridian Agri Trading Pte.
Ltd. gave", record **Revision 1**, counterparty Meridian · Contract 1, when it was given.

**Say.** _Derived state_: there is no task table. The item is computed on each read from the
records: the current revision has no acknowledgement, so the seller owes one.

### A2. Record, decision, upload (0:30 to 1:10)

**Do (Ana).** **Open revision 1**.

**Expect.** The voyage page, scrolled to revision 1, which has focus and an outline, clear of the
header. Above the sections: "Revision 1 is waiting for your organization to acknowledge receipt.
It is the revision in force." Nothing was sent by opening it.

**Do (Ana).** **Acknowledge receipt of revision 1**. Then at **Bill of lading**, **Choose a PDF**
(`bl-v1.pdf`), **Upload**. Back to **Action Center**.

**Expect.** Revision 1 shows **Acknowledged by the seller**; "Version 1 of the bill of lading has
been uploaded."; Ana's queue: "Nothing is waiting for your organization".

**Say.** The action disappeared because the record changed, not because anyone ticked it off.
_Counterparty isolation_: the queue is scoped to contracts where the organization is buyer or
seller and still participates; a surveyor on this voyage, or the next trader in a string, sees
none of it.

### A3. The buyer rejects the exact version (1:10 to 1:50)

**Do (Wei Ling).** **Action Center** (click into her window).

**Expect.** **Review document**: "Approve or reject version 1 of the bill of lading Cerrado Grãos
Exportadora S.A. presented", record "Bill of lading, version 1 (instructions revision 1)", beside
the seeded notice.

**Do.** **Open version 1**. **Expect** "Version 1 of the bill of lading is waiting for your
organization's decision", version 1 focused, the review form with nothing chosen. **Reject**,
reason `Consignee does not match revision 1.`, **Reject version 1**. Back to **Action Center**:
the review item is gone.

**Say.** _Optimistic concurrency_: the decision names version 1 and is sent with that version's
precondition, so if the seller had replaced the file meanwhile it would be refused (412), never
applied to the newer file. Opening a link never chooses a decision or retargets one.

### A4. The rejection becomes the seller's action (1:50 to 2:25)

**Expect (Ana, after clicking into her window).** **Replace rejected document**, with the reason
"Consignee does not match revision 1." on the item.

**Do.** **Open version 1**. **Wait for** "Version 1 of the bill of lading was rejected and is
waiting for your organization to replace it" before choosing a file (see the note below). Choose
`bl-v2.pdf`, **Upload as version 2**. Back to **Action Center**: nothing waiting.

### A5. Approval closes the loop (2:25 to 3:00)

**Expect (Wei Ling, after clicking into her window).** **Review document** for **version 2**: a
new action, not the old one updated.

**Do.** **Open version 2**, **Approve**, **Approve version 2**. **Action Center**: only the seeded
notice is left.

**Optional (+20 s).** Browser **Back** to the version 1 link (or paste it): "Version 1 of the bill
of lading has been replaced … A decision or a replacement applies only to version 2." Version 1 is
focused inside **Earlier versions**; fold it and press **Show it** to open it again. Nothing is
sent.

**Say.** _Refresh reconciliation_: the queue has no push. It re-reads its first page every 30 s
while visible, on focus, visibility and reconnection, and right after the same session's
commands; a read already on its way when a command commits is cancelled and replaced, even
while the queue is still loading its first page, so an answer older than the command is never
shown. Each refresh restarts from the first page rather than mixing pages read at different
times.

**If a file was chosen too early.** Coming back to the voyage page shows its cached sections for a
moment while they are read again. If a file is chosen in that moment and the read then shows the
rejection, the form keeps the file and asks **Replace version 1 with my file**: the same
precondition at work. Confirm, or wait for the status first.

### Known limits to state

- **Candidate loading in memory.** Each page read loads all of the organization's open
  candidates and cuts the page in memory; cost grows with current open work (not history). The
  SQL ordering is designed, not built ([ADR 0017](decisions/0017-action-center.md)).
- **Polling for the aggregate queue.** No organization-wide stream: another organization's
  command reaches a queue on screen within 30 s, or on focus.
- **Single-instance voyage SSE.** Voyage pages' live updates fan out in one API process
  ([ADR 0015](decisions/0015-voyage-event-streams.md)); several instances would need a broker.
- **Local file storage.** PDFs are kept in a local directory (`DOCUMENT_STORAGE_DIR`), not object
  storage.

**Evidence.** Chromium suite: `action-center.spec.ts` (this journey with polling on the page's
clock, an ETA notice acknowledged from the queue, old-link history and **Show it**, viewers and
other organizations). jsdom: `ActionCenterPage.test.tsx`, `VoyageRecordLinks.test.tsx`.
PostgreSQL/HTTP: `action-items.int-spec.ts`.

### Record of walkthrough 3

**What ran.** On 2026-10-23 a Playwright script (not a person) drove headless Chromium in two
browser contexts, each with its own cookie jar: the setup (voyage created and trade string set up
through the forms) and A1 to A5 with the optional old link. It waited for each cross-organization
change by the page's own polling, with no reload, no Refresh and no clock control, and recorded
every non-`GET` request. The script was deleted afterwards.

| Item     | Value                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| Code     | Working tree on `0c9fb64`, with this milestone's changes (seed counter fix included), uncommitted                 |
| Machine  | Windows 11, Node.js 24.11.1, Playwright 1.63.0 with its Chromium, headless, contexts in UTC                       |
| Database | Throwaway `tradeflow_demo` on a disposable PostgreSQL 18.6 container: 14 migrations, then the seed                |
| Servers  | API with `nest start` on 3471; Vite dev server on 5471 proxying `/api`, as in [an isolated run](#an-isolated-run) |
| Voyage   | TF-2026-0008, Cerrado Grãos → Meridian                                                                            |

| Step | Observed                                                                                                           | At (s) |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| A1   | Ana's **Acknowledge instructions** (TF-2026-0008, revision 1) appeared 29.1 s after Wei Ling sent revision 1       | 29.5   |
| A2   | Status as above; revision 1 focused; acknowledged and v1 uploaded; Ana's queue empty                               | 30.3   |
| A3   | Wei Ling's queue: the seeded notice (TF-2026-0002) and **Review document**; v1 focused; rejected; review item gone | 30.9   |
| A4   | **Replace rejected document** with the reason appeared 29.6 s after the rejection; v2 uploaded                     | 61.1   |
| A5   | **Review document** for version 2 appeared 30.2 s after the upload; approved; only the seeded notice left          | 92.4   |
| Old  | Version 1 shown as replaced history, focused inside **Earlier versions**; 0 writes sent by opening it              | 93.2   |

The writes were exactly the commands of the steps: the instructions, the acknowledgement, two
uploads and two reviews (plus sign-ins and setup). Of the 92 s, about 89 s was waiting for
polling; with a person clicking into the other window, each handover should read at once (tested
in jsdom, not observed in a browser).

**Deviations.** A first attempt failed at setup: on the freshly seeded database **Create voyage**
answered 500 (`voyages_reference_key`), because the seed never set the voyage reference counter
(its regular expressions lost their `\d` in a tagged template). The seed was fixed, the throwaway
database recreated, and the run repeated. A second attempt stopped at A4 because the script chose
the file before the voyage page had re-read its documents (see "If a file was chosen too early");
the script then waited for the status text as a person would, and the third run passed.

**Not exercised.** A person and spoken timing; real window focus; the native file dialog;
`pnpm dev` as one command; other browsers.
