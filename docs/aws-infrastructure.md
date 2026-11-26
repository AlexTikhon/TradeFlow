# AWS infrastructure foundation and deployment contract

Terraform for TradeFlow's first AWS environment: a small portfolio deployment that maps the
[deployment mock](deployment-mock.md) onto real services. Decision record:
[ADR 0022](decisions/0022-aws-infrastructure-foundation.md). Prices:
[cost worksheet](aws-cost-worksheet.md).

> **Status, 2026-11-26.** Configuration, offline tests and this contract only. Nothing has been
> provisioned, no AWS account or credentials were used, no image was published, no DNS changed,
> and no real `terraform plan`, `apply` or `destroy` has run. Every AWS behavior below is a
> design to prove in the next step, not observed evidence. See [Verification](#verification).

## Resources proposed

`infra/aws` (main configuration, remote state) and `infra/aws/bootstrap` (state bucket, local
state). No ALB, NAT gateway, VPC interface endpoint, Kubernetes, CloudWatch log group, KMS key or
Budgets resource is created.

| Resource                               | Configuration                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VPC                                    | Dedicated `/16` (default `10.40.0.0/16`), DNS on, default security group stripped of all rules                                                                                                                           |
| Public subnet (1 AZ)                   | Route to an internet gateway; no auto-assigned public IPs except the instance's first-boot address                                                                                                                       |
| Database subnets (2 AZs)               | Route table with only the local route: no path to or from the internet                                                                                                                                                   |
| EC2 instance                           | Amazon Linux 2023, `instance_type`/`instance_architecture` chosen by the operator, IMDSv2 required (hop limit 2), encrypted gp3 root, no key pair, standard CPU credits on burstable types, replaced on user-data change |
| Elastic IP                             | One public IPv4 address for the DNS A record, stable across stop/start and replacement                                                                                                                                   |
| Caddy state volume                     | Encrypted 1 GiB gp3 in the instance's AZ, reattached on replacement, final snapshot on destroy                                                                                                                           |
| Security group `app`                   | In: TCP 80, 443 from anywhere. Out: TCP 443 anywhere, TCP 5432 to `database`                                                                                                                                             |
| Security group `database`              | In: TCP 5432 from `app` only. No egress                                                                                                                                                                                  |
| RDS PostgreSQL 18                      | Single-AZ in the instance's AZ, private, encrypted gp3, `rds.force_ssl=1`, CA `rds-ca-rsa2048-g1`, RDS-managed master secret, 7-day backups kept after deletion, deletion protection, final snapshot                     |
| S3 document bucket                     | Public access blocked, bucket owner enforced (no ACLs), SSE-S3, versioning, TLS-only policy, lifecycle aborts incomplete multipart uploads after 7 days and expires nothing else                                         |
| ECR `<env>/api`, `/web`, `/tools`      | Immutable tags, scan on push, AES256, no forced deletion; untagged images expire after 14 days, at most 20 images kept                                                                                                   |
| Secrets `app-database`, `migrator-db…` | Containers only, 30-day recovery window; values written by the operator, never by Terraform                                                                                                                              |
| SSM parameter `/<env>/release`         | Non-secret, digest-pinned image references; created as `unset`, never overwritten by Terraform                                                                                                                           |
| IAM instance role + profile            | One inline policy (below); Terraform removes any other inline or managed policy on apply                                                                                                                                 |
| State bucket (bootstrap)               | `tradeflow-tfstate-<account>-<region>`: versioned, SSE-S3, public access blocked, TLS-only, old noncurrent versions expire after 90 days (newest 10 kept)                                                                |

The instance, its Caddy volume and the database share one AZ (the first available). The second
database subnet exists only because a DB subnet group must span two AZs.

## Inputs

Required, no defaults: a real plan cannot start without them.

| Variable                   | Meaning                                                    | Fictional example (`terraform.tfvars.example`) |
| -------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `aws_account_id`           | The only account the provider accepts                      | `123456789012`                                 |
| `aws_region`               | Commercial Region                                          | `eu-central-1` (example only)                  |
| `domain_name`              | Hostname Caddy serves                                      | `portfolio.tradeflow.example`                  |
| `instance_type`            | EC2 type; must support `instance_architecture`, Nitro only | `t4g.small`                                    |
| `instance_architecture`    | `arm64` or `x86_64`; also the image platform               | `arm64`                                        |
| `db_instance_class`        | RDS class                                                  | `db.t4g.micro`                                 |
| `db_allocated_storage_gib` | RDS gp3 storage, 20–1000                                   | `20`                                           |

Reviewable defaults: `environment = "portfolio"` (names are `tradeflow-portfolio-*`),
`db_max_allocated_storage_gib = null` (no storage autoscaling), `db_backup_retention_days = 7`,
`root_volume_size_gib = 20`, `caddy_state_volume_size_gib = 1`, `vpc_cidr = "10.40.0.0/16"`,
`document_prefix = "tradeflow/"`, `secret_recovery_window_days = 30`, `ami_id = null` (latest
AL2023 for the architecture, read from AWS's public SSM parameter at plan time; later releases do
not replace the instance until `terraform apply -replace=aws_instance.app`).

There is no variable for a password, a connection string or a notification recipient.

### Values still needed before deployment

1. AWS account ID, and the IAM identity (SSO role) that will run Terraform in it.
2. Region.
3. Domain name and who controls its DNS zone (an A record must point at the Elastic IP).
4. Instance type and architecture (and therefore the image build platform/builder).
5. RDS instance class and allocated storage.
6. Monthly budget ceiling and alert recipients (unselected; see the cost worksheet).
7. Confirmation or change of each default above, especially backup retention and environment name.
8. Whether `PORTFOLIO_DEMO_WRITE_PROTECTION` (ADR 0021) is enabled when the portfolio rollout happens
   (not set by this configuration).

## State

Remote state lives in its own bucket, created first by `infra/aws/bootstrap`; it is never the
document bucket. State holds resource IDs, the RDS endpoint, rendered user data and ARNs but no
password or secret value (the configuration has none to store). Treat it as sensitive anyway.

Bootstrap order, with the operator's own SSO credentials for the chosen account:

1. `cd infra/aws/bootstrap`, write an untracked `terraform.tfvars` with `aws_account_id` and
   `aws_region`, then `terraform init`, `terraform plan -out=bootstrap.tfplan`, review,
   `terraform apply bootstrap.tfplan`. Its local `terraform.tfstate` (bucket settings only) is kept
   with the operator's records or imported later; it is ignored by Git.
2. `cd infra/aws`, copy `backend.hcl.example` to `backend.hcl` and `terraform.tfvars.example` to
   `terraform.tfvars`, replace every value, then `terraform init -backend-config=backend.hcl`.
3. `terraform plan -out=portfolio.tfplan`, review, `terraform apply portfolio.tfplan`. Saved plans
   contain resolved values: delete them after use (they are ignored by Git and by Docker builds).

Locking uses the S3 backend's native lock object (`use_lockfile = true`, `<key>.tflock`), not
DynamoDB, which the backend documents as deprecated. Both the provider and the backend refuse
credentials for any account other than `aws_account_id`/`allowed_account_ids`. The Terraform
identity needs, on the state bucket: `s3:ListBucket` on the bucket (at least the state key
prefix), `s3:GetObject`/`s3:PutObject` on the state key, and `s3:GetObject`/`s3:PutObject`/
`s3:DeleteObject` on `<key>.tflock` ([S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)).
Beyond that it needs create/update/delete rights for the resources listed above; a least-privilege
deployment policy is still to be written in the next step.

## Deployment contract

### Images and architecture

The existing `deploy/Dockerfile` targets are reused unchanged: `api` (pruned Node runtime, uid
1000), `web` (Caddy + SPA, uid 1000) and `tools` (Prisma migrations). Their pinned base images
are multi-platform indexes with `linux/amd64` and `linux/arm64` (checked 2026-11-26 with
`docker buildx imagetools inspect`). Each image is built for exactly the instance platform
(`terraform output image_platform`) and pushed as a single-platform manifest, so ECR's untagged
rule never sees index children:

```sh
docker buildx build --platform linux/arm64 --provenance=false --sbom=false \
  --file deploy/Dockerfile --target api --tag <registry>/tradeflow-portfolio/api:<git-sha> --push .
```

Building arm64 on an x86-64 workstation needs QEMU emulation or an arm64 builder; this has not
been measured. Pushing needs the operator's ECR credentials; the instance role cannot push. At
every start the instance checks that each pulled image's architecture equals the host's and
refuses to run a mismatch.

### Topology and ports

```text
internet ──TCP 80/443──▶ EC2 (Elastic IP)
                          ├─ tradeflow-edge  172.30.0.10  host 80→8080, 443→8443  (Caddy, SPA)
                          │        └─ /api → api:3000 (Docker network tradeflow-front)
                          └─ tradeflow-api   172.30.0.20  port 3000, not published
EC2 ──TCP 5432, TLS verify-full──▶ RDS (private subnets)
EC2 ──HTTPS──▶ S3, Secrets Manager, SSM, ECR, ACME CA, AL2023 repositories, RDS CA bundle
```

One API container (ADR 0020's single process: SSE fan-out and sign-in admission are in process).
Each container runs in the foreground under a systemd unit (`tradeflow-api`, `tradeflow-edge`)
with a read-only root filesystem, tmpfs `/tmp`, all capabilities dropped and
`no-new-privileges`. Docker publishes host ports with DNAT, so Caddy sees the real client
address. Port 3000, PostgreSQL and S3 are never exposed. There is no UDP 443 rule, so Caddy's
HTTP/3 advertisement is unreachable and clients stay on HTTP/1.1 or HTTP/2 over TCP.

### Environment

API (`/etc/tradeflow/api.env`, written by user data, no secrets):

| Variable                  | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| `NODE_ENV`                | `production` (Secure `__Host-` session cookie, ADR 0007) |
| `HOST`, `PORT`            | `0.0.0.0`, `3000`                                        |
| `TRUSTED_PROXY_CIDRS`     | `172.30.0.10/32`: the edge's fixed address only          |
| `DOCUMENT_STORAGE_DRIVER` | `s3`                                                     |
| `S3_BUCKET`, `S3_REGION`  | the document bucket, `aws_region`; no `S3_ENDPOINT`      |
| `S3_PREFIX`               | `document_prefix` (default `tradeflow/`)                 |
| `AWS_REGION`              | `aws_region`                                             |
| `HTTP_REQUEST_LOG`        | `enabled`                                                |

`DATABASE_URL` comes from the `app-database` secret at each start (below). Edge
(`/etc/tradeflow/edge.env`): `APP_DOMAIN=<domain_name>`; the image's public Caddyfile
(`deploy/Caddyfile`) obtains a certificate for that name via ACME.

Preserved from the mock: same-origin HTTPS (SPA and `/api` on one host), production cookies,
explicit proxy trust (a fixed `/32`, never a range or hop count), unbuffered SSE through Caddy
(`flush_interval -1`), forwarded-header overwrite, server-generated `X-Request-ID` with one JSON
lifecycle record per request on standard output, and private document access only through the
API's authorization. `PORTFOLIO_DEMO_WRITE_PROTECTION` is not set.

### Instance credentials

The instance role is the only AWS credential on the host. Docker containers on a bridge network
are one network hop further from the metadata service than host processes. With IMDSv2's default
hop limit of 1, the token response would not reach them, and the API would have no S3 or Secrets
Manager credentials. The limit is therefore 2. That would let **every** container fetch role
credentials, so the start-time script inserts a `DOCKER-USER` rule that drops traffic to
`169.254.169.254` from any container except the API's fixed address. Host processes (the SSM
agent, the ECR credential helper, the AWS CLI in the start script) are unaffected.

Implications to accept explicitly:

- Anything that runs inside the API container (including a code-execution bug) can use the whole
  role: pull the three images, read the application secret and release parameter, read and write
  document objects under the prefix, and use the SSM agent channel actions. It cannot list the
  bucket, read the migrator or master secrets, push images, send SSM commands or change IAM.
- IMDSv2 still requires a PUT for a session token, which ordinary request-forgery bugs cannot
  issue. IMDSv1 is disabled, and the IPv6 metadata endpoint and instance tags in metadata are off.
- The guard is a host firewall rule, re-applied before every container start. It is not
  enforced by AWS, and has not yet been observed on a real instance.

The ECR credential helper (`amazon-ecr-credential-helper`, configured for this registry only)
obtains pull tokens from the instance role; no registry password is stored.

### Database TLS and roles

The API connects with node-postgres through Prisma's adapter. In `pg-connection-string` 2.14.1
(the locked version), `sslmode=verify-full` keeps certificate and hostname verification on and
`sslrootcert` loads the CA file:

```text
postgresql://tradeflow_app:<hex>@<database_address>:5432/tradeflow?sslmode=verify-full&sslrootcert=/etc/tradeflow/rds-ca.pem
```

User data downloads the Region's RDS CA bundle over verified HTTPS to `/etc/tradeflow/rds-ca.pem`
and mounts it read-only. The start script refuses an application URL without
`sslmode=verify-full` and that CA path. The server side refuses plaintext (`rds.force_ssl=1`).
Migrations run Prisma's schema engine, whose documented TLS parameters differ
(`sslmode=require&sslcert=/etc/tradeflow/rds-ca.pem&sslaccept=strict`). Before trusting it, the
rehearsal must show that it rejects a wrong CA and a wrong hostname.

Three database roles, three secrets:

| Role                 | Purpose                                  | Credential                         | Readable by        |
| -------------------- | ---------------------------------------- | ---------------------------------- | ------------------ |
| `tradeflow_admin`    | RDS master, administration only          | RDS-managed secret, rotated by RDS | operator           |
| `tradeflow_migrator` | Owns the schema; runs migrations         | `<env>/migrator-database` (JSON)   | operator           |
| `tradeflow_app`      | API: data access on tables and sequences | `<env>/app-database` (JSON)        | instance, operator |

Proposed one-time setup as `tradeflow_admin`, from a `postgres:18` container on the instance
(an SSM session with the operator's own temporary credentials exported into that shell to read
the master secret). Passwords from `openssl rand -hex 32` need no URL encoding:

```sql
CREATE ROLE tradeflow_migrator LOGIN PASSWORD :'migrator_password';
CREATE ROLE tradeflow_app LOGIN PASSWORD :'app_password';
GRANT tradeflow_migrator TO CURRENT_USER WITH INHERIT FALSE, SET TRUE; -- to transfer ownership
REVOKE ALL ON DATABASE tradeflow FROM PUBLIC;
GRANT CONNECT ON DATABASE tradeflow TO tradeflow_migrator, tradeflow_app;
ALTER SCHEMA public OWNER TO tradeflow_migrator;
GRANT USAGE ON SCHEMA public TO tradeflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tradeflow_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tradeflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tradeflow_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tradeflow_app;
```

Then write each secret as `{"DATABASE_URL": "..."}` with
`aws secretsmanager put-secret-value --secret-string file:///dev/stdin`. Do not use a command-line
argument, which shell history and process listings keep. This SQL is unrehearsed. Check it
against PostgreSQL 18 role semantics and the app's actual statements in the first rehearsal.
`tradeflow_app` also gains data access to `_prisma_migrations` through the default privileges; revoking that is
a possible refinement.

The URL reaches the API through a root-only file on tmpfs (`/run/tradeflow/api-secrets.env`,
`0600`) and Docker's `--env-file`. While the container exists, its configuration (including the
variable) is visible to root through `docker inspect` and is stored on the encrypted root volume.
Root on the instance can read the secret anyway.

