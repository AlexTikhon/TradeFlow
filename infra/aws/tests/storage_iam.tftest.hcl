# Offline: mock AWS provider only (no credentials, no API calls). `command = apply` applies to
# the in-memory mock.

mock_provider "aws" {
  override_data {
    target = data.aws_availability_zones.available
    values = { names = ["eu-central-1a", "eu-central-1b"] }
  }

  override_data {
    target = data.aws_ec2_instance_type.app
    values = { supported_architectures = ["arm64"], hypervisor = "nitro" }
  }

  override_data {
    target = data.aws_ssm_parameter.al2023_ami
    values = { value = "ami-0123456789abcdef0" }
  }

  override_resource {
    target = aws_secretsmanager_secret.app_database
    values = { arn = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:tradeflow-portfolio/app-database-AbCdEf" }
  }

  override_resource {
    target = aws_secretsmanager_secret.migrator_database
    values = { arn = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:tradeflow-portfolio/migrator-database-GhIjKl" }
  }
}

variables {
  aws_account_id           = "123456789012"
  aws_region               = "eu-central-1"
  domain_name              = "portfolio.tradeflow.example"
  instance_type            = "t4g.small"
  instance_architecture    = "arm64"
  db_instance_class        = "db.t4g.micro"
  db_allocated_storage_gib = 20
}

run "document_bucket_is_private_encrypted_and_versioned" {
  command = plan

  assert {
    condition     = aws_s3_bucket.documents.bucket == "tradeflow-portfolio-docs-123456789012-eu-central-1" && aws_s3_bucket.documents.force_destroy == false
    error_message = "Document bucket name and deletion protection."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.documents.block_public_acls,
      aws_s3_bucket_public_access_block.documents.block_public_policy,
      aws_s3_bucket_public_access_block.documents.ignore_public_acls,
      aws_s3_bucket_public_access_block.documents.restrict_public_buckets,
    ])
    error_message = "All public access must be blocked."
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.documents.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs must be disabled (bucket owner enforced)."
  }

  assert {
    condition     = [for r in aws_s3_bucket_server_side_encryption_configuration.documents.rule : r.apply_server_side_encryption_by_default[0].sse_algorithm] == ["AES256"]
    error_message = "Default encryption must be SSE-S3."
  }

  assert {
    condition     = aws_s3_bucket_versioning.documents.versioning_configuration[0].status == "Enabled"
    error_message = "Versioning must be enabled."
  }

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.documents.policy).Statement[0].Effect == "Deny" && jsondecode(aws_s3_bucket_policy.documents.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "The bucket must refuse requests without TLS."
  }
}

run "lifecycle_only_aborts_incomplete_uploads" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.documents.rule) == 1
    error_message = "Exactly one lifecycle rule."
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.documents.rule[0].abort_incomplete_multipart_upload[0].days_after_initiation == 7
    error_message = "Incomplete multipart uploads are aborted after 7 days."
  }

  assert {
    condition = alltrue([for r in aws_s3_bucket_lifecycle_configuration.documents.rule :
      length(r.expiration) == 0 && length(r.noncurrent_version_expiration) == 0 && length(r.transition) == 0 && length(r.noncurrent_version_transition) == 0
    ])
    error_message = "Complete document objects (current or noncurrent) must never expire or transition automatically."
  }
}

