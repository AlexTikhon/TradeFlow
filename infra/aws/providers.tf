provider "aws" {
  region = var.aws_region

  # Refuse to plan or apply with credentials for any other account (a wrong profile, a
  # stale session). The value has no default: it must be stated for a real deployment.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = merge(var.tags, {
      Application = "tradeflow"
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "tradeflow/infra/aws"
    })
  }
}
