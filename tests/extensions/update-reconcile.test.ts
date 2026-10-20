// ADR-0017 v2 R2 — release-update reconcile: the running code IS the target
// artifact (trusted build-time composition), so reconcileIdentity applies
// pending versioned migrations through the skip-applied ledger and stamps
// the installed identity (version + manifest fingerprint + CONTENT digest).
// A code-only package revision (manifest unchanged) is caught by the digest.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, loadMigrations, migrateDatabase, systemClock } from "@pcms/core";
import {
  createCapabilityRegistry,
  createExtensionCatalog,
  createExtensionLifecycleService,
  defineExtensionArtifact,
} from "@pcms/extensions/internal";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const ID = "progressive.test-reconcile";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function manifestDocument(version: string): Record<string, unknown> {
  return {
    id: ID,
    name: "Test Reconcile",
    version,
    extension_contract: "2.0",
    cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
    entrypoint: { type: "module" },
    permissions: [],
    requires: [],
    provides: [],
    registrations: {},
    data_policy: "retain",
    migrations: { dir: "migrations" },
  };
}

test("reconcile applies versioned migrations, stamps artifact identity, preserves state and data", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("test database is not configured");
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);

  // Release 1: v1.0.0, one migration, digest A.
  const dir = mkdtempSync(join(tmpdir(), "pcms-reconcile-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifestDocument("1.0.0")));
  mkdirSync(join(dir, "migrations"));
  writeFileSync(
    join(dir, "migrations", "0001_create_t.sql"),
    "CREATE TABLE progressive_test_reconcile_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text);",
  );
  const catalog1 = createExtensionCatalog();
  catalog1.register(
    defineExtensionArtifact({
      manifest: manifestDocument("1.0.0"),
      module: {},
      migrationsDir: join(dir, "migrations"),
      contentSha256: DIGEST_A,
    }),
  );
  const lifecycle1 = createExtensionLifecycleService({
    pool,
    clock: systemClock,
    coreVersion: "1.0.0-rc.1",
    catalog: catalog1,
    systemCapabilities: createCapabilityRegistry(),
  });
  await lifecycle1.install({ extensionId: ID, config: {} });
  await lifecycle1.enable(ID);
  await pool.query(`INSERT INTO progressive_test_reconcile_items (title) VALUES ('keep-me')`);
  const revisionBefore = await lifecycle1.revision();

  // Release 2: v1.1.0, NEW migration, NEW content digest (code-only + schema).
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifestDocument("1.1.0")));
  writeFileSync(
    join(dir, "migrations", "0002_add_note.sql"),
    "ALTER TABLE progressive_test_reconcile_items ADD COLUMN note text;",
  );
  const catalog2 = createExtensionCatalog();
  catalog2.register(
    defineExtensionArtifact({
      manifest: manifestDocument("1.1.0"),
      module: {},
      migrationsDir: join(dir, "migrations"),
      contentSha256: DIGEST_B,
    }),
  );
  const lifecycle2 = createExtensionLifecycleService({
    pool,
    clock: systemClock,
    coreVersion: "1.0.0-rc.1",
    catalog: catalog2,
    systemCapabilities: createCapabilityRegistry(),
  });

  const reconciled = await lifecycle2.reconcileIdentity();
  assert.deepEqual(reconciled, [{ extensionId: ID, appliedMigrations: ["0002_add_note"] }]);

  const installation = await lifecycle2.getInstallation(ID);
  assert.equal(installation?.version, "1.1.0");
  assert.equal(installation?.artifactDigest, DIGEST_B);
  assert.equal(installation?.state, "ENABLED"); // lifecycle state preserved

  // Data survives; the new schema is usable.
  await pool.query(
    `UPDATE progressive_test_reconcile_items SET note = 'x' WHERE title = 'keep-me'`,
  );
  const rows = await pool.query<{ title: string; note: string | null }>(
    `SELECT title, note FROM progressive_test_reconcile_items`,
  );
  assert.equal(rows.rows[0]?.title, "keep-me");
  assert.equal(rows.rows[0]?.note, "x");

  // The reconcile moves the authoritative lifecycle revision (R3), and a
  // second run is a no-op (idempotent).
  assert.notEqual(await lifecycle2.revision(), revisionBefore);
  assert.deepEqual(await lifecycle2.reconcileIdentity(), []);

  // Release 3: CODE-ONLY revision — the manifest is untouched, only package
  // content changes. The digest is the identity that catches it (R2); the
  // reconcile stamps the new digest with an empty migration plan.
  writeFileSync(join(dir, "README.md"), "code-only revision marker\n");
  const digestC = "c".repeat(64);
  const catalog3 = createExtensionCatalog();
  catalog3.register(
    defineExtensionArtifact({
      manifest: manifestDocument("1.1.0"), // same manifest version/content
      module: {},
      migrationsDir: join(dir, "migrations"),
      contentSha256: digestC,
    }),
  );
  const lifecycle3 = createExtensionLifecycleService({
    pool,
    clock: systemClock,
    coreVersion: "1.0.0-rc.1",
    catalog: catalog3,
    systemCapabilities: createCapabilityRegistry(),
  });
  const codeOnly = await lifecycle3.reconcileIdentity();
  assert.deepEqual(codeOnly, [{ extensionId: ID, appliedMigrations: [] }]);
  assert.equal((await lifecycle3.getInstallation(ID))?.artifactDigest, digestC);
  assert.equal((await lifecycle3.getInstallation(ID))?.version, "1.1.0");
});
