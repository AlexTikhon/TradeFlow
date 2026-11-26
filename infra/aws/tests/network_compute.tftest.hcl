# Offline: every run uses a mock AWS provider (no credentials, no API calls). `command = apply`
# here applies to that in-memory mock only, so computed IDs/ARNs get mock values that the
# cross-resource assertions can compare.

mock_provider "aws" {
  override_data {
    target = data.aws_availability_zones.available
    values = { names = ["eu-central-1a", "eu-central-1b", "eu-central-1c"] }
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

run "database_is_private_encrypted_and_protected" {
  command = apply

  assert {
    condition     = aws_db_instance.main.publicly_accessible == false
    error_message = "RDS must not be publicly accessible."
  }

  assert {
    condition     = aws_db_instance.main.engine == "postgres" && aws_db_instance.main.engine_version == "18"
    error_message = "RDS must run PostgreSQL 18."
  }

  assert {
    condition     = aws_db_instance.main.storage_encrypted == true
    error_message = "RDS storage must be encrypted."
  }

  assert {
    condition     = aws_db_instance.main.manage_master_user_password == true && nonsensitive(aws_db_instance.main.password == null)
    error_message = "The master password must be RDS-managed and never set in configuration."
  }

  assert {
    condition     = aws_db_instance.main.deletion_protection && !aws_db_instance.main.skip_final_snapshot && aws_db_instance.main.final_snapshot_identifier == "tradeflow-portfolio-final"
    error_message = "RDS needs deletion protection and a final snapshot."
  }

  assert {
    condition     = aws_db_instance.main.delete_automated_backups == false && aws_db_instance.main.backup_retention_period == 7
    error_message = "Automated backups must be kept (7 days by default) and retained after deletion."
  }

  assert {
    condition     = aws_db_instance.main.multi_az == false && aws_db_instance.main.availability_zone == aws_subnet.public.availability_zone
    error_message = "Single-AZ database in the instance's AZ (no cross-AZ transfer)."
  }

  assert {
    condition     = aws_db_instance.main.ca_cert_identifier == "rds-ca-rsa2048-g1"
    error_message = "RDS server certificate CA must be explicit."
  }

  assert {
    condition     = anytrue([for p in aws_db_parameter_group.main.parameter : p.name == "rds.force_ssl" && p.value == "1"])
    error_message = "The parameter group must force TLS."
  }

  assert {
    condition     = aws_db_instance.main.max_allocated_storage == 0
    error_message = "Storage autoscaling is off unless a maximum is chosen."
  }

  assert {
    condition     = length(aws_db_subnet_group.main.subnet_ids) == 2 && length(distinct([for s in aws_subnet.database : s.availability_zone])) == 2
    error_message = "The DB subnet group must span two AZs."
  }

  assert {
    condition     = alltrue([for s in aws_subnet.database : s.map_public_ip_on_launch == false])
    error_message = "Database subnets must not assign public IPs."
  }

  assert {
    condition     = alltrue([for a in aws_route_table_association.database : a.route_table_id == aws_route_table.database.id]) && aws_route.public_internet.route_table_id == aws_route_table.public.id
    error_message = "Database subnets must use the route table without an internet route."
  }
}

run "database_ingress_only_from_application_group" {
  command = apply

  assert {
    condition     = aws_vpc_security_group_ingress_rule.database_from_app.security_group_id == aws_security_group.database.id
    error_message = "The rule must belong to the database security group."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.database_from_app.referenced_security_group_id == aws_security_group.app.id
    error_message = "Database ingress must reference the application security group."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.database_from_app.cidr_ipv4 == null && aws_vpc_security_group_ingress_rule.database_from_app.cidr_ipv6 == null
    error_message = "Database ingress must not be open to a CIDR."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.database_from_app.from_port == 5432 && aws_vpc_security_group_ingress_rule.database_from_app.to_port == 5432
    error_message = "Database ingress must be exactly TCP 5432."
  }

  assert {
    condition     = aws_db_instance.main.vpc_security_group_ids == toset([aws_security_group.database.id])
    error_message = "RDS must use only the database security group."
  }
}

run "public_ingress_is_http_and_https_only" {
  command = apply

  assert {
    condition = toset([
      for rule in aws_vpc_security_group_ingress_rule.app_public :
      "${rule.ip_protocol}/${rule.from_port}-${rule.to_port}/${rule.cidr_ipv4}" if rule.security_group_id == aws_security_group.app.id
    ]) == toset(["tcp/80-80/0.0.0.0/0", "tcp/443-443/0.0.0.0/0"])
    error_message = "Public ingress must be TCP 80 and 443 only."
  }

  assert {
    condition     = length(aws_security_group.app.ingress) == 0 && length(aws_security_group.database.ingress) == 0
    error_message = "No inline security group rules besides the managed rule resources."
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.app_https.from_port == 443 && aws_vpc_security_group_egress_rule.app_database.referenced_security_group_id == aws_security_group.database.id
    error_message = "Egress must be HTTPS out and PostgreSQL to the database group only."
  }

  assert {
    condition     = aws_instance.app.vpc_security_group_ids == toset([aws_security_group.app.id])
    error_message = "The instance must use only the application security group."
  }

  assert {
    condition     = length(aws_default_security_group.main.ingress) == 0 && length(aws_default_security_group.main.egress) == 0
    error_message = "The VPC default security group must have no rules."
  }

  assert {
    condition     = aws_eip_association.app.instance_id == aws_instance.app.id && aws_eip.app.domain == "vpc"
    error_message = "The instance must have a stable Elastic IP."
  }
}

run "instance_requires_imdsv2_and_encrypted_volumes" {
  command = apply

  assert {
    condition     = aws_instance.app.metadata_options[0].http_tokens == "required" && aws_instance.app.metadata_options[0].http_endpoint == "enabled"
    error_message = "IMDSv2 must be required."
  }

  assert {
    condition     = aws_instance.app.metadata_options[0].http_put_response_hop_limit == 2 && aws_instance.app.metadata_options[0].http_protocol_ipv6 == "disabled"
    error_message = "Hop limit 2 for the API container, IPv6 IMDS off."
  }

  assert {
    condition     = aws_instance.app.root_block_device[0].encrypted && aws_ebs_volume.caddy_state.encrypted && aws_ebs_volume.caddy_state.final_snapshot
    error_message = "Root and Caddy volumes must be encrypted; the Caddy volume keeps a final snapshot."
  }

  assert {
    condition     = aws_ebs_volume.caddy_state.availability_zone == aws_subnet.public.availability_zone && aws_volume_attachment.caddy_state.instance_id == aws_instance.app.id
    error_message = "The Caddy state volume must attach to the instance in its AZ."
  }

  assert {
    condition     = aws_instance.app.credit_specification[0].cpu_credits == "standard"
    error_message = "Burstable instances must not accrue unlimited-credit charges."
  }

  assert {
    condition     = aws_instance.app.iam_instance_profile == aws_iam_instance_profile.instance.name && aws_instance.app.ami == "ami-0123456789abcdef0"
    error_message = "Instance profile and AL2023 AMI must be wired."
  }
}

run "user_data_contract" {
  command = apply

  assert {
    condition     = length(aws_instance.app.user_data) < 16384
    error_message = "User data must fit the 16 KB EC2 limit."
  }

  assert {
    condition     = !strcontains(lower(aws_instance.app.user_data), "password") && !strcontains(aws_instance.app.user_data, "AWS_SECRET_ACCESS_KEY")
    error_message = "User data must not carry credentials."
  }

  assert {
    condition     = !strcontains(aws_instance.app.user_data, "seed.ts") && !strcontains(aws_instance.app.user_data, "db:seed") && !strcontains(aws_instance.app.user_data, "migrate deploy") && !can(regex("(?m)^\\s*tradeflow-migrate", aws_instance.app.user_data))
    error_message = "Boot must not migrate or seed."
  }

  assert {
    condition     = strcontains(aws_instance.app.user_data, "TRUSTED_PROXY_CIDRS=172.30.0.10/32") && strcontains(aws_instance.app.user_data, "--ip \"$EDGE_IP\"")
    error_message = "Only the edge's fixed address may be a trusted proxy."
  }

  assert {
    condition     = strcontains(aws_instance.app.user_data, "iptables -C DOCKER-USER ! -s \"$API_IP/32\" -d 169.254.169.254/32 -j DROP") && strcontains(aws_instance.app.user_data, "iptables -I DOCKER-USER 1 ! -s \"$API_IP/32\" -d 169.254.169.254/32 -j DROP")
    error_message = "Only the API container may reach IMDS (rule checked and inserted idempotently)."
  }

  assert {
    condition     = strcontains(aws_instance.app.user_data, "\"log-driver\": \"local\"") && strcontains(aws_instance.app.user_data, "\"max-size\": \"10m\", \"max-file\": \"5\"")
    error_message = "Docker logs must be bounded."
  }

  assert {
    condition     = strcontains(aws_instance.app.user_data, "\"$url\" != *sslmode=verify-full*") && strcontains(aws_instance.app.user_data, "\"$url\" != *sslrootcert=/etc/tradeflow/rds-ca.pem*") && strcontains(aws_instance.app.user_data, "https://truststore.pki.rds.amazonaws.com/eu-central-1/eu-central-1-bundle.pem")
    error_message = "The API must verify the RDS certificate and hostname against the regional bundle."
  }

  assert {
    condition     = strcontains(aws_instance.app.user_data, "S3_BUCKET=tradeflow-portfolio-docs-123456789012-eu-central-1") && strcontains(aws_instance.app.user_data, "APP_DOMAIN=portfolio.tradeflow.example")
    error_message = "Runtime configuration must come from the inputs."
  }

  assert {
    condition     = aws_instance.app.user_data_replace_on_change == true
    error_message = "User data changes must replace the instance deliberately."
  }
}

run "architecture_mismatch_is_rejected" {
  command = plan

  variables {
    instance_type = "t3.small"
  }

  override_data {
    target = data.aws_ec2_instance_type.app
    values = { supported_architectures = ["x86_64"], hypervisor = "nitro" }
  }

  expect_failures = [aws_instance.app]
}

run "xen_instance_type_is_rejected" {
  command = plan

  override_data {
    target = data.aws_ec2_instance_type.app
    values = { supported_architectures = ["arm64"], hypervisor = "xen" }
  }

  expect_failures = [aws_instance.app]
}

run "x86_64_selects_matching_ami_and_platform" {
  command = plan

  variables {
    instance_type         = "t3.small"
    instance_architecture = "x86_64"
  }

  override_data {
    target = data.aws_ec2_instance_type.app
    values = { supported_architectures = ["i386", "x86_64"], hypervisor = "nitro" }
  }

  assert {
    condition     = data.aws_ssm_parameter.al2023_ami[0].name == "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
    error_message = "The AMI lookup must follow instance_architecture."
  }

  assert {
    condition     = output.image_platform == "linux/amd64"
    error_message = "Images must be built for the instance platform."
  }
}
