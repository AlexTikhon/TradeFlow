# ADR 0022: AWS infrastructure foundation for a single-instance portfolio environment

Status: Proposed (configuration and offline tests only; nothing provisioned)

Date: 2026-11-26

## Context

ADR 0020 built a local mock of the intended AWS mapping: EC2 with a same-origin Caddy edge,
private RDS PostgreSQL 18, private S3, an instance role and SSM administration. The next step is
the infrastructure code for that mapping, reviewable before any account, domain or budget is
chosen. The environment is a small portfolio deployment. Cost and operational simplicity matter
more than availability. The application assumes one API process (in-process SSE fan-out and
sign-in admission).

## Decision

Terraform in `infra/aws` (Terraform `~> 1.17`, AWS provider `~> 6.74`, lockfile committed) with a
separate `infra/aws/bootstrap` for the remote-state bucket. Details are in
[AWS infrastructure](../aws-infrastructure.md).

- **Compute:** one EC2 instance (Amazon Linux 2023, Nitro, IMDSv2 only) runs the existing `api`
  and `web` images under systemd. It sits in a public subnet with an Elastic IP; its security
  group admits only TCP 80/443. There is no SSH: administration is through SSM Session Manager.
- **Database:** RDS PostgreSQL 18, private, single-AZ in the instance's AZ, encrypted, TLS
  forced, RDS-managed master secret, deletion protection and a final snapshot. The application
  and migration roles are separate from the master account and from each other. Their URLs live
  in secrets whose values Terraform never sets.
- **Documents:** a private, versioned, SSE-S3 bucket with ACLs disabled and TLS required. Only
  incomplete multipart uploads expire.
- **Images and releases:** three ECR repositories with immutable tags. The instance runs the
  digests named in an SSM parameter, so a replacement instance returns to the last release.
  Images are built for the instance's architecture, which is a required input checked against
  the instance type. Images never expire automatically: no ECR expiry rule can tell whether a
  digest is still released or kept for rollback, so cleanup is an explicit operator step that
  preserves those digests.
- **Database TLS:** the instance accepts the application URL only in one literal shape
  (`sslmode=verify-full` and the RDS CA path, each exactly once). The check is tested against
  the locked node-postgres parser, which honors the last repeated parameter.
- **Credentials:** one instance role with an exact inline policy. IMDS hop limit 2 lets the API
  container obtain it; a host firewall rule keeps every other container away from IMDS.
- **Operations:** migrations and any fixture preparation stay explicit operator commands.
  Nothing migrates or seeds at boot.
- **Verification:** `terraform test` with mock providers and a CI job without AWS credentials.

## Alternatives considered

- **ECS/Fargate behind an ALB.** Managed restarts and rolling deploys, but an ALB costs more per
  month than the whole instance, and rolling deploys would briefly run two API processes, which
  the in-process SSE and admission design does not allow.
- **Private subnet with a NAT gateway or VPC interface endpoints.** Removes the public address
  from the instance's network path, but a NAT gateway or a set of endpoints costs several times
  the instance. Security groups plus no SSH give the needed exposure (80/443 only).
- **Multi-AZ RDS.** Survives an AZ failure, but roughly doubles the database cost. Recovery for
  this environment is the paired backup/restore procedure (ADR 0019).
- **Hop limit 1 with host networking for the API.** Keeps IMDS from containers without a
  firewall rule, but removes network isolation between the API and the host, and the fixed proxy
  address the trust rule depends on.
- **Terraform-managed database roles (PostgreSQL provider) or `random_password`.** Would put
  passwords in state.
- **SSM Parameter Store SecureStrings instead of Secrets Manager.** Cheaper per secret, but RDS's
  managed master password uses Secrets Manager anyway. Keeping all three in one service keeps
  access policies uniform.

## Consequences

- Single points of failure: one instance, one AZ, one database. Replacement or AZ failure means
  minutes of downtime or more. Acceptable here; documented.
- The API container can use the whole instance role. The role is narrow, but that is a real
  trust boundary to keep in mind.
- No real plan has run. AWS-side validation, IAM behavior, RDS TLS from both clients, ACME
  issuance and restore are proven only in the next, provisioning step.
- Retained resources (final snapshots, versions, images, secrets in their recovery window) keep
  costing money after destroy ([cost worksheet](../aws-cost-worksheet.md)).
- Registry storage grows with every pushed build until an operator deletes specific digests.
  Forgetting cleanup costs money slowly; automatic expiry could break a restart or rollback.
