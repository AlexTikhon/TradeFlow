# AWS cost worksheet: portfolio environment

Estimate for the resources in [AWS infrastructure](aws-infrastructure.md), dated **2026-11-26**.
It is a worksheet, not a quote or a bill. Replace the assumptions with observed usage once the
environment exists.

- **Region:** `eu-central-1` (Frankfurt), an example for pricing only, not a selected Region.
- **Sizes:** the fictional example inputs: `t4g.small` (arm64), `db.t4g.micro`, 20 GiB RDS gp3,
  20 GiB root volume, 1 GiB Caddy volume.
- **Prices:** On-Demand, USD, excluding tax. No Free Tier, credits, Savings Plans or Reserved
  Instances are assumed, including the global 100 GB/month data-transfer allowance.
- **Budget:** the monthly budget is **not selected**. No AWS Budgets alert or notification
  recipient is configured. An alert only notifies; it is not a spending cap, and charges keep
  accruing after it fires.

## Sources

AWS Price List bulk offer files for `eu-central-1`
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/eu-central-1/index.csv`),
retrieved 2026-11-26. Publication timestamps: AmazonEC2 2026-11-24T23:14Z, AmazonRDS
2026-11-24T23:30Z, AmazonS3 2026-11-25T15:26Z, AmazonECR 2026-11-25T15:02Z, AWSSecretsManager
2026-11-25T15:01Z, AmazonVPC 2026-11-25T05:52Z, AWSDataTransfer 2026-11-19T10:58Z.

| Rate                                      | Price                     | Price-list usage type                        |
| ----------------------------------------- | ------------------------- | -------------------------------------------- |
| EC2 `t4g.small`, Linux, shared            | $0.0192 / hour            | `EUC1-BoxUsage:t4g.small`                    |
| EC2 `t4g.medium`                          | $0.0384 / hour            | `EUC1-BoxUsage:t4g.medium`                   |
| EC2 `t3.small` (x86_64)                   | $0.024 / hour             | `EUC1-BoxUsage:t3.small`                     |
| EC2 `t3.medium` (x86_64)                  | $0.048 / hour             | `EUC1-BoxUsage:t3.medium`                    |
| EC2 T4g surplus CPU credits               | $0.04 / vCPU-hour         | `EUC1-CPUCredits:t4g`                        |
| EBS gp3 storage                           | $0.0952 / GB-month        | `EUC1-EBS:VolumeUsage.gp3`                   |
| EBS snapshot storage                      | $0.054 / GB-month         | `EUC1-EBS:SnapshotUsage`                     |
| Public IPv4 address, in use or idle       | $0.005 / hour             | `EUC1-PublicIPv4:InUseAddress`/`IdleAddress` |
| RDS PostgreSQL `db.t4g.micro`, Single-AZ  | $0.019 / hour             | `EUC1-InstanceUsage:db.t4g.micro`            |
| RDS PostgreSQL `db.t4g.small`, Single-AZ  | $0.037 / hour             | `EUC1-InstanceUsage:db.t4g.small`            |
| RDS PostgreSQL `db.t4g.medium`, Single-AZ | $0.074 / hour             | `EUC1-InstanceUsage:db.t4g.medium`           |
| RDS gp3 storage (PostgreSQL)              | $0.137 / GB-month         | `EUC1-RDS:GP3-Storage`                       |
| RDS backup storage beyond free allocation | $0.103 / GB-month         | `EUC1-RDS:ChargedBackupUsage`                |
| RDS PostgreSQL T4g surplus CPU credits    | $0.075 / vCPU-hour        | `EUC1-CPUCredits:db.t4g` (engine code 14)    |
| S3 Standard storage, first 50 TB          | $0.0245 / GB-month        | `EUC1-TimedStorage-ByteHrs`                  |
| S3 PUT, COPY, POST, LIST requests         | $0.0054 / 1,000           | `EUC1-Requests-Tier1`                        |
| S3 GET and other requests                 | $0.0043 / 10,000          | `EUC1-Requests-Tier2`                        |
| ECR storage                               | $0.10 / GB-month          | `EUC1-TimedStorage-ByteHrs` (ECR)            |
| Secrets Manager secret                    | $0.40 / secret-month      | `EUC1-AWSSecretsManager-Secrets`             |
| Secrets Manager API requests              | $0.05 / 10,000            | `EUC1-AWSSecretsManagerAPIRequest`           |
| Data transfer out to the internet, 10 TB  | $0.09 / GB                | `EUC1-DataTransfer-Out-Bytes`                |
| Cross-AZ / Elastic IP regional transfer   | $0.01 / GB each direction | `EUC1-DataTransfer-Regional-Bytes`           |

## Usage assumptions

| Assumption              | Value                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running hours           | 730 per month (always on)                                                                                                                                                                                             |
| CPU                     | EC2 in `standard` credit mode (throttles, never bills credits); RDS T4g runs in Unlimited mode (AWS: "RDS for PostgreSQL T4g and T3 DB instances run in Unlimited mode"), assumed below baseline on a 24-hour average |
| Documents in S3         | 5 GB-month including noncurrent versions (versions never expire by default)                                                                                                                                           |
| S3 requests             | 10,000 PUT/LIST-class and 100,000 GET-class per month (uploads, multipart parts, downloads)                                                                                                                           |
| ECR                     | 3 GB stored across api/web/tools (up to 20 images each, layers shared), pulls in-Region                                                                                                                               |
| Secrets                 | 3 secrets (RDS master, app, migrator); about 2,000 API calls per month                                                                                                                                                |
| Internet egress         | 20 GB per month (SPA assets, API responses, PDF downloads)                                                                                                                                                            |
| Cross-AZ                | 0 GB: instance and database are placed in the same AZ                                                                                                                                                                 |
| RDS backups             | 7-day retention within the free backup allocation (assumed equal to provisioned storage; the conservative column charges 20 GB)                                                                                       |
| Logs, metrics, sessions | Docker logs stay on the instance; basic EC2/RDS metrics, SSM Session Manager and standard Parameter Store parameters are not charged                                                                                  |

## Running month

| Item                     | Calculation                   | Estimate   | Conservative |
| ------------------------ | ----------------------------- | ---------- | ------------ |
| EC2 `t4g.small`          | 730 h × $0.0192               | $14.02     | $14.02       |
| EBS root volume          | 20 GB × $0.0952               | $1.90      | $1.90        |
| EBS Caddy state volume   | 1 GB × $0.0952                | $0.10      | $0.10        |
| Public IPv4 (Elastic IP) | 730 h × $0.005                | $3.65      | $3.65        |
| RDS `db.t4g.micro`       | 730 h × $0.019                | $13.87     | $13.87       |
| RDS gp3 storage          | 20 GB × $0.137                | $2.74      | $2.74        |
| RDS backup storage       | 0 GB / 20 GB × $0.103         | $0.00      | $2.06        |
| RDS surplus CPU credits  | 0 / 10 vCPU-h × $0.075        | $0.00      | $0.75        |
| Secrets Manager          | 3 × $0.40 + 2,000 calls       | $1.21      | $1.21        |
| S3 storage and requests  | 5 GB, 10k PUT, 100k GET       | $0.22      | $0.22        |
| ECR storage              | 3 GB × $0.10                  | $0.30      | $0.30        |
| Data transfer out        | 20 GB × $0.09                 | $1.80      | $1.80        |
| Cross-AZ transfer        | 0 GB                          | $0.00      | $0.00        |
| Terraform state bucket   | under 1 MB and a few requests | < $0.01    | < $0.01      |
| **Total per month**      |                               | **$39.81** | **$42.62**   |

Not included: tax, KMS requests made by AWS services with AWS-managed keys (expected to be
negligible, not priced here), domain registration and DNS hosting (the DNS provider is
unselected), and support plans.

Sizing alternatives, instance hours only (730 h): EC2 `t4g.medium` $28.03, `t3.small` $17.52,
`t3.medium` $35.04; RDS `db.t4g.small` $27.01, `db.t4g.medium` $54.02. Multi-AZ RDS is not
proposed and not priced.

## Stopped month

EC2 stopped and RDS stopped. Instance hours stop. Storage, the idle Elastic IP, secrets and
stored data keep billing. RDS starts a stopped instance automatically after seven consecutive
days, and storage and backups are billed while stopped (AWS RDS user guide). Staying stopped
for a month means stopping it again after each automatic start. Each automatic start that runs
for a day adds about 24 h × $0.019 = $0.46.

| Item                     | Estimate   | Conservative |
| ------------------------ | ---------- | ------------ |
| EBS root + Caddy volumes | $2.00      | $2.00        |
| Public IPv4, idle        | $3.65      | $3.65        |
| RDS gp3 storage          | $2.74      | $2.74        |
| RDS backup storage       | $0.00      | $2.06        |
| Secrets Manager          | $1.20      | $1.20        |
| S3 storage               | $0.12      | $0.12        |
| ECR storage              | $0.30      | $0.30        |
| **Total per month**      | **$10.01** | **$12.07**   |

## After `terraform destroy`

Destroy needs deletion protection turned off first, and it stops at the non-empty bucket and
repositories (see [retention](aws-infrastructure.md#retention-and-deletion)). These keep billing
until an operator deletes them deliberately:

| Retained item                                              | Basis                                                                                           | Example                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------- |
| RDS final snapshot                                         | $0.103 / GB-month, no free allocation left                                                      | 20 GB worst case: $2.06 |
| RDS automated backups (kept after deletion)                | same rate, until the 7-day retention ends                                                       | up to about $0.48 once  |
| Caddy volume final snapshot                                | $0.054 / GB-month                                                                               | 1 GB: $0.05             |
| Document bucket objects and versions (if not emptied)      | $0.0245 / GB-month                                                                              | 5 GB: $0.12             |
| ECR images (if not deleted)                                | $0.10 / GB-month                                                                                | 3 GB: $0.30             |
| App and migrator secrets during the 30-day recovery window | AWS's pricing page does not say whether secrets scheduled for deletion bill; assumed $0.40 each | up to $0.80 once        |
| State bucket                                               | negligible                                                                                      | < $0.01                 |

The RDS-managed master secret is deleted with the database. The Elastic IP is released by
destroy. An Elastic IP left allocated but unassociated would still cost $3.65 per month.

## Before deployment

- Choose the monthly budget ceiling and the alert recipients; then decide whether an AWS
  Budgets alert (notification only) is added in the next step.
- Recalculate with the chosen Region and sizes. Prices differ by Region and change over time.
- After the first month, compare against Cost Explorer. The largest uncertainties are egress,
  S3 versions and RDS CPU credits.
