# Secret containers only. Terraform never creates a secret version, so no value reaches the
# configuration or state. The operator writes each value out of band
# (docs/aws-infrastructure.md, "Database roles"). The RDS master secret is created and owned by
# RDS itself (database.tf) and is not readable by the instance.

resource "aws_secretsmanager_secret" "app_database" {
  name                    = "${local.name}/app-database"
  description             = "TradeFlow API connection: JSON {\"DATABASE_URL\": ...} for the tradeflow_app role (DML only). Readable by the instance role."
  recovery_window_in_days = var.secret_recovery_window_days

  tags = { Name = "${local.name}/app-database", Reader = "instance" }
}

resource "aws_secretsmanager_secret" "migrator_database" {
  name                    = "${local.name}/migrator-database"
  description             = "TradeFlow migrations: JSON {\"DATABASE_URL\": ...} for the tradeflow_migrator role (schema owner). Operator only; not readable by the instance role."
  recovery_window_in_days = var.secret_recovery_window_days

  tags = { Name = "${local.name}/migrator-database", Reader = "operator" }
}

# Which images run. A non-secret pointer the instance reads at every start, so a replacement
# instance comes back on the last released digests. Terraform creates it unset and never
# overwrites a value the operator has released.
resource "aws_ssm_parameter" "release" {
  name        = local.release_parameter_name
  description = "TradeFlow release: JSON {\"api\",\"web\",\"tools\"} image references pinned by digest, or \"unset\""
  type        = "String"
  tier        = "Standard"
  value       = "unset"

  lifecycle {
    ignore_changes = [value]
  }
}
