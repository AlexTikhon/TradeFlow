# Private RDS PostgreSQL 18, single-AZ (a portfolio environment: an AZ outage means downtime
# until AWS recovers it or the operator restores elsewhere; see the infrastructure doc).
#
# Credentials: RDS creates and rotates the master password in Secrets Manager
# (manage_master_user_password), so no password exists in this configuration, its state or
# its outputs. The master account is for administration only. The application and migration
# roles are created by the operator (docs/aws-infrastructure.md, "Database roles"), and their
# connection strings live in separate secrets whose values Terraform never sets.

resource "aws_db_subnet_group" "main" {
  name        = local.name
  description = "TradeFlow private database subnets in two AZs"
  subnet_ids  = [for subnet in aws_subnet.database : subnet.id]

  tags = { Name = local.name }
}

resource "aws_db_parameter_group" "main" {
  name        = "${local.name}-postgres18"
  family      = "postgres18"
  description = "TradeFlow PostgreSQL 18: TLS required"

  # Refuse unencrypted client connections at the server, whatever a client asks for.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "immediate"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "18"
  instance_class = var.db_instance_class

  db_name                     = "tradeflow"
  username                    = "tradeflow_admin"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  availability_zone      = local.primary_az
  multi_az               = false
  publicly_accessible    = false
  port                   = local.db_port
  network_type           = "IPV4"

  # The CA the application verifies against (sslmode=verify-full + the regional bundle).
  ca_cert_identifier = "rds-ca-rsa2048-g1"

  storage_type          = "gp3"
  allocated_storage     = var.db_allocated_storage_gib
  max_allocated_storage = coalesce(var.db_max_allocated_storage_gib, 0)
  storage_encrypted     = true

  backup_retention_period  = var.db_backup_retention_days
  backup_window            = "02:00-02:30"
  maintenance_window       = "sun:03:00-sun:04:00"
  copy_tags_to_snapshot    = true
  delete_automated_backups = false

  # Destruction needs two deliberate steps: turning deletion protection off in an applied
  # change, then destroying, which still writes a final snapshot.
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = false

  performance_insights_enabled = false
  monitoring_interval          = 0

  tags = { Name = local.name }
}
