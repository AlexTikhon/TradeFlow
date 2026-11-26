# Required decisions have no default: a real plan cannot start until the operator states the
# account, region, domain and resource sizes. Reviewable defaults are listed in
# docs/aws-infrastructure.md, "Inputs".

variable "aws_account_id" {
  description = "The AWS account this environment must be deployed to. The provider refuses credentials for any other account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  description = "Commercial AWS Region for every resource, e.g. eu-central-1 (an example, not a selection)."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region)) && !can(regex("^(cn|us-gov|us-iso|eu-isoe)", var.aws_region))
    error_message = "aws_region must be a commercial-partition Region name such as eu-central-1. ARNs here assume the aws partition."
  }
}

variable "environment" {
  description = "Short environment name used in resource names and tags."
  type        = string
  default     = "portfolio"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be 2-16 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "domain_name" {
  description = "Public hostname served by Caddy (the A record must point at the Elastic IP before Caddy can obtain a certificate)."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$", var.domain_name)) && length(var.domain_name) <= 253
    error_message = "domain_name must be a lowercase DNS hostname without scheme, port, path or trailing dot."
  }
}

variable "instance_type" {
  description = "EC2 instance type for the API and edge containers. Its CPU architecture must equal instance_architecture."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*\\.[a-z0-9]+$", var.instance_type))
    error_message = "instance_type must look like an EC2 instance type, e.g. t4g.small."
  }
}

variable "instance_architecture" {
  description = "CPU architecture of the EC2 instance, the AMI and the published container images: arm64 or x86_64."
  type        = string

  validation {
    condition     = contains(["arm64", "x86_64"], var.instance_architecture)
    error_message = "instance_architecture must be arm64 or x86_64."
  }
}

variable "db_instance_class" {
  description = "RDS instance class, e.g. db.t4g.micro."
  type        = string

  validation {
    condition     = can(regex("^db\\.[a-z0-9]+\\.[a-z0-9]+$", var.db_instance_class))
    error_message = "db_instance_class must look like an RDS instance class, e.g. db.t4g.micro."
  }
}

variable "db_allocated_storage_gib" {
  description = "Provisioned gp3 storage for RDS, in GiB (20 is the RDS gp3 minimum)."
  type        = number

  validation {
    condition     = var.db_allocated_storage_gib >= 20 && var.db_allocated_storage_gib <= 1000 && floor(var.db_allocated_storage_gib) == var.db_allocated_storage_gib
    error_message = "db_allocated_storage_gib must be a whole number from 20 to 1000."
  }
}

variable "db_max_allocated_storage_gib" {
  description = "Upper bound for RDS storage autoscaling, in GiB. null disables autoscaling, so storage cost cannot grow on its own."
  type        = number
  default     = null

  validation {
    condition     = var.db_max_allocated_storage_gib == null || try(var.db_max_allocated_storage_gib > var.db_allocated_storage_gib && var.db_max_allocated_storage_gib <= 1000, false)
    error_message = "db_max_allocated_storage_gib must be null or greater than db_allocated_storage_gib and at most 1000."
  }
}

variable "db_backup_retention_days" {
  description = "Days of RDS automated backups (point-in-time recovery window)."
  type        = number
  default     = 7

  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be 1-35; 0 would disable automated backups."
  }
}

variable "root_volume_size_gib" {
  description = "Encrypted gp3 root volume of the instance (OS, Docker images, bounded container logs)."
  type        = number
  default     = 20

  validation {
    condition     = var.root_volume_size_gib >= 8 && var.root_volume_size_gib <= 200
    error_message = "root_volume_size_gib must be 8-200."
  }
}

variable "caddy_state_volume_size_gib" {
  description = "Encrypted gp3 volume that keeps Caddy's ACME account and certificates across instance replacement."
  type        = number
  default     = 1

  validation {
    condition     = var.caddy_state_volume_size_gib >= 1 && var.caddy_state_volume_size_gib <= 16
    error_message = "caddy_state_volume_size_gib must be 1-16."
  }
}

variable "vpc_cidr" {
  description = "IPv4 CIDR of the dedicated VPC (/16-/20). Subnets are carved with cidrsubnet()."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) >= 16 && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be an IPv4 CIDR from /16 to /20."
  }
}

variable "ami_id" {
  description = "Pinned AMI. null resolves the latest Amazon Linux 2023 AMI for instance_architecture from the public SSM parameter at plan time."
  type        = string
  default     = null

  validation {
    condition     = var.ami_id == null || can(regex("^ami-[0-9a-f]{8,17}$", var.ami_id))
    error_message = "ami_id must be null or an AMI ID such as ami-0123456789abcdef0."
  }
}

variable "document_prefix" {
  description = "S3_PREFIX for document objects. The instance role can reach only keys below it."
  type        = string
  default     = "tradeflow/"

  validation {
    condition     = can(regex("^(?:[a-zA-Z0-9_-]+/)+$", var.document_prefix))
    error_message = "document_prefix must be one or more path segments, each ending in a slash (the API's S3_PREFIX rule), and must not be empty."
  }
}

variable "secret_recovery_window_days" {
  description = "Days a deleted Secrets Manager secret stays recoverable."
  type        = number
  default     = 30

  validation {
    condition     = var.secret_recovery_window_days >= 7 && var.secret_recovery_window_days <= 30
    error_message = "secret_recovery_window_days must be 7-30 (0, immediate deletion, is not allowed here)."
  }
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}
