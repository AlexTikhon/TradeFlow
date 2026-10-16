import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  advanceDocumentVersion,
  advanceForReview,
} from '../src/modules/documents/document.writes.js';

/*
 * The document review migrations against a database that already holds documents, as a
 * deployed one does: every migration before them is applied to a scratch database, documents
 * with several versions are written the way the API wrote them then, and only then are the
 * review migrations applied. Each migration script runs as one implicit transaction, as
 * `prisma migrate deploy` runs it.
 */

const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = join(API_ROOT, 'prisma', 'migrations');
const FIRST_REVIEW_MIGRATION = '20261016140000_document_reviews';

const SCRATCH_DATABASE = 'tradeflow_review_migration_test';

const ids = {
  seller: '01990000-0000-7000-8001-0000000000a1',
  buyer: '01990000-0000-7000-8001-0000000000a2',
  sellerUser: '01990000-0000-7000-8002-0000000000a1',
  buyerUser: '01990000-0000-7000-8002-0000000000a2',
  vessel: '01990000-0000-7000-8003-0000000000a1',
  commodity: '01990000-0000-7000-8004-0000000000a1',
  loadPort: '01990000-0000-7000-8005-0000000000a1',
  dischargePort: '01990000-0000-7000-8005-0000000000a2',
  voyage: '01990000-0000-7000-8006-0000000000a1',
  sellerParticipant: '01990000-0000-7000-8007-0000000000a1',
  buyerParticipant: '01990000-0000-7000-8007-0000000000a2',
  contract: '01990000-0000-7000-8008-0000000000a1',
  instruction: '01990000-0000-7000-800a-0000000000a1',
  billOfLading: '01990000-0000-7000-800b-0000000000a1',
  certificate: '01990000-0000-7000-800b-0000000000a2',
};

/** One upload as the API wrote it before reviews: the document advanced, its version, its event. */
const uploadScript = (document: string, versionNumber: number) => `
  ${
    versionNumber === 1
      ? `INSERT INTO documents (id, voyage_id, trade_contract_id, instruction_id, revision_number, document_type)
         VALUES ('${document}', '${ids.voyage}', '${ids.contract}', '${ids.instruction}', 1,
           '${document === ids.billOfLading ? 'BILL_OF_LADING' : 'PHYTOSANITARY_CERTIFICATE'}');`
      : `UPDATE documents SET current_version_number = ${versionNumber} WHERE id = '${document}';`
  }
  INSERT INTO document_versions (document_id, version_number, storage_key, file_name, media_type,
    size_bytes, sha256, uploaded_by_user_id, uploaded_by_organization_id, uploaded_at)
  VALUES ('${document}', ${versionNumber}, gen_random_uuid()::text, 'file-${versionNumber}.pdf',
    'application/pdf', 1000, sha256('${document}-${versionNumber}'), '${ids.sellerUser}',
    '${ids.seller}', now());
  INSERT INTO audit_events (action, actor_user_id, actor_organization_id, voyage_id, payload)
  VALUES ('DOCUMENT_VERSION_UPLOADED', '${ids.sellerUser}', '${ids.seller}', '${ids.voyage}',
    jsonb_build_object('documentId', '${document}', 'versionNumber', ${versionNumber},
      'sha256', encode(sha256('${document}-${versionNumber}'), 'hex')));`;