run "instance_role_is_narrowly_scoped" {
  command = apply

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : s.Effect == "Allow" && alltrue([for a in flatten([s.Action]) : !strcontains(a, "*")])])
    error_message = "No wildcard actions."
  }

  assert {
    condition     = toset([for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : s.Sid if contains(flatten([s.Resource]), "*")]) == toset(["SsmAgentChannel", "EcrAuthorizationToken"])
    error_message = "Resource \"*\" only for the SSM agent channel and the ECR token."
  }

  assert {
    condition     = [for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : s if s.Sid == "DocumentObjects"][0].Resource == "arn:aws:s3:::tradeflow-portfolio-docs-123456789012-eu-central-1/tradeflow/*"
    error_message = "S3 access must be limited to the document prefix."
  }

  assert {
    condition = toset([for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : s if s.Sid == "DocumentObjects"][0].Action) == toset([
      "s3:AbortMultipartUpload", "s3:DeleteObject", "s3:GetObject", "s3:ListMultipartUploadParts", "s3:PutObject",
    ])
    error_message = "S3 actions must be exactly the API's documented needs."
  }

  assert {
    condition     = !anytrue([for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : anytrue([for a in flatten([s.Action]) : contains(["s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutBucketPolicy", "s3:DeleteObjectVersion", "s3:CreateBucket"], a) || startswith(a, "iam:") || startswith(a, "kms:") || startswith(a, "rds") || startswith(a, "ecr:Put") || startswith(a, "ssm:Send") || startswith(a, "ssm:GetParameters")])])
    error_message = "No bucket-wide, IAM, KMS, RDS, image-push, command or bulk-parameter permissions."
  }

  assert {
    condition = [for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : s.Resource if anytrue([for a in flatten([s.Action]) : startswith(a, "secretsmanager:")])] == [
      "arn:aws:secretsmanager:eu-central-1:123456789012:secret:tradeflow-portfolio/app-database-AbCdEf",
    ]
    error_message = "Only the application secret is readable."
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.instance.policy, "migrator-database")
    error_message = "The migrator secret must not be readable by the instance."
  }

  assert {
    condition = toset([for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : s if s.Sid == "EcrPullReleaseImages"][0].Resource) == toset([
      "arn:aws:ecr:eu-central-1:123456789012:repository/tradeflow-portfolio/api",
      "arn:aws:ecr:eu-central-1:123456789012:repository/tradeflow-portfolio/web",
      "arn:aws:ecr:eu-central-1:123456789012:repository/tradeflow-portfolio/tools",
    ])
    error_message = "Image pulls only from this environment's repositories."
  }

  assert {
    condition     = [for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : s if s.Sid == "ReleaseParameter"][0].Resource == "arn:aws:ssm:eu-central-1:123456789012:parameter/tradeflow-portfolio/release"
    error_message = "Only the release parameter is readable."
  }

  assert {
    condition     = length(aws_iam_role_policy_attachments_exclusive.instance.policy_arns) == 0 && aws_iam_role_policies_exclusive.instance.policy_names == toset(["tradeflow-instance"])
    error_message = "The inline policy must be the role's only permission set."
  }

  assert {
    condition     = jsondecode(aws_iam_role.instance.assume_role_policy).Statement[0].Principal.Service == "ec2.amazonaws.com" && length(jsondecode(aws_iam_role.instance.assume_role_policy).Statement) == 1
    error_message = "Only EC2 may assume the instance role."
  }
}

run "registry_secrets_and_release_are_retained" {
  command = plan

  assert {
    condition     = alltrue([for r in aws_ecr_repository.image : r.image_tag_mutability == "IMMUTABLE" && r.force_delete == false && r.image_scanning_configuration[0].scan_on_push])
    error_message = "Repositories: immutable tags, scan on push, no forced deletion."
  }

  assert {
    condition     = alltrue([for r in aws_ecr_repository.image : r.encryption_configuration[0].encryption_type == "AES256"])
    error_message = "Repositories must be encrypted at rest."
  }

  assert {
    condition     = keys(aws_ecr_repository.image) == ["api", "tools", "web"]
    error_message = "One repository per existing Dockerfile target."
  }

  assert {
    condition     = aws_secretsmanager_secret.app_database.recovery_window_in_days == 30 && aws_secretsmanager_secret.migrator_database.recovery_window_in_days == 30
    error_message = "Deleted secrets stay recoverable for 30 days by default."
  }

  assert {
    condition     = aws_ssm_parameter.release.type == "String" && nonsensitive(aws_ssm_parameter.release.value) == "unset"
    error_message = "The release pointer starts unset and is not a secret."
  }
}