### Caddy state and logs

`/var/lib/tradeflow/caddy/{data,config}` live on the separate encrypted volume, owned by uid 1000.
User data formats it only when it has no filesystem. A replacement instance therefore keeps the
ACME account and certificates instead of re-issuing them (certificate authorities rate-limit
duplicate certificates). Docker uses the `local` log driver with `max-size 10m`, `max-file 5` per
container (at most about 50 MB each before compression): bounded on the root volume, readable
with `docker logs`/`journalctl`, and lost when the instance is replaced. There is no CloudWatch
Logs shipping in this increment.

### Release

The release is an SSM parameter holding JSON:

```json
{
  "api": "<registry>/tradeflow-portfolio/api@sha256:<digest>",
  "web": "<registry>/tradeflow-portfolio/web@sha256:<digest>",
  "tools": "<registry>/tradeflow-portfolio/tools@sha256:<digest>"
}
```

Before every container start, the start script reads it, accepts only this environment's
repositories pinned by digest, pulls the image and checks its architecture. While the parameter
is `unset`, both units retry every 30 s and log `No release yet`. To release: push the images,
run any migrations (next section), `aws ssm put-parameter --overwrite` the JSON, then
`sudo systemctl restart tradeflow-api tradeflow-edge` in an SSM session. Rolling back is the
same with the previous digests, provided the schema is still compatible with them.

