# Offline: mock AWS provider only (no credentials, no API calls).

mock_provider "aws" {}

variables {
  aws_account_id = "123456789012"
  aws_region     = "eu-central-1"
}

run "state_bucket_is_private_encrypted_and_versioned" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "tradeflow-tfstate-123456789012-eu-central-1" && aws_s3_bucket.state.force_destroy == false
    error_message = "State bucket name and deletion protection."
  }

  assert {
    condition     = !strcontains(aws_s3_bucket.state.bucket, "docs")
    error_message = "State must not share the document bucket."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.state.block_public_acls,
      aws_s3_bucket_public_access_block.state.block_public_policy,
      aws_s3_bucket_public_access_block.state.ignore_public_acls,
      aws_s3_bucket_public_access_block.state.restrict_public_buckets,
    ])
    error_message = "All public access must be blocked."
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.state.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs must be disabled."
  }

  assert {
    condition     = [for r in aws_s3_bucket_server_side_encryption_configuration.state.rule : r.apply_server_side_encryption_by_default[0].sse_algorithm] == ["AES256"]
    error_message = "State must be encrypted at rest."
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State versions must be kept for recovery."
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.state.rule[0].noncurrent_version_expiration[0].noncurrent_days == 90 && aws_s3_bucket_lifecycle_configuration.state.rule[0].noncurrent_version_expiration[0].newer_noncurrent_versions == 10 && length(aws_s3_bucket_lifecycle_configuration.state.rule[0].expiration) == 0
    error_message = "Only old noncurrent state versions expire; the current state never does."
  }

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "The state bucket must refuse requests without TLS."
  }
}

run "account_id_is_required_and_validated" {
  command = plan

  variables {
    aws_account_id = "not-an-account"
  }

  expect_failures = [var.aws_account_id]
}
