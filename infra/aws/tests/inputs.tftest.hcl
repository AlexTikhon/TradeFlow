# Offline: mock AWS provider only. Required inputs are validated before any real plan.

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

run "valid_example_inputs_plan" {
  command = plan
}

run "account_id_must_be_twelve_digits" {
  command = plan

  variables {
    aws_account_id = "12345"
  }

  expect_failures = [var.aws_account_id]
}

run "region_must_be_commercial" {
  command = plan

  variables {
    aws_region = "us-gov-west-1"
  }

  expect_failures = [var.aws_region]
}

run "domain_must_be_a_bare_hostname" {
  command = plan

  variables {
    domain_name = "https://portfolio.tradeflow.example/"
  }

  expect_failures = [var.domain_name]
}

run "architecture_must_be_named" {
  command = plan

  variables {
    instance_architecture = "aarch64"
  }

  expect_failures = [var.instance_architecture]
}

run "database_storage_has_a_floor" {
  command = plan

  variables {
    db_allocated_storage_gib = 10
  }

  expect_failures = [var.db_allocated_storage_gib]
}

run "backups_cannot_be_disabled" {
  command = plan

  variables {
    db_backup_retention_days = 0
  }

  expect_failures = [var.db_backup_retention_days]
}

run "document_prefix_cannot_be_the_whole_bucket" {
  command = plan

  variables {
    document_prefix = ""
  }

  expect_failures = [var.document_prefix]
}

run "secrets_cannot_be_deleted_immediately" {
  command = plan

  variables {
    secret_recovery_window_days = 0
  }

  expect_failures = [var.secret_recovery_window_days]
}

run "autoscaling_maximum_must_exceed_allocation" {
  command = plan

  variables {
    db_max_allocated_storage_gib = 20
  }

  expect_failures = [var.db_max_allocated_storage_gib]
}
