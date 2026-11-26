# Security groups are stateful; replies need no rule. Traffic to the Amazon-provided DNS
# resolver, the instance metadata service and Amazon Time Sync is not filtered by security
# groups, so no rule names them. The provider removes AWS's default allow-all egress rule.

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "TradeFlow instance: public HTTP/HTTPS in; HTTPS and PostgreSQL out"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-app" }
}

# The only public ingress. Port 80 serves only Caddy's HTTPS redirect and ACME HTTP-01
# challenges. There is no SSH rule: administration is through SSM Session Manager.
resource "aws_vpc_security_group_ingress_rule" "app_public" {
  for_each = {
    http  = { port = 80, description = "HTTP redirect and ACME HTTP-01" }
    https = { port = 443, description = "HTTPS (same-origin SPA and /api)" }
  }

  security_group_id = aws_security_group.app.id
  description       = each.value.description
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = "0.0.0.0/0"
}

# AWS APIs (S3, Secrets Manager, SSM, ECR), ECR layer downloads, OS packages, the RDS CA
# bundle and the ACME CA are all HTTPS. Without a NAT gateway or VPC endpoints these are
# public endpoints, so the destination cannot be narrowed to a fixed CIDR.
resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS to AWS APIs, ECR, package repositories and the ACME CA"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "app_database" {
  security_group_id            = aws_security_group.app.id
  description                  = "PostgreSQL to the RDS instance"
  ip_protocol                  = "tcp"
  from_port                    = local.db_port
  to_port                      = local.db_port
  referenced_security_group_id = aws_security_group.database.id
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "TradeFlow RDS: PostgreSQL from the application security group only"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-database" }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_app" {
  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from the TradeFlow instance"
  ip_protocol                  = "tcp"
  from_port                    = local.db_port
  to_port                      = local.db_port
  referenced_security_group_id = aws_security_group.app.id
}
