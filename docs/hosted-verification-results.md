# Hosted verification results: template

Copy this file to `docs/hosted-verification-<yyyy-mm-dd>.md` for each real run and fill it from
the suite's results files and the operator's notes ([runbook](hosted-verification.md)). Record
what happened, failures included. Never paste credentials, cookies, connection URLs, secret
values, document contents, browser state or full logs. Request ids, digests and identifiers are
fine.

## Run

| Field                     | Value                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Date (UTC), operator role | `<yyyy-mm-dd>`, `<SSO role name, no credentials>`                                                                                                |
| Source commit             | `<full git SHA of the deployed code>`                                                                                                            |
| Verifier commit           | `<full git SHA the suite ran from, if different>`                                                                                                |
| Image digests             | api `sha256:…`, web `sha256:…`, tools `sha256:…` (release parameter version `<n>`)                                                               |
| Environment               | account `<id>`, region, `environment` name, `https://<domain>`                                                                                   |
| Instance, database        | `instance_id`, type/architecture, `db_instance_class`, PostgreSQL version                                                                        |
| Latest migration          | `<migration name>` (applied with tools `sha256:…` at `<time>`)                                                                                   |
| Fixtures                  | prepared at `<time>` with tools `sha256:…`; demo seed not run (yes/no)                                                                           |
| Certificate               | issuer, not-after (`openssl s_client -connect <domain>:443 -servername <domain> </dev/null 2>/dev/null \| openssl x509 -noout -issuer -enddate`) |

## Commands

```text
pnpm hosted:verify --origin https://<domain> --results <file>          # full run
<restart command used, exactly as typed, see runbook#restart>
pnpm hosted:verify --origin https://<domain> --mode restored --expect <file> --results <file>
<every recovery command, with placeholders for secrets>
```

## Suite outcomes

From `checks` in the results files. Every planned check appears: `passed`, `failed` or `not-run`.

| Check                         | Full run | Duration | Notes (request ids, error text) |
| ----------------------------- | -------- | -------- | ------------------------------- |
| `edge.https`                  |          |          |                                 |
| `edge.http-redirect`          |          |          |                                 |
| `api.health`                  |          |          |                                 |
| `api.request-id`              |          |          | id found in API log: yes/no     |
| `auth.sign-in`                |          |          |                                 |
| `auth.production-cookie`      |          |          |                                 |
| `edge.same-origin`            |          |          |                                 |
| `voyage.create`               |          |          | reference                       |
| `access.before-participation` |          |          |                                 |
| `trade-string.setup`          |          |          |                                 |
| `sse.connected`               |          |          |                                 |
| `sse.instruction-delivered`   |          |          | delivered after … ms            |
| `document.upload`             |          |          | size, SHA-256, request id       |
| `document.download`           |          |          |                                 |
| `access.documents`            |          |          |                                 |
| `restart.checkpoint`          |          |          | checkpoint/confirmed at         |
| `restart.stream-reconnected`  |          |          | drop/reconnect ms per party     |
| `restart.session`             |          |          |                                 |
| `restart.database`            |          |          |                                 |
| `restart.document-bytes`      |          |          |                                 |
| `restart.sse-delivery`        |          |          |                                 |
| `auth.sign-out`               |          |          |                                 |

## Restart

| Field                           | Value                                                |
| ------------------------------- | ---------------------------------------------------- |
| Command, target                 | `systemctl restart tradeflow-api` on `<instance_id>` |
| Container ID before / after     | `…` / `…` (exactly one each)                         |
| Restart to ready                | `<s>` (from `systemctl` / `docker ps` times)         |
| Stream drop and reconnect       | from `restart` in the results                        |
| Sessions, rows, bytes unchanged | from `restart.*` checks                              |

## Recovery rehearsal

| Field                           | Value                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Backup id, location, encryption | `<id>`, `<where it is kept>`, `<how>`                                                                            |
| Writers stopped / resumed       | `<UTC>` / `<UTC>` (downtime `<min>`)                                                                             |
| Source reconcile                | versions `<n>`, problems `[]`, orphans `[]`                                                                      |
| Recovery point (`source.json`)  | latest audit event `<UTC>`, audit events `<n>`, document versions `<n>`, migration `<name>`; exported at `<UTC>` |
| Checksums                       | `database.dump` `…`, `manifest.json` `…`, `source.json` `…`                                                      |
| Targets                         | database `tradeflow_restore_<date>` on `<instance>`, prefix `tradeflow/restore-<date>/`                          |
| `restore-check` on source       | refused: `<reasons printed>`                                                                                     |
| `restore-check` on targets      | `"refusals": []`; identities compared by `<operator>`                                                            |
| `pg_restore`, import, reconcile | durations; restored reconcile problems `[]`, orphans `[]`                                                        |
| Restored-mode suite             | outcome per `restored.*` check                                                                                   |
| **Measured restore time**       | step 8 to the restored-mode pass: `<min>`. A rehearsal measurement, not an RTO                                   |
| Return to source                | health 200 and sign-in at `<UTC>`                                                                                |

## Not verified in this run

List anything skipped, failed, or not covered by the suite (see the runbook's
"not verified" row), with the reason. RPO/RTO and availability guarantees remain unestablished
unless a separate decision sets them.
