data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_ssm_parameter" "al2023_ami" {
  count = var.ami_id == null ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${var.instance_architecture}"
}

data "aws_ec2_instance_type" "app" {
  instance_type = var.instance_type
}

locals {
  name = "tradeflow-${var.environment}"

  # The instance, its Caddy volume and the database share one AZ: no cross-AZ transfer charge
  # between API and database. The second AZ exists only because a DB subnet group needs two.
  primary_az   = data.aws_availability_zones.available.names[0]
  secondary_az = data.aws_availability_zones.available.names[1]

  ami_id = coalesce(var.ami_id, try(nonsensitive(data.aws_ssm_parameter.al2023_ami[0].value), null))

  # ARNs are built from inputs, not read back from resources, so policies are fixed at plan time
  # and the offline tests can assert their exact contents.
  partition              = "aws"
  documents_bucket_name  = "${local.name}-docs-${var.aws_account_id}-${var.aws_region}"
  documents_bucket_arn   = "arn:${local.partition}:s3:::${local.documents_bucket_name}"
  document_objects_arn   = "${local.documents_bucket_arn}/${var.document_prefix}*"
  ecr_registry           = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
  ecr_repository_names   = { for image in ["api", "web", "tools"] : image => "${local.name}/${image}" }
  ecr_repository_arns    = [for name in values(local.ecr_repository_names) : "arn:${local.partition}:ecr:${var.aws_region}:${var.aws_account_id}:repository/${name}"]
  release_parameter_name = "/${local.name}/release"
  release_parameter_arn  = "arn:${local.partition}:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.release_parameter_name}"

  # Docker network on the instance. Fixed addresses make TRUSTED_PROXY_CIDRS exact (the edge's
  # /32, never a range) and let the IMDS guard admit only the API container.
  docker_front_subnet = "172.30.0.0/24"
  edge_container_ip   = "172.30.0.10"
  api_container_ip    = "172.30.0.20"

  db_port = 5432
}