const PARTIES_AND_INSTRUCTIONS = `
  INSERT INTO organizations (id, name, country_code, updated_at) VALUES
    ('${ids.seller}', 'Seller SA', 'BR', now()),
    ('${ids.buyer}', 'Buyer AG', 'CH', now());
  INSERT INTO users (id, organization_id, email, full_name, role, updated_at) VALUES
    ('${ids.sellerUser}', '${ids.seller}', 'seller@example.com', 'Sam Seller', 'OPERATOR', now()),
    ('${ids.buyerUser}', '${ids.buyer}', 'buyer@example.com', 'Bea Buyer', 'OPERATOR', now());
  INSERT INTO vessels (id, name, imo_number, updated_at) VALUES
    ('${ids.vessel}', 'MV Backfill', '9000001', now());
  INSERT INTO commodities (id, code, name) VALUES ('${ids.commodity}', 'SOY', 'Soybeans');
  INSERT INTO ports (id, un_locode, name, country_code) VALUES
    ('${ids.loadPort}', 'BRSSZ', 'Santos', 'BR'),
    ('${ids.dischargePort}', 'NLRTM', 'Rotterdam', 'NL');
  INSERT INTO voyages (id, reference, vessel_id, commodity_id, quantity, load_port_id,
    discharge_port_id, laycan_start, laycan_end, updated_at)
  VALUES ('${ids.voyage}', 'TF-2026-0001', '${ids.vessel}', '${ids.commodity}', 50000,
    '${ids.loadPort}', '${ids.dischargePort}', '2026-11-01', '2026-11-10', now());
  INSERT INTO voyage_participants (id, voyage_id, organization_id, role) VALUES
    ('${ids.sellerParticipant}', '${ids.voyage}', '${ids.seller}', 'EXPORTER'),
    ('${ids.buyerParticipant}', '${ids.voyage}', '${ids.buyer}', 'FINAL_BUYER');
  INSERT INTO trade_contracts (id, voyage_id, position, seller_participant_id, buyer_participant_id)
  VALUES ('${ids.contract}', '${ids.voyage}', 1, '${ids.sellerParticipant}', '${ids.buyerParticipant}');
  INSERT INTO documentary_instructions (id, voyage_id, trade_contract_id)
  VALUES ('${ids.instruction}', '${ids.voyage}', '${ids.contract}');
  INSERT INTO documentary_instruction_revisions (instruction_id, revision_number, consignee,
    requirements, created_by_user_id, created_by_organization_id, created_at)
  VALUES ('${ids.instruction}', 1, 'To order',
    '[{"document":"BILL_OF_LADING","originals":3,"copies":3},
      {"document":"PHYTOSANITARY_CERTIFICATE","originals":1,"copies":0}]',
    '${ids.buyerUser}', '${ids.buyer}', now());`;

