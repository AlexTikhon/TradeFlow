# Demo: one voyage, seller and buyer side by side

A walkthrough of about ten minutes on seeded voyage **TF-2026-0001**, with the seller and the
buyer under its first sale contract in two isolated browser profiles. It shows each MVP flow
once, explains what it means for the business, and what the system guarantees while it happens.
A second walkthrough, [on a fresh voyage](#walkthrough-2-a-fresh-voyage), starts from nothing:
the exporter creates a voyage and sets up its trade string in the app, then the same flows run
under the contract that setup recorded. What is implemented and how it is verified:
[MVP status](mvp-status.md).

> **Verification status.** On 2026-10-18 all six steps were driven through the real web UI in
> Chromium by a script (Playwright, two isolated browser contexts) against a throwaway database,
> and the expectations below are what that run observed. See
> [Walkthrough record](#walkthrough-record). **No person has run this demo yet.** The scripted run
> proves the flows, the wording and the live updates, but not the pacing, the native file and
> download dialogs, or how it reads to an audience.
>
> **The fresh-voyage walkthrough (steps F1 to F8) has not been performed**, by a script or a
> person. Its expectations come from the code at `5baf039`, ADR 0016 and the tests that cover it,
> not from an observed run. Its [record](#record-of-walkthrough-2) is empty until someone runs
> it.

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

> **Not yet performed.** Nobody has run these steps, by a script or by hand. The expectations
> below come from the code at `5baf039`, [ADR 0016](decisions/0016-initial-voyage-setup.md) and
> its tests, not from an observed run. Fill in the [record](#record-of-walkthrough-2) when you
> run it.

A walkthrough by hand of about fifteen minutes, in two browser profiles, from an empty voyage
to a reviewed document. The exporter creates a voyage, records whom the cargo is sold through,
and the buyer it named gains access. Then the bilateral flows of steps 3 and 5 run under the
contract that setup recorded. Nothing is inserted into the database by hand: the organizations
and users are the seeded, curated set, and the voyage, its participants and its contracts are
created through the UI.

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

The same as [for the first walkthrough](#before-you-start-not-part-of-the-ten-minutes), with
these differences:

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
two-party chain and generated organizations. Not in any test: this three-party chain on seeded
organizations through the UI.

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

From here on, **do not reload either page**: the remaining changes arrive by themselves.

**Evidence.** PostgreSQL/HTTP: "gives the named organizations the voyage and the existing
bilateral workflows" in `trade-string-setup.int-spec.ts`. Chromium suite:
`trade-string-setup.spec.ts` (the buyer's list, string and timeline entry).

### F4. Documentary instructions under the new contract

**Do (Wei Ling).** In the contract 1 block, click **Give documentary instructions**. Consignee
`To order of Banco Demo`; **Required document 1**: Bill of lading, **Originals** 3, **Copies** 2.
Click **Send instructions**.

**Expect.** "Revision 1 has been sent to Cerrado Grãos Exportadora S.A. for acknowledgement."
Without a reload, Ana's page shows revision 1, **Not acknowledged**, with **Acknowledge receipt of
revision 1**, and a **Documents** section with an upload form for the bill of lading. Both
timelines gain "Gave documentary instructions", labelled Contract 1.

**Do (Ana).** Click **Acknowledge receipt of revision 1**.

**Expect.** Both pages show **Acknowledged by the seller**. Both timelines gain "Acknowledged
revision 1 of the documentary instructions".

**Engineering guarantee.** Ana's page opened its event stream before Cerrado had any contract on
this voyage. The stream re-reads her organization's contracts before every delivery, so the
signal for the new contract reaches it without a reload
([ADR 0015](decisions/0015-voyage-event-streams.md)).

**Evidence.** Chromium suite: `trade-string-setup.spec.ts`, whose buyer's instructions reach the
exporter's page that set up the voyage. The acknowledgement on a set-up voyage: over HTTP in
`trade-string-setup.int-spec.ts`; in Chromium on other voyages only (`live-instructions.spec.ts`).

### F5. PDF upload and download

**Do (Ana).** At **Bill of lading**, click **Choose a PDF**, pick `bl-v1.pdf`, then **Upload**.

**Expect.** "Version 1 of the bill of lading has been uploaded." Wei Ling's page shows
"Version 1: bl-v1.pdf (size)", who uploaded it and when, the first 12 characters of its SHA-256,
**Pending review**, and "Pending review by Meridian Agri Trading Pte. Ltd.". Both timelines gain
"Uploaded version 1 of the bill of lading (instructions revision 1)".

**Do (Wei Ling).** Click **Download** next to version 1. Compare the saved file with
`Get-FileHash bl-v1.pdf` (PowerShell) or `sha256sum bl-v1.pdf`.

**Expect.** The browser saves `bl-v1.pdf`, and its checksum starts with the 12 characters the
page shows.

### F6. Approval

**Do (Wei Ling).** Under "Your decision on version 1", select **Approve**, then click
**Approve version 1**.

**Expect.** "Version 1 of the bill of lading has been approved." Ana's page shows "Approved by
Tan Wei Ling (Meridian Agri Trading Pte. Ltd.) on …". Both timelines gain "Approved version 1 of
the bill of lading (instructions revision 1)".

### F7. Replacement and rejection

**Do (Ana).** Choose `bl-v2.pdf`; the button reads **Upload as version 2**. Click it.

**Expect.** Wei Ling's page shows version 2, **Pending review**, and under
**Earlier versions (1)** version 1 still approved. Ana's emptied form keeps its disabled button
labelled **Upload as version 2**: the cosmetic defect in the
[first record](#walkthrough-record), not a new finding.

**Do (Wei Ling).** Select **Reject**, type the **Reason for rejecting**
`Consignee does not match revision 1.`, and click **Reject version 2**.

**Expect.** Ana's page shows "Rejected by Tan Wei Ling …" with the reason, and version 1 still
approved under **Earlier versions (1)**.

**Evidence for F5 to F7.** On a voyage set up through the command: one upload and its approval,
over HTTP only (`trade-string-setup.int-spec.ts`). The full sequence, replacement and rejection
included, on other voyages: Chromium `live-documents.spec.ts` (download compared by SHA-256),
PostgreSQL/HTTP `documents.int-spec.ts` and `document-reviews.int-spec.ts`. Nothing about
documents depends on how the contract was recorded.

### F8. Timeline and visibility

**Do (Wei Ling).** Scroll to **Timeline**.

**Expect.** Eight entries, newest first:

| #   | Entry                                                              | Contract label |
| --- | ------------------------------------------------------------------ | -------------- |
| 1   | Rejected version 2 of the bill of lading (instructions revision 1) | Contract 1     |
| 2   | Uploaded version 2 of the bill of lading (instructions revision 1) | Contract 1     |
| 3   | Approved version 1 of the bill of lading (instructions revision 1) | Contract 1     |
| 4   | Uploaded version 1 of the bill of lading (instructions revision 1) | Contract 1     |
| 5   | Acknowledged revision 1 of the documentary instructions            | Contract 1     |
| 6   | Gave documentary instructions                                      | Contract 1     |
| 7   | Set up the trade string                                            | None           |
| 8   | Created the voyage                                                 | None           |

Each shows who, for which organization, and when. No consignee, file name or rejection reason
appears. Ana's timeline shows the same eight.

**Do (profile B).** Click **Sign out**, and sign in as **Emre Kaya**. Open the new voyage from
his list.

**Expect.**

- His list shows the new voyage and TF-2026-0003, and any voyage that earlier runs created.
- The same trade string, with Anatolia marked "Your organization".
- **Documentary instructions**: only the contract 2 block (Meridian → Anatolia), "You buy: you
  give them", nothing given yet. Nothing of contract 1: no instructions, documents or decisions.
- **Timeline**: two entries only, "Set up the trade string" and "Created the voyage".

**Optional (+30 s).** Sign out and sign in as **Lucía Ferreyra**. Pasting the voyage's URL shows
**Voyage not found**, as for a voyage that does not exist.

**Evidence.** PostgreSQL/HTTP: "shows every participant the setup, without its parties, and
keeps contract events to their counterparties" in `trade-string-setup.int-spec.ts`;
`voyage-timeline.int-spec.ts`. Not in the Chromium suite: the final buyer's view and the
outsider on a set-up voyage.

### Record of walkthrough 2

**Status: not yet performed.** Fill in this section when it is run, and keep it as observed.

| Item     | Value                                               |
| -------- | --------------------------------------------------- |
| Date     | _not yet run_                                       |
| Run by   |                                                     |
| Code     | Commit:                                             |
| Machine  | OS, Node.js version, browser and version, time zone |
| Database | Development or isolated; seeded when; migrations    |
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
