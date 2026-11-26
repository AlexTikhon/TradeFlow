// Static guard for the image retention policy (docs/aws-infrastructure.md, Image retention and
// cleanup). `terraform test` can assert attributes of resources that exist, but not that a
// resource type is absent, so this scans both Terraform roots for anything that would expire ECR
// images automatically. The repositories' own settings are asserted in storage_iam.tftest.hcl.
//
// Run: pnpm test:infra

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function configurationFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '.terraform' ? [] : configurationFiles(full);
    return /\.tf(\.json)?$/.test(entry.name) ? [full] : [];
  });
}

// Lifecycle policies attach to repositories directly; creation templates can carry one for
// repositories created later. Either would let ECR delete a digest a release still names.
const expiring = /\baws_ecr_(lifecycle_policy|repository_creation_template)\b/;

test('no Terraform configuration expires ECR images automatically', () => {
  const files = configurationFiles(root);
  assert.ok(
    files.some((file) => path.basename(file) === 'registry.tf'),
    'the scan must include registry.tf',
  );
  for (const file of files) {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const code = line.replace(/(#|\/\/).*$/, '');
        assert.ok(
          !expiring.test(code),
          `${path.relative(root, file)}:${String(index + 1)} expires images`,
        );
      });
  }
});