### Explicit operator operations

Nothing migrates or seeds at boot or at container start. `tradeflow-migrate` (root-only, written
by user data) takes the tools image by digest and reads the migrator URL from standard input.
The operator fetches it with their own credentials, never the instance role:

```sh
aws secretsmanager get-secret-value --secret-id <migrator_database_secret_arn> \
  --query SecretString --output text | jq -r .DATABASE_URL \
  | sudo tradeflow-migrate <registry>/tradeflow-portfolio/tools@sha256:<digest>
```

The fictional demo seed (published passwords) must never run against this environment. Portfolio
fixture preparation, a hosted reset schedule and public rollout are later steps and are not
implemented here.

### Instance replacement

A changed user data (or `-replace`) destroys the old instance before creating the new one: the
default lifecycle, deliberately not `create_before_destroy`. There are never two API processes.
The Caddy volume is detached (the instance is stopped first) and reattached, and the Elastic IP
moves, so DNS does not change. The new instance installs packages, mounts the volume, fetches
the CA bundle, and starts the units, which run the last released digests. The database and bucket
are untouched and sessions survive. Expect several minutes of downtime: in-flight requests and
SSE streams drop (clients reconnect), and an upload interrupted mid-stream can leave a staged
object that reconciliation reports as unreferenced. Root-volume contents (images, logs, the tmpfs
secret file) are discarded.

