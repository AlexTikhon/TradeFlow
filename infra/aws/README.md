# infra/aws

Terraform for TradeFlow's single-instance AWS portfolio environment. Not yet applied to any
account. Read [docs/aws-infrastructure.md](../../docs/aws-infrastructure.md) (resources, inputs,
state, deployment contract) and [docs/aws-cost-worksheet.md](../../docs/aws-cost-worksheet.md)
before running anything against AWS.

| Path                  | Contents                                                        |
| --------------------- | --------------------------------------------------------------- |
| `*.tf`, `templates/`  | Main configuration (remote S3 state, partial backend config)    |
| `tests/`              | `terraform test` files, mock AWS provider only                  |
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

Run them in this directory and in `bootstrap/`.
