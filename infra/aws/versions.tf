terraform {
  # Verified with Terraform 1.17.2 (CI pins that exact version). Mock-provider tests and the
  # S3 backend's native lock file both need a current 1.x release.
  required_version = "~> 1.17"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.74"
    }
  }

  # Partial configuration: bucket, key and region come from an untracked backend.hcl at
  # `terraform init -backend-config=backend.hcl` (see backend.hcl.example and
  # docs/aws-infrastructure.md, "State"). The state bucket is created by ./bootstrap and is
  # never the document bucket. Offline checks use `terraform init -backend=false`.
  backend "s3" {}
}