### Recovery

The paired offline backup and restore in [storage recovery](storage-recovery.md) applies unchanged.
Stop writers with `systemctl stop tradeflow-api`. Run `pg_dump`/`pg_restore` with PostgreSQL 18
client tools (for example from a `postgres:18` container on the instance). Run
`storage:objects verify|export|import` from the tools image with a separate maintenance identity
that has the prefix-scoped `ListBucket`/`ListBucketMultipartUploads` the instance role lacks.
Restore into a new empty database and bucket or prefix, never over the current one. RDS automated
backups and point-in-time restore exist and S3 never expires complete objects, but an online or
point-in-time pairing of the two stores is not established (ADR 0019). No AWS restore has been
rehearsed, so RPO/RTO are unknown.

## IAM

The instance role has one inline policy, built in `infra/aws/iam.tf` and asserted exactly by the
offline tests:

| Statement                   | Actions                                                                                                        | Resource                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `SsmAgentChannel`           | `ssm:UpdateInstanceInformation`, `ssmmessages:{Create,Open}{Control,Data}Channel`, six `ec2messages:*` actions | `*`                                                      |
| `EcrAuthorizationToken`     | `ecr:GetAuthorizationToken`                                                                                    | `*`                                                      |
| `EcrPullReleaseImages`      | `ecr:BatchCheckLayerAvailability`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`                           | the three repositories                                   |
| `DocumentObjects`           | `s3:GetObject`, `PutObject`, `DeleteObject`, `AbortMultipartUpload`, `ListMultipartUploadParts`                | `arn:aws:s3:::<bucket>/<prefix>*`                        |
| `ApplicationDatabaseSecret` | `secretsmanager:GetSecretValue`                                                                                | the `app-database` secret                                |
| `ReleaseParameter`          | `ssm:GetParameter`                                                                                             | `arn:aws:ssm:<region>:<account>:parameter/<env>/release` |

The `Resource "*"` exceptions are unavoidable. `ecr:GetAuthorizationToken` is registry-wide and
has no resource type. The Session Manager/Run Command agent channel actions are `*` in AWS's
minimal custom instance policy. AWS's broader managed `AmazonSSMManagedInstanceCore` is not
attached: it also grants `ssm:GetParameter(s)` on every parameter. The secrets use the AWS-managed
`aws/secretsmanager` key, and the volumes, database and buckets use AWS-managed or S3-managed
keys, so no `kms:` permission is needed. Without `s3:ListBucket`, reading a missing key returns
AccessDenied. The adapter reports that as a 5xx rather than a missing document, which is the
conservative outcome. Reconciliation uses the maintenance identity.

## Retention and deletion

| Resource                 | Default                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RDS                      | Deletion protection; final snapshot `tradeflow-<env>-final` (an existing snapshot of that name makes destroy fail); automated backups retained after deletion until their retention ends |
| Document bucket          | `force_destroy = false`: a bucket with objects or versions cannot be destroyed; versions kept indefinitely                                                                               |
| ECR repositories         | `force_delete = false`: a repository with images cannot be destroyed                                                                                                                     |
| Secrets                  | 30-day recovery window. The RDS master secret is deleted with the instance (AWS documents this)                                                                                          |
| Caddy volume             | Final snapshot on destroy                                                                                                                                                                |
| Root volume, Elastic IP  | Deleted/released with the instance/configuration                                                                                                                                         |
| State bucket (bootstrap) | `force_destroy = false`; current state never expires                                                                                                                                     |

`terraform destroy` therefore stops at the bucket, repositories and database until an operator
deliberately empties them or turns protection off. The retained snapshots, versions and images
keep costing money: see [retained costs](aws-cost-worksheet.md#after-terraform-destroy).

## Verification

| Kind                                   | What                                                                                                                                                                                                                                                                                                         | Result (2026-11-26)                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static                                 | `terraform fmt -check -recursive`, `init -backend=false`, `validate` (main and bootstrap); Terraform 1.17.2 (SHA-256 and HashiCorp signature verified), AWS provider 6.74.0                                                                                                                                  | Passed                                                                                                                                                                                       |
| Mock-provider tests (`terraform test`) | 22 runs (main) + 2 (bootstrap): private DB/S3, ingress, IMDSv2, encryption, deletion protections, exact IAM policy, user-data contract, input validation, architecture checks                                                                                                                                | Passed; no AWS credentials, no API calls                                                                                                                                                     |
| Mutation check                         | 28 single-line regressions, each applied to a scratch copy (public DB, SSH rule, IMDSv1, hop limit, `s3:ListBucket`, whole-bucket S3, migrator-secret access, managed policy, proxy range, boot-time migration, unbounded logs, IMDS guard, weaker DB TLS, architecture/Nitro checks, account validation, …) | All 28 failed a test assertion. A first pass let 2 through (IMDS guard, DB TLS: string checks too loose) and 2 hit invalid expressions; those asserts and mutations were corrected and rerun |
| User data                              | Rendered with fictional inputs (10 KB of the 16 KB limit); `bash -n` and ShellCheck 0.11.0 on it and its three embedded scripts; packages confirmed in `amazonlinux:2023` repositories (docker 25.0.18)                                                                                                      | Passed                                                                                                                                                                                       |
| Local deployment evidence              | `pnpm deploy:verify` on Windows, Docker 29.9.3 (the existing mock; unchanged images and Caddyfile, `.dockerignore` now excludes `infra`)                                                                                                                                                                     | Passed: 1 test, 8 steps, no retries; containers, volumes, networks and image tags matched the pre-run state                                                                                  |
| **Not performed**                      | Any AWS API call, real plan/apply/destroy, IAM simulation, SSM session, IMDS guard on EC2, RDS TLS, ACME issuance, arm64 image build, migration as `tradeflow_migrator`, restore rehearsal                                                                                                                   | Next step                                                                                                                                                                                    |

The mocked runs prove the configuration's shape, not AWS behavior. A mock provider returns
invented IDs and accepts any value, so AWS-side validation (instance type availability, the
`postgres18` parameter group, name limits, IAM policy grammar) happens only in a real plan.
