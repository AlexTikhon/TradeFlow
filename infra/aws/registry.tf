# One private repository per existing Dockerfile target (deploy/Dockerfile: api, web, tools).
# Releases are referenced by digest; tags are immutable, so a tag can never be repointed.
#
# No lifecycle policy: images never expire automatically. ECR expiry rules count images or age,
# not whether the release parameter or a rollback plan still names a digest, so any rule could
# delete the image an instance replacement or rollback needs. Storage therefore grows with every
# pushed build until an operator deletes specific digests (docs/aws-infrastructure.md, Image
# retention and cleanup).

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
