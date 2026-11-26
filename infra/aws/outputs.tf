# Identifiers only. No output carries a password, a connection string or a secret value.

output "instance_id" {
  description = "EC2 instance for SSM sessions: aws ssm start-session --target <id>."
  value       = aws_instance.app.id
}

output "public_ip" {
  description = "Elastic IP for the domain's A record."
  value       = aws_eip.app.public_ip
}

output "domain_name" {
  description = "Hostname Caddy serves; its A record must point at public_ip."
  value       = var.domain_name
}

output "database_address" {
  description = "RDS hostname used in DATABASE_URL (TLS hostname verification checks this name)."
  value       = aws_db_instance.main.address
}

output "database_port" {
  description = "RDS port."
  value       = aws_db_instance.main.port
}

output "database_master_secret_arn" {
  description = "RDS-managed master credential secret (administration only; the instance cannot read it)."
  value       = one(aws_db_instance.main.master_user_secret[*].secret_arn)
}

output "app_database_secret_arn" {
  description = "Secret the operator fills with the tradeflow_app DATABASE_URL; read by the instance."
  value       = aws_secretsmanager_secret.app_database.arn
}

output "migrator_database_secret_arn" {
  description = "Secret the operator fills with the tradeflow_migrator DATABASE_URL; operator only."
  value       = aws_secretsmanager_secret.migrator_database.arn
}

output "documents_bucket" {
  description = "S3_BUCKET for the API."
  value       = aws_s3_bucket.documents.bucket
}

output "document_prefix" {
  description = "S3_PREFIX for the API; the instance role is limited to it."
  value       = var.document_prefix
}

output "ecr_repository_urls" {
  description = "Push targets for the api, web and tools images (single-platform, instance_architecture)."
  value       = { for image, repository in aws_ecr_repository.image : image => repository.repository_url }
}

output "release_parameter_name" {
  description = "SSM parameter holding the digest-pinned release the instance runs."
  value       = aws_ssm_parameter.release.name
}

output "image_platform" {
  description = "docker buildx --platform value that matches the instance."
  value       = var.instance_architecture == "arm64" ? "linux/arm64" : "linux/amd64"
}
