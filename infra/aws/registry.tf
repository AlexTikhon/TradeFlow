# One private repository per existing Dockerfile target (deploy/Dockerfile: api, web, tools).
# Releases are referenced by digest; tags are immutable, so a tag can never be repointed.

resource "aws_ecr_repository" "image" {
  for_each = local.ecr_repository_names

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"

  # A repository that still holds images cannot be deleted by Terraform.
  force_delete = false

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = each.value, Target = each.key }
}

# Bounds registry storage. The image a release parameter points at is normally among the newest
# 20; check before pushing many builds without deploying them.
resource "aws_ecr_lifecycle_policy" "image" {
  for_each = aws_ecr_repository.image

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 20 most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}
