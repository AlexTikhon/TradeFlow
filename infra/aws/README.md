# infra/aws

Terraform for TradeFlow's single-instance AWS portfolio environment. Not yet applied to any
account. Read [docs/aws-infrastructure.md](../../docs/aws-infrastructure.md) (resources, inputs,
state, deployment contract) and [docs/aws-cost-worksheet.md](../../docs/aws-cost-worksheet.md)
before running anything against AWS.

| Path                  | Contents                                                        |
| --------------------- | --------------------------------------------------------------- |
| `*.tf`, `templates/`  | Main configuration (remote S3 state, partial backend config)    |
| `tests/`              | `terraform test` files (mock AWS provider only); `*.test.js`    |
| `bootstrap/`          | State bucket, applied first with local state; its own tests     |
| `*.example`           | Fictional inputs; copy without `.example` (ignored by Git)      |
| `.terraform.lock.hcl` | Provider versions and hashes (linux, macOS, Windows), committed |

Offline checks (no AWS credentials or backend; the CI `iac` job runs the same):

```sh
terraform fmt -check -recursive
terraform init -backend=false -lockfile=readonly
terraform validate
terraform test
```

Run them in this directory and in `bootstrap/`. From the repository root, `pnpm test:infra` runs
the Node tests in `tests/` (also in the `iac` job). They run the user-data `DATABASE_URL` check
(`templates/check-database-url.sh`) against the API's locked node-postgres, including TLS
handshakes with throwaway certificates, and guard against automatic ECR image expiry. They need
`bash` and `openssl` on `PATH` (Git Bash provides both on Windows) and installed dependencies.
