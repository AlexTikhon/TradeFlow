# One EC2 instance runs one API container and one Caddy edge container (ADR 0020: a single API
# process). Administration is through SSM Session Manager: no key pair, no SSH port.

resource "aws_instance" "app" {
  ami                         = local.ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  associate_public_ip_address = true # egress during first boot; replaced by the Elastic IP
  monitoring                  = false

  metadata_options {
    http_endpoint      = "enabled"
    http_tokens        = "required" # IMDSv2 only
    http_protocol_ipv6 = "disabled"
    # 2, not 1: a container on a Docker bridge is one extra hop away, and the API container gets
    # its S3/Secrets credentials from IMDS. The guard in user data drops every other container's
    # traffic to IMDS. See docs/aws-infrastructure.md, "Instance credentials".
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gib
    encrypted             = true
    delete_on_termination = true # stateless: images, bounded logs, tmpfs secrets
  }

  # Burstable instances default to "unlimited" credits, which bills sustained CPU above
  # baseline. "standard" throttles instead of charging.
  dynamic "credit_specification" {
    for_each = startswith(var.instance_type, "t") ? [1] : []
    content {
      cpu_credits = "standard"
    }
  }

  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    aws_region              = var.aws_region
    domain_name             = var.domain_name
    documents_bucket        = local.documents_bucket_name
    document_prefix         = var.document_prefix
    ecr_registry            = local.ecr_registry
    ecr_repository_prefix   = "${local.ecr_registry}/${local.name}/"
    app_secret_arn          = aws_secretsmanager_secret.app_database.arn
    release_parameter_name  = local.release_parameter_name
    caddy_volume_id         = aws_ebs_volume.caddy_state.id
    docker_front_subnet     = local.docker_front_subnet
    edge_container_ip       = local.edge_container_ip
    api_container_ip        = local.api_container_ip
    container_log_max_size  = "10m"
    container_log_max_files = 5
  })
  # Changing user data replaces the instance deliberately rather than leaving it half-applied.
  user_data_replace_on_change = true

  tags = { Name = local.name }

  lifecycle {
    # A new Amazon Linux release must not replace the instance as a side effect of an unrelated
    # apply. Replace deliberately: terraform apply -replace=aws_instance.app.
    ignore_changes = [ami]

    precondition {
      condition     = contains(data.aws_ec2_instance_type.app.supported_architectures, var.instance_architecture)
      error_message = "instance_type does not support instance_architecture. Choose a matching type (e.g. t4g.* for arm64, t3.* for x86_64) and build images for that platform."
    }

    precondition {
      condition     = data.aws_ec2_instance_type.app.hypervisor == "nitro"
      error_message = "instance_type must be a Nitro instance type: user data finds the Caddy state volume by its NVMe device ID."
    }

    precondition {
      condition     = local.ami_id != null
      error_message = "No AMI: set ami_id or allow the public Amazon Linux 2023 SSM parameter lookup."
    }
  }
}

# Caddy's ACME account and certificates. A separate volume survives instance replacement, so a
# new instance does not request new certificates (Let's Encrypt rate limits) or lose its account.
resource "aws_ebs_volume" "caddy_state" {
  availability_zone = local.primary_az
  type              = "gp3"
  size              = var.caddy_state_volume_size_gib
  encrypted         = true
  final_snapshot    = true

  tags = { Name = "${local.name}-caddy-state" }
}

resource "aws_volume_attachment" "caddy_state" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.caddy_state.id
  instance_id                    = aws_instance.app.id
  stop_instance_before_detaching = true
}

# A stable address for the DNS A record across stop/start and instance replacement.
resource "aws_eip" "app" {
  domain = "vpc"

  tags = { Name = local.name }
}

resource "aws_eip_association" "app" {
  allocation_id = aws_eip.app.id
  instance_id   = aws_instance.app.id
}
