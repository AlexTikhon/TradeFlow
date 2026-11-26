# One dedicated VPC, no NAT gateway. The instance sits in a public subnet behind its security
# group and reaches AWS APIs, ECR and the ACME CA over its Elastic IP. The database subnets
# have no route to the internet at all.

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

# AWS creates an allow-all default security group in every VPC. Nothing here uses it; strip it
# so nothing attached by mistake gets its rules.
resource "aws_default_security_group" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.name}-default-unused" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = local.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.primary_az
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 0)
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public-${local.primary_az}", Tier = "public" }
}

resource "aws_subnet" "database" {
  for_each = {
    primary   = { az = local.primary_az, netnum = 10 }
    secondary = { az = local.secondary_az, netnum = 11 }
  }

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.value.az
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value.netnum)
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-db-${each.value.az}", Tier = "database" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Only the implicit local route: the database is unreachable from outside the VPC.
resource "aws_route_table" "database" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.name}-database" }
}

resource "aws_route_table_association" "database" {
  for_each = aws_subnet.database

  subnet_id      = each.value.id
  route_table_id = aws_route_table.database.id
}
