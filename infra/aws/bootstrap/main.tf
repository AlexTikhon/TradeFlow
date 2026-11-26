# Bootstrap: the S3 bucket that holds the main configuration's remote state and lock file.
# Applied once, before the main configuration, with local state (it creates no secrets; keep its
# terraform.tfstate with the operator's records). See docs/aws-infrastructure.md, "State".

terraform {
  required_version = "~> 1.17"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.74"
    }
  }
}

variable "aws_account_id" {
  description = "The AWS account that holds the state bucket. The provider refuses any other."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  description = "Commercial AWS Region for the state bucket."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region)) && !can(regex("^(cn|us-gov|us-iso|eu-isoe)", var.aws_region))
    error_message = "aws_region must be a commercial-partition Region name such as eu-central-1."
  }
}

variable "noncurrent_state_retention_days" {
  description = "Days earlier state versions are kept for recovery from a bad apply."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_state_retention_days >= 30
    error_message = "noncurrent_state_retention_days must be at least 30."
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Application = "tradeflow"
      ManagedBy   = "terraform"
      Repository  = "tradeflow/infra/aws/bootstrap"
    }
  }
}

locals {
  bucket_name = "tradeflow-tfstate-${var.aws_account_id}-${var.aws_region}"
  bucket_arn  = "arn:aws:s3:::${local.bucket_name}"
}

resource "aws_s3_bucket" "state" {
  bucket        = local.bucket_name
  force_destroy = false

  tags = { Name = local.bucket_name, Data = "terraform-state" }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Every apply writes a new state version; earlier ones recover from a corrupted or bad state.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days           = var.noncurrent_state_retention_days
      newer_noncurrent_versions = 10
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.bucket_arn, "${local.bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.state]
}

output "state_bucket" {
  description = "Use as `bucket` in the main configuration's backend.hcl."
  value       = aws_s3_bucket.state.bucket
}