describe('Document review migrations on a populated database', () => {
  let admin: PrismaClient;
  let scratch: PrismaClient;
  let scratchUrl: string;
  let migrations: { name: string; sql: string }[];

  const apply = async (which: (name: string) => boolean) => {
    for (const { name, sql } of migrations.filter(({ name }) => which(name))) {
      await scratch.$executeRawUnsafe(sql).catch((error: unknown) => {
        throw new Error(`Migration ${name} failed`, { cause: error });
      });
    }
  };

  const documents = () =>
    scratch.$queryRaw<{ id: string; version: number; current_version_number: number }[]>`
      SELECT id::text, version, current_version_number FROM documents ORDER BY id`;
  const versions = () =>
    scratch.$queryRaw<unknown[]>`
      SELECT document_id::text, version_number, storage_key, file_name, size_bytes,
        encode(sha256, 'hex') AS sha256, uploaded_at
      FROM document_versions ORDER BY document_id, version_number`;
  const events = () =>
    scratch.$queryRaw<unknown[]>`
      SELECT id::text, action::text, payload, occurred_at FROM audit_events ORDER BY id`;

  beforeAll(async () => {
    const testUrl = new URL(process.env.DATABASE_URL ?? '');
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }) });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH_DATABASE}"`);
    testUrl.pathname = `/${SCRATCH_DATABASE}`;
    scratchUrl = testUrl.toString();
    scratch = new PrismaClient({ adapter: new PrismaPg({ connectionString: scratchUrl }) });

    const names = (await readdir(MIGRATIONS, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort();
    migrations = await Promise.all(
      names.map(async (name) => ({
        name,
        sql: await readFile(join(MIGRATIONS, name, 'migration.sql'), 'utf8'),
      })),
    );
  });

  afterAll(async () => {
    await scratch.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}" WITH (FORCE)`);
    await admin.$disconnect();
  });

  it('counts the uploads of existing documents, changes nothing else, and takes new writes', async () => {
    await apply((name) => name < FIRST_REVIEW_MIGRATION);
    await scratch.$executeRawUnsafe(PARTIES_AND_INSTRUCTIONS);
    // A bill of lading uploaded three times, a certificate once: each upload its own transaction.
    for (const versionNumber of [1, 2, 3]) {
      await scratch.$executeRawUnsafe(uploadScript(ids.billOfLading, versionNumber));
    }
    await scratch.$executeRawUnsafe(uploadScript(ids.certificate, 1));
    const versionsBefore = await versions();
    const eventsBefore = await events();

    await apply((name) => name >= FIRST_REVIEW_MIGRATION);

    expect(await documents()).toEqual([
      { id: ids.billOfLading, version: 3, current_version_number: 3 },
      { id: ids.certificate, version: 1, current_version_number: 1 },
    ]);
    expect(await versions()).toEqual(versionsBefore);
    expect(await events()).toEqual(eventsBefore);
    expect(await scratch.documentReview.count()).toBe(0);

    // The rules hold again for every writer once the backfill is done.
    await expect(
      scratch.$executeRawUnsafe(
        'UPDATE documents SET current_version_number = current_version_number + 1',
      ),
    ).rejects.toThrow(/every change advances the version by exactly one/);

    // The API's writes take the migrated rows as they are: a review of version 3 at version 3,
    // then a replacement at version 4.
    const key = {
      contractId: ids.contract,
      revisionNumber: 1,
      documentType: 'BILL_OF_LADING' as const,
    };
    await scratch.$transaction(async (tx) => {
      const reviewed = await advanceForReview(tx, {
        ...key,
        versionNumber: 3,
        expectedVersions: [3],
        at: new Date(),
      });
      expect(reviewed).toEqual({ id: ids.billOfLading, version: 4, currentVersionNumber: 3 });
      await tx.documentReview.create({
        data: {
          documentId: ids.billOfLading,
          versionNumber: 3,
          decision: 'REJECTED',
          reason: 'Wrong consignee.',
          reviewedByUserId: ids.buyerUser,
          reviewedByOrganizationId: ids.buyer,
          reviewedAt: new Date(),
        },
      });
    });
    await scratch.$transaction(async (tx) => {
      const replaced = await advanceDocumentVersion(tx, {
        ...key,
        expectedVersions: [4],
        at: new Date(),
      });
      expect(replaced).toEqual({ id: ids.billOfLading, version: 5, currentVersionNumber: 4 });
      await tx.$executeRawUnsafe(
        `INSERT INTO document_versions (document_id, version_number, storage_key, file_name,
           media_type, size_bytes, sha256, uploaded_by_user_id, uploaded_by_organization_id,
           uploaded_at)
         VALUES ($1::uuid, 4, gen_random_uuid()::text, 'file-4.pdf', 'application/pdf', 1000,
           sha256('4'), $2::uuid, $3::uuid, now())`,
        ids.billOfLading,
        ids.sellerUser,
        ids.seller,
      );
    });
    expect((await documents())[0]).toEqual({
      id: ids.billOfLading,
      version: 5,
      current_version_number: 4,
    });
  });

  it('leaves the database exactly as the Prisma schema describes it', () => {
    // Read-only: compares the migrated scratch database with the schema, failing on any drift.
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    const diff = () =>
      execFileSync(
        process.execPath,
        [
          prismaCli,
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--exit-code',
        ],
        { cwd: API_ROOT, env: { ...process.env, DATABASE_URL: scratchUrl }, stdio: 'pipe' },
      ).toString();

    expect(diff).not.toThrow();
  });
});
