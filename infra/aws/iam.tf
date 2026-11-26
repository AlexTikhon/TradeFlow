# The instance role. Every process that can reach the instance metadata service can use all of
# it: host processes and, with the hop limit of 2, the API container (other containers are
# dropped by the IMDS guard in user data). It is therefore limited to what the host and API
# need. Operator and maintenance permissions (ListBucket, the migrator secret, the RDS master
# secret, image pushes) belong to separate human identities.

locals {
  instance_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # Session Manager / Run Command agent channel. ssmmessages:* and ec2messages:* support no
        # resource-level permissions, so AWS's minimal custom policy uses "*" for all of these.
        Sid    = "SsmAgentChannel"
        Effect = "Allow"
        Action = [
          "ssm:UpdateInstanceInformation",
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
          "ec2messages:AcknowledgeMessage",
          "ec2messages:DeleteMessage",
          "ec2messages:FailMessage",
          "ec2messages:GetEndpoint",
          "ec2messages:GetMessages",
          "ec2messages:SendReply",
        ]
        Resource = "*"
      },
      {
        # Registry-wide token; this action has no resource-level permission.
        Sid      = "EcrAuthorizationToken"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrPullReleaseImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = local.ecr_repository_arns
      },
      {
        # Exactly the API's needs from docs/storage-recovery.md. No ListBucket: a missing key
        # then reads as AccessDenied (a 5xx), never as a quietly missing document.
        Sid    = "DocumentObjects"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:ListMultipartUploadParts",
          "s3:PutObject",
        ]
        Resource = local.document_objects_arn
      },
      {
        Sid      = "ApplicationDatabaseSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.app_database.arn
      },
      {
        Sid      = "ReleaseParameter"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = local.release_parameter_arn
      },
    ]
  }
}

resource "aws_iam_role" "instance" {
  name        = "${local.name}-instance"
  description = "TradeFlow EC2 instance: image pulls, document prefix, application secret, SSM"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "ec2.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  })

  tags = { Name = "${local.name}-instance" }
}

resource "aws_iam_role_policy" "instance" {
  name   = "tradeflow-instance"
  role   = aws_iam_role.instance.id
  policy = jsonencode(local.instance_policy)
}

# The inline policy above is the role's whole permission set: Terraform removes any other inline
# policy or attached managed policy (e.g. a broad AmazonSSMManagedInstanceCore, which also grants
# ssm:GetParameter(s) on every parameter) on the next apply.
resource "aws_iam_role_policies_exclusive" "instance" {
  role_name    = aws_iam_role.instance.name
  policy_names = [aws_iam_role_policy.instance.name]
}

resource "aws_iam_role_policy_attachments_exclusive" "instance" {
  role_name   = aws_iam_role.instance.name
  policy_arns = []
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-instance"
  role = aws_iam_role.instance.name
}
