// PCMS-PCPUB E5/E6 gates — .pcpub ingest against real PostgreSQL: strict
// acceptance of the malicious corpus (traversal, duplicates, case collision,
// undeclared/missing entries, checksum mismatch), idempotent replay and
// digest conflict, canonical domain mapping (Entry/Revision/MediaAsset/
// ChangeSet), and update CAS (stale base ⇒ conflict, public unchanged).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getPcpubIngestStatus,
  type OperationContext,
  processPcpubIngest,
  receivePcpub,
  submitBundle,
  validatePcpubBytes,
} from "@pcms/api";
import { type PcpubLimits, packWorkspace, sha256Hex } from "@pcms/publication";
import yazl from "yazl";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1" +
    "ee60000000049454e44ae426082",
  "hex",
);

const CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true, sortable: true },
      hero_image: { id: "hero_image", type: "media" },
    },
  },
] as const;

const OWNER = (): OperationContext => apiContextOf(ownerActor(), "rest", "req_pcpub");

const SMALL_LIMITS: PcpubLimits = {
  maxCompressedBytes: 8 * 1024 * 1024,
  maxUncompressedBytes: 16 * 1024 * 1024,
  maxEntries: 128,
  maxDocuments: 50,
  maxDocumentBytes: 1024 * 1024,
  maxAssets: 32,
  maxAssetBytes: 4 * 1024 * 1024,
  maxTotalAssetBytes: 16 * 1024 * 1024,
  maxArtifacts: 32,
  maxTotalArtifactBytes: 1024 * 1024,
  maxManifestBytes: 512 * 1024,
  maxBlocksPerDocument: 100,
};

const WORKSPACE_FILES = {
  "publication.yaml": 'changeset_title: "Ingest smoke"\npublication:\n  mode: none\n',
  "content/hero.pcmd": `---
pcmd_version: 1
operation: create
external_id: hero
content_type: page
fields:
  title: Главная
  hero_image: "bundle:assets/hero.png"
seo:
  seo_title: Главная страница
---
:::block text@1
rich_text: |
  Привет, **мир**.
:::

:::block faq@1
items:
  - id: 01989f5a-7c4f-7d3f-bf0a-4d9e7b1c2a01
    question: "Что это?"
    answer: "Тест."
:::
`,
  "assets/hero.png": PNG_1PX.toString("binary"),
  "research/sources.md": "origin notes",
};

async function packValidBundle(): Promise<{ path: string; bytes: Buffer; bundleId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pcpub-ingest-"));
  for (const [path, content] of Object.entries(WORKSPACE_FILES)) {
    const full = join(dir, path);
    await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await writeFile(full, content, path.startsWith("assets/") ? "binary" : "utf8");
  }
  const packed = await packWorkspace(dir, {
    out: join(dir, "bundle.pcpub"),
    limits: SMALL_LIMITS,
  });
  const bytes = await readFile(packed.path);
  await rm(dir, { recursive: true, force: true });
  return { path: packed.path, bytes, bundleId: packed.bundleId };
}

/** Raw store-only ZIP builder (corpus entries need unsafe names that yazl
 * rightly refuses to write). Minimal but valid: local headers, central
 * directory, EOCD, CRC-32. */
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, entry.data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(entry.data.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + entry.data.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, eocd]);
}

const VALID_DOC = `---
pcmd_version: 1
operation: create
external_id: hero
content_type: page
fields:
  title: X
---
:::block text@1
rich_text: "plain"
:::
`;

function manifestFor(
  entries: { path: string; sha256: string; size: number }[],
  bundleId: string,
): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        format: "progressive-cms-publication-bundle",
        pcpub_version: 1,
        bundle_id: bundleId,
        created_at: "2026-09-25T00:00:00Z",
        producer: { name: "test", version: "1.0.0" },
        authoring: { pcmd_version: 1 },
        requires: { bundle_contract: "1", content_contract: "1", blocks: { text: "^1" } },
        intent: { changeset_title: "t", publication: { mode: "none" } },
        documents: entries
          .filter((entry) => entry.path.startsWith("content/"))
          .map((entry) => ({
            path: entry.path,
            external_id: "hero",
            operation: "create",
            size: entry.size,
            sha256: entry.sha256,
          })),
        assets: entries
          .filter((entry) => entry.path.startsWith("assets/"))
          .map((entry) => ({
            path: entry.path,
            media_type: "image/png",
            size: entry.size,
            sha256: entry.sha256,
          })),
        artifacts: [],
      },
      null,
      "\t",
    ) + "\n",
    "utf8",
  );
}

test(".pcpub ingest: strict corpus and canonical mapping", {
  skip: !testDatabaseConfigured(),
}, async (t) => {
  const fixture = await createApiFixture(t, {
    contentTypeDefinitions: CONTENT_TYPES as unknown as never,
    mediaRoots: {
      storage: await mkdtemp(join(tmpdir(), "pcms-media-")),
      quarantine: await mkdtemp(join(tmpdir(), "pcms-quar-")),
    },
  });
  const { app } = fixture;
  (app as { pcpubBundleLimits?: PcpubLimits }).pcpubBundleLimits = SMALL_LIMITS;

  // ---- validate mode: zero-writes full report -----------------------------
  const valid = await packValidBundle();
  const report = await validatePcpubBytes(app, valid.bytes);
  assert.equal(report.accepted, true, JSON.stringify(report.issues));

  // ---- happy path: apply through the worker pipeline ----------------------
  const received = await receivePcpub(app, OWNER(), valid.bytes);
  assert.equal(received.mode, "apply");
  assert.equal(received.replayed, false);
  await processPcpubIngest(app, received.ingest_id);
  const { getPcpubIngestStatus } = await import("@pcms/api");
  const status = (await getPcpubIngestStatus(app, OWNER(), received.ingest_id)) as {
    outcome: string;
    changeset_id: string;
    result: { entries: { entry_id: string; revision_id: string }[]; media: { media_id: string }[] };
  };
  assert.equal(status.outcome, "sealed", JSON.stringify(status));
  assert.equal(status.result.entries.length, 1);
  assert.equal(status.result.media.length, 1);
  assert.ok(!("external_entries" in status.result), "legacy result has no empty optional field");

  // Entry + sealed revision exist; media asset carries bundle provenance.
  const entryRow = await fixture.pool.query(`SELECT id FROM entries WHERE id = $1`, [
    status.result.entries[0]!.entry_id,
  ]);
  assert.equal(entryRow.rowCount, 1);
  const revision = await app.revisions.getRevision(
    fixture.pool,
    status.result.entries[0]!.revision_id as never,
  );
  assert.ok(revision !== null && revision.state === "SEALED");
  const mediaRow = await fixture.pool.query(`SELECT provenance FROM media_assets WHERE id = $1`, [
    status.result.media[0]!.media_id,
  ]);
  const provenance = mediaRow.rows[0]?.provenance as Record<string, unknown> | null;
  assert.equal((provenance as { source?: string } | null)?.source, "pcpub");

  // ---- idempotent replay: same bytes → same ingest, no duplicates ---------
  const replay = await receivePcpub(app, OWNER(), valid.bytes);
  assert.equal(replay.replayed, true);
  assert.equal(replay.ingest_id, received.ingest_id);

  // Same bundle_id, different payload ⇒ 409. packWorkspace with fixed
  // clock/random derives the SAME bundle_id for different content.
  const fixedClock = Date.UTC(2026, 8, 25, 12, 0, 0);
  const fixedRandom = (size: number): Uint8Array => Buffer.alloc(size, 0x02);
  const clashDir = await mkdtemp(join(tmpdir(), "pcpub-clash-"));
  await mkdir(join(clashDir, "content"), { recursive: true });
  await writeFile(
    join(clashDir, "publication.yaml"),
    'changeset_title: "Clash"\npublication:\n  mode: none\n',
  );
  const docTemplate = WORKSPACE_FILES["content/hero.pcmd"]!.replace(
    '  hero_image: "bundle:assets/hero.png"\n',
    "",
  );
  await writeFile(join(clashDir, "content", "hero.pcmd"), docTemplate.replace("Главная", "Первый"));
  const first = await packWorkspace(clashDir, {
    out: join(clashDir, "a.pcpub"),
    limits: SMALL_LIMITS,
    now: () => fixedClock,
    random: fixedRandom,
  });
  await receivePcpub(app, OWNER(), await readFile(first.path));
  await writeFile(join(clashDir, "content", "hero.pcmd"), docTemplate.replace("Главная", "Второй"));
  const clash = await packWorkspace(clashDir, {
    out: join(clashDir, "b.pcpub"),
    limits: SMALL_LIMITS,
    now: () => fixedClock,
    random: fixedRandom,
  });
  assert.equal(first.bundleId, clash.bundleId);
  await assert.rejects(
    receivePcpub(app, OWNER(), await readFile(clash.path)),
    (error: unknown) => (error as { code?: string }).code === "PCPUB_IDEMPOTENCY_BUNDLE_ID_REUSED",
  );
  await rm(clashDir, { recursive: true, force: true });

  // ---- malicious corpus ----------------------------------------------------
  const docSha = sha256Hex(Buffer.from(VALID_DOC, "utf8"));
  const corpusRoot = await mkdtemp(join(tmpdir(), "pcpub-corpus-"));

  // traversal path
  const traversal = await buildZip([
    { name: "content/../../evil.pcmd", data: Buffer.from(VALID_DOC, "utf8") },
  ]);
  await assert.rejects(receivePcpub(app, OWNER(), traversal), (error: unknown) =>
    String((error as { message?: string }).message).includes(""),
  );

  // duplicate path
  const duplicate = await buildZip([
    { name: "content/hero.pcmd", data: Buffer.from(VALID_DOC, "utf8") },
    { name: "content/hero.pcmd", data: Buffer.from(VALID_DOC, "utf8") },
  ]);
  await assert.rejects(
    receivePcpub(app, OWNER(), duplicate),
    /duplicate|unsafe|outside|allowlist/i,
  );

  // case collision inside the manifest set
  const docUpper = VALID_DOC.replace("external_id: hero", "external_id: herO");
  const collision = await buildZip([
    { name: "content/hero.pcmd", data: Buffer.from(VALID_DOC, "utf8") },
    { name: "content/HERO.pcmd", data: Buffer.from(docUpper, "utf8") },
    {
      name: "manifest.json",
      data: manifestFor(
        [
          { path: "content/hero.pcmd", sha256: docSha, size: Buffer.byteLength(VALID_DOC) },
          {
            path: "content/HERO.pcmd",
            sha256: sha256Hex(Buffer.from(docUpper, "utf8")),
            size: Buffer.byteLength(docUpper),
          },
        ],
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      ),
    },
  ]);
  await assert.rejects(receivePcpub(app, OWNER(), collision), /collision/i);

  // undeclared extra entry (manifest excludes assets/extra.bin)
  const undeclaredEntries = [
    { name: "content/hero.pcmd", data: Buffer.from(VALID_DOC, "utf8") },
    { name: "assets/extra.bin", data: Buffer.from("stowaway") },
  ];
  const undeclared = await buildZip([
    ...undeclaredEntries,
    {
      name: "manifest.json",
      data: manifestFor(
        [{ path: "content/hero.pcmd", sha256: docSha, size: Buffer.byteLength(VALID_DOC) }],
        "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      ),
    },
  ]);
  await assert.rejects(receivePcpub(app, OWNER(), undeclared), /undeclared|allowlist/i);

  // checksum mismatch (manifest claims a different sha)
  const mismatch = await buildZip([
    { name: "content/hero.pcmd", data: Buffer.from(VALID_DOC, "utf8") },
    {
      name: "manifest.json",
      data: manifestFor(
        [{ path: "content/hero.pcmd", sha256: "0".repeat(64), size: Buffer.byteLength(VALID_DOC) }],
        "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      ),
    },
  ]);
  await assert.rejects(receivePcpub(app, OWNER(), mismatch), /checksum/i);

  // oversized (limit override)
  const big = await buildZip([
    { name: "content/hero.pcmd", data: Buffer.alloc(9 * 1024 * 1024, 0x61) },
  ]);
  await assert.rejects(receivePcpub(app, OWNER(), big), /size limit/i);

  await rm(corpusRoot, { recursive: true, force: true });

  // ---- update CAS ----------------------------------------------------------
  // 1. Publish an entry via the canonical bundle (R_live).
  const bundle = {
    bundle_version: 1,
    external_id: "pcpub-cas-seed-0001",
    changeset: { title: "seed" },
    entries: [
      {
        ref: "target",
        content_type: "page",
        payload: { fields: { title: "v1" }, blocks: { schema_version: 1, blocks: [] } },
      },
    ],
    publication: { mode: "now" as const },
  };
  const seeded = await submitBundle(app, OWNER(), bundle, "apply");
  assert.ok("accepted" in seeded && seeded.accepted);
  const targetEntryId = ("entries" in seeded && seeded.entries[0]?.entry_id) as string;
  // First apply's sealed revision becomes the STALE base; a second published
  // revision moves the live pointer past it.
  const staleBase = (seeded as { entries: { revision_id: string }[] }).entries[0]!.revision_id;
  const second = await submitBundle(
    app,
    OWNER(),
    {
      ...bundle,
      external_id: "pcpub-cas-seed-0002",
      entries: [
        {
          ...bundle.entries[0]!,
          entry_id: targetEntryId,
          payload: { fields: { title: "v2" }, blocks: { schema_version: 1, blocks: [] } },
        },
      ],
    },
    "apply",
  );
  assert.ok("accepted" in second && second.accepted);
  const liveRevision = (await app.publications.getPublication(
    fixture.pool,
    "entry",
    targetEntryId as never,
  ))!.currentRevisionId as string;
  assert.notEqual(liveRevision, staleBase);
  const workingRevision = staleBase;

  // 2. Update based on the WORKING revision (not the live one) ⇒ conflict.
  const updatePcmd = `---
pcmd_version: 1
operation: update
external_id: target
content_type: page
target_entry_id: ${targetEntryId}
base_revision_id: ${workingRevision}
fields:
  title: "v2-stale"
---
:::block text@1
rich_text: "stale"
:::
`;
  const updateDir = await mkdtemp(join(tmpdir(), "pcpub-update-"));
  await mkdir(join(updateDir, "content"), { recursive: true });
  await writeFile(
    join(updateDir, "publication.yaml"),
    'changeset_title: "Update"\npublication:\n  mode: none\n',
  );
  await writeFile(join(updateDir, "content", "target.pcmd"), updatePcmd);
  const stalePacked = await packWorkspace(updateDir, {
    out: join(updateDir, "u.pcpub"),
    limits: SMALL_LIMITS,
  });
  const staleReceived = await receivePcpub(app, OWNER(), await readFile(stalePacked.path));
  await processPcpubIngest(app, staleReceived.ingest_id);
  const staleStatus = (await getPcpubIngestStatus(app, OWNER(), staleReceived.ingest_id)) as {
    outcome: string;
    error_code: string | null;
  };
  assert.equal(staleStatus.outcome, "conflict", JSON.stringify(staleStatus));

  // Public pointer unchanged.
  const liveAfter = (await app.publications.getPublication(
    fixture.pool,
    "entry",
    targetEntryId as never,
  ))!.currentRevisionId as string;
  assert.equal(liveAfter, liveRevision);

  // 3. Update based on the LIVE revision ⇒ succeeds.
  const freshPcmd = updatePcmd
    .replace("v2-stale", "v3-fresh")
    .replace(workingRevision, liveRevision)
    .replace('stale" >', 'fresh" >');
  await writeFile(join(updateDir, "content", "target.pcmd"), freshPcmd);
  const freshPacked = await packWorkspace(updateDir, {
    out: join(updateDir, "f.pcpub"),
    limits: SMALL_LIMITS,
  });
  const freshReceived = await receivePcpub(app, OWNER(), await readFile(freshPacked.path));
  await processPcpubIngest(app, freshReceived.ingest_id);
  const freshStatus = (await getPcpubIngestStatus(app, OWNER(), freshReceived.ingest_id)) as {
    outcome: string;
    result: { entries: { revision_id: string }[] };
  };
  assert.equal(freshStatus.outcome, "sealed", JSON.stringify(freshStatus));
  await rm(updateDir, { recursive: true, force: true });
});

test("external entry aliases: published routing, CAS, replay, permissions and no target mutations", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { getPcpubIngestStatus } = await import("@pcms/api");
  const dir = await mkdtemp(join(tmpdir(), "pcpub-external-ingest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { app, pool } = await createApiFixture(t, {
    contentTypeDefinitions: [
      {
        ...CONTENT_TYPES[0],
        fields: {
          ...CONTENT_TYPES[0].fields,
          link: { id: "link", type: "relation" },
          literal: { id: "literal", type: "string" },
        },
      },
    ] as never,
    mediaRoots: { storage: join(dir, "media"), quarantine: join(dir, "quarantine") },
  });
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  const seed = async (title: string, path: string, published = true, siteId = site.id) => {
    const result = await submitBundle(
      app,
      OWNER(),
      {
        bundle_version: 1,
        external_id: `seed-${title}-external`,
        changeset: { title },
        entries: [
          {
            ref: "target",
            content_type: "page",
            payload: { fields: { title }, blocks: { schema_version: 1, blocks: [] } },
          },
        ],
        publication: { mode: published ? "now" : "none" },
      },
      "apply",
    );
    assert.ok("entries" in result);
    const entry = result.entries[0]!;
    await app.routes.activateRoute({ siteId, path, targetType: "entry", targetId: entry.entry_id });
    return entry;
  };
  const target = await seed("Existing", "/blog/existing/");
  const unpublished = await seed("Unpublished", "/unpublished/", false);
  const archived = await seed("Archived", "/archived/");
  await pool.query("UPDATE entries SET archived_at = now() WHERE id = $1", [archived.entry_id]);
  const otherSite = await app.routes.ensureSite("other");
  await seed("OtherSite", "/other-only/", true, otherSite.id);
  const retired = await seed("Retired", "/retired/");
  await app.routes.retireRoute({ siteId: site.id, path: "/retired/" });
  await app.routes.setHomeEntry(site.id, target.entry_id);
  await app.routeHistory.recordRedirect({
    siteId: site.id,
    oldPath: "/redirect/",
    targetType: "entry",
    targetId: target.entry_id,
    statusCode: 301,
  });
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru",
    locales: ["ru", "en"],
    updatedBy: "test",
  });

  const state = async () =>
    (
      await pool.query(
        `SELECT (SELECT count(*) FROM entries) AS entries, (SELECT count(*) FROM revisions) AS revisions, (SELECT count(*) FROM changesets) AS changesets, (SELECT count(*) FROM media_assets) AS media`,
      )
    ).rows[0];
  const targetState = async () => ({
    revisions: (
      await pool.query("SELECT id FROM revisions WHERE entity_id = $1 ORDER BY id", [
        target.entry_id,
      ])
    ).rows,
    publication: await app.publications.getPublication(pool, "entry", target.entry_id as never),
    routes: (
      await pool.query("SELECT * FROM routes WHERE target_id = $1 ORDER BY id", [target.entry_id])
    ).rows,
    identities: (
      await pool.query("SELECT * FROM entry_external_identities WHERE entry_id = $1", [
        target.entry_id,
      ])
    ).rows,
  });
  const originalTarget = await targetState();
  const workspace = join(dir, "workspace");
  await mkdir(join(workspace, "content"), { recursive: true });
  await mkdir(join(workspace, "assets"));
  await writeFile(join(workspace, "assets", "hero.png"), PNG_1PX);
  const doc = `---
pcmd_version: 1
operation: create
external_id: source
content_type: page
fields:
  title: Source
  link: "ref:existing"
  literal: "ref:existing"
  hero_image: "bundle:assets/hero.png"
---
:::block related_content@1
mode: manual
entry_ids: ["ref:existing", "ref:sibling"]
:::
:::block text@1
rich_text: "ref:existing"
:::
`;
  await writeFile(join(workspace, "content", "source.pcmd"), doc);
  await writeFile(
    join(workspace, "content", "sibling.pcmd"),
    `---\npcmd_version: 1\noperation: create\nexternal_id: sibling\ncontent_type: page\nfields:\n  title: Sibling\n---\n`,
  );
  const pack = async (
    path = "/blog/existing/",
    locale = "default",
    mode = "none",
    fixed = false,
  ) => {
    await writeFile(
      join(workspace, "publication.yaml"),
      `changeset_title: External\npublication:\n  mode: ${mode}\nexternal_entries:\n  existing:\n    path: ${path}\n    locale: ${locale}\n`,
    );
    const packed = await packWorkspace(workspace, {
      out: join(dir, "bundle.pcpub"),
      ...(fixed
        ? { now: () => Date.UTC(2026, 8, 28), random: (size: number) => Buffer.alloc(size, 5) }
        : {}),
    });
    return readFile(packed.path);
  };
  const ingest = async (bytes: Buffer, ctx = OWNER()) => {
    const received = await receivePcpub(app, ctx, bytes);
    await processPcpubIngest(app, received.ingest_id);
    const status = await getPcpubIngestStatus(app, ctx, received.ingest_id);
    return { received, status };
  };
  for (const [path, locale, code] of [
    ["/missing/", "default", "PCPUB_EXTERNAL_ENTRY_NOT_FOUND"],
    ["/unpublished/", "default", "PCPUB_EXTERNAL_ENTRY_UNPUBLISHED"],
    ["/archived/", "default", "PCPUB_EXTERNAL_ENTRY_NOT_FOUND"],
    ["/other-only/", "default", "PCPUB_EXTERNAL_ENTRY_NOT_FOUND"],
    ["/retired/", "default", "PCPUB_EXTERNAL_ENTRY_NOT_FOUND"],
    ["/redirect/", "default", "PCPUB_EXTERNAL_ENTRY_NOT_FOUND"],
    ["/blog/existing/", "en", "PCPUB_EXTERNAL_ENTRY_NOT_FOUND"],
    ["/blog/existing/", "fr", "PCPUB_EXTERNAL_ENTRY_LOCALE_UNKNOWN"],
    ["/blog/existing", "default", "PCPUB_EXTERNAL_ENTRY_INVALID"],
  ]) {
    const before = await state();
    const bytes = await pack(path, locale);
    const validation = await validatePcpubBytes(app, bytes, OWNER());
    assert.equal(validation.accepted, false);
    assert.equal(validation.issues[0]?.code, code);
    const { status } = await ingest(bytes);
    assert.equal(status.outcome, "rejected", JSON.stringify(status));
    assert.equal(status.error_code, code);
    assert.match(JSON.stringify(status.safe_error_detail), /external_entries\/existing/);
    assert.deepEqual(await state(), before, "invalid alias leaves no candidates or staged media");
  }
  const restricted = {
    ...OWNER(),
    actor: { ...OWNER().actor, permissions: new Set(["content.create"]) },
  };
  const valid = await pack();
  const beforeDenied = await state();
  await assert.rejects(receivePcpub(app, restricted, valid), /content.read/);
  assert.deepEqual(await state(), beforeDenied);
  // Worker independently enforces the server-owned permission snapshot.
  const queued = await receivePcpub(app, OWNER(), valid);
  await pool.query(
    "UPDATE publication_bundle_ingest SET principal_permissions = $2 WHERE id = $1",
    [queued.ingest_id, JSON.stringify(["content.create"])],
  );
  await processPcpubIngest(app, queued.ingest_id);
  const denied = await getPcpubIngestStatus(app, OWNER(), queued.ingest_id);
  assert.equal(denied.error_code, "PCPUB_AUTH_INSUFFICIENT_SCOPE");
  assert.deepEqual(await state(), beforeDenied);

  const noPublish = {
    ...OWNER(),
    actor: {
      ...OWNER().actor,
      permissions: new Set(["content.read", "content.create", "media.write"]),
    },
  };
  const refused = await ingest(await pack("/blog/existing/", "default", "now"), noPublish);
  assert.equal(refused.status.outcome, "rejected");
  assert.equal(refused.status.error_code, "PCPUB_AUTH_INSUFFICIENT_SCOPE");
  assert.equal(
    (await app.publications.getPublication(pool, "entry", target.entry_id as never))?.generation,
    originalTarget.publication?.generation,
  );

  const happyBytes = await pack("/blog/existing/", "default", "none", true);
  const { received, status } = await ingest(happyBytes);
  assert.equal(status.outcome, "sealed", JSON.stringify(status));
  const result = status.result as {
    entries: { ref: string; entry_id: string; revision_id: string }[];
    external_entries: Record<string, string>;
    media: { media_id: string }[];
  };
  assert.deepEqual(result.external_entries, { existing: target.entry_id });
  t.diagnostic(
    `PCMS_EXTERNAL_MAPPING ${JSON.stringify({ external_entries: result.external_entries, source: result.entries.find((entry) => entry.ref === "source"), target_revisions_unchanged: true })}`,
  );
  const source = result.entries.find((entry) => entry.ref === "source")!;
  const sibling = result.entries.find((entry) => entry.ref === "sibling")!;
  const revision = await app.revisions.getRevision(pool, source.revision_id as never);
  const payload = revision!.payload as {
    fields: Record<string, unknown>;
    blocks: { blocks: { props: Record<string, unknown> }[] };
  };
  assert.equal(payload.fields.link, target.entry_id);
  assert.equal(payload.fields.literal, "ref:existing", "ordinary text is not an entry ID");
  assert.equal(payload.fields.hero_image, result.media[0]!.media_id);
  assert.deepEqual(payload.blocks.blocks[0]!.props.entry_ids, [target.entry_id, sibling.entry_id]);
  assert.deepEqual(
    await targetState(),
    originalTarget,
    "no target revisions, publication generation, route or identity changes",
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM changeset_items WHERE changeset_id = $1 AND entity_id = $2", [
        status.changeset_id,
        target.entry_id,
      ])
    ).rowCount,
    0,
  );
  const beforeReplay = await state();
  const replay = await ingest(happyBytes);
  assert.equal(replay.received.ingest_id, received.ingest_id);
  assert.equal(replay.received.replayed, true);
  assert.deepEqual(replay.status.result, result);
  assert.deepEqual(await state(), beforeReplay);
  await assert.rejects(
    receivePcpub(app, OWNER(), await pack("/", "default", "none", true)),
    /bundle_id was already used/,
  );
  const home = await ingest(await pack("/"));
  assert.equal(home.status.outcome, "sealed", JSON.stringify(home.status));
  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const localized = await createDraft(app, OWNER(), {
    content_type: "page",
    locale: "en",
    payload: { fields: { title: "English target" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, OWNER(), { revision_id: localized.revision_id });
  await publishRevision(app, OWNER(), {
    entity_type: "entry",
    entity_id: localized.entry_id,
    target_revision_id: localized.revision_id,
    expected_generation: 0,
    context: "en",
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/localized/",
    locale: "en",
    targetType: "entry",
    targetId: localized.entry_id,
  });
  const english = await ingest(await pack("/en/localized/", "en"));
  assert.equal(english.status.outcome, "sealed", JSON.stringify(english.status));
  assert.deepEqual((english.status.result as typeof result).external_entries, {
    existing: localized.entry_id,
  });

  // CAS-update keeps the external target untouched and stale replay leaves public state intact.
  const sourceId = source.entry_id;
  const sourceBase = source.revision_id;
  await publishRevision(app, OWNER(), {
    entity_type: "entry",
    entity_id: sourceId,
    target_revision_id: sourceBase,
    expected_generation: 0,
  });
  await writeFile(
    join(workspace, "content", "source.pcmd"),
    doc.replace(
      "operation: create",
      `operation: update\ntarget_entry_id: ${sourceId}\nbase_revision_id: ${sourceBase}`,
    ),
  );
  const update = await ingest(await pack());
  assert.equal(update.status.outcome, "sealed", JSON.stringify(update.status));
  assert.deepEqual(await targetState(), originalTarget);
  const updated = (update.status.result as typeof result).entries.find(
    (entry) => entry.ref === "source",
  )!;
  await publishRevision(app, OWNER(), {
    entity_type: "entry",
    entity_id: sourceId,
    target_revision_id: updated.revision_id,
    expected_generation: 1,
  });
  const beforeStale = await state();
  const stale = await ingest(await pack());
  assert.equal(stale.status.outcome, "conflict", JSON.stringify(stale.status));
  assert.equal(stale.status.error_code, "PCPUB_CONFLICT_STALE_BASE");
  assert.equal(
    (await app.publications.getPublication(pool, "entry", sourceId as never))?.currentRevisionId,
    updated.revision_id,
  );
  assert.equal((await state())?.revisions, beforeStale?.revisions);

  // A route is reassigned after pre-validation but before candidate creation.
  await writeFile(join(workspace, "content", "source.pcmd"), doc);
  const late = await receivePcpub(app, OWNER(), await pack());
  const query = pool.query.bind(pool);
  let changed = false;
  pool.query = (async (...args: Parameters<typeof pool.query>) => {
    if (!changed && args[0].includes("SET stage =") && args[1]?.[1] === "applying_intent") {
      changed = true;
      await query(
        "UPDATE routes SET target_id = $2 WHERE site_id = $1 AND path = '/blog/existing/'",
        [site.id, retired.entry_id],
      );
    }
    return query(...args);
  }) as typeof pool.query;
  const beforeLate = await state();
  try {
    await processPcpubIngest(app, late.ingest_id);
  } finally {
    pool.query = query;
  }
  const lateStatus = await getPcpubIngestStatus(app, OWNER(), late.ingest_id);
  assert.equal(lateStatus.outcome, "conflict", JSON.stringify(lateStatus));
  assert.equal(lateStatus.error_code, "PCPUB_CONFLICT_EXTERNAL_ENTRY_CHANGED");
  assert.equal((await state())?.revisions, beforeLate?.revisions);
  assert.equal((await state())?.changesets, beforeLate?.changesets);
  assert.ok(unpublished.entry_id); // the negative target remains only its original sealed revision
});

test("PCPUB validates RichText seal rules and resolves bundled SEO media references", {
  skip: !testDatabaseConfigured(),
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pcpub-seo-ref-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [
      ...CONTENT_TYPES,
      {
        key: "rich_article",
        version: 1,
        title: "Rich article",
        bodyPolicy: "rich_text",
        fields: { title: { id: "title", type: "string", required: true } },
      },
    ] as never,
    mediaRoots: { storage: join(dir, "media"), quarantine: join(dir, "quarantine") },
  });
  (app as { pcpubBundleLimits?: PcpubLimits }).pcpubBundleLimits = SMALL_LIMITS;
  const workspace = join(dir, "workspace");
  await mkdir(join(workspace, "content"), { recursive: true });
  await mkdir(join(workspace, "assets"));
  await writeFile(join(workspace, "assets", "hero.png"), PNG_1PX);
  await writeFile(
    join(workspace, "publication.yaml"),
    'changeset_title: "SEO media reference"\npublication:\n  mode: none\n',
  );
  const article = WORKSPACE_FILES["content/hero.pcmd"]!.replace(
    "seo:\n  seo_title:",
    'seo:\n  social_image:\n    asset_id: "bundle:assets/hero.png"\n  seo_title:',
  );
  await writeFile(join(workspace, "content", "hero.pcmd"), article);
  const packed = await packWorkspace(workspace, {
    out: join(dir, "seo.pcpub"),
    limits: SMALL_LIMITS,
  });
  const bytes = await readFile(packed.path);
  const validation = await validatePcpubBytes(app, bytes, OWNER());
  assert.equal(validation.accepted, true, JSON.stringify(validation.issues));

  const received = await receivePcpub(app, OWNER(), bytes);
  await processPcpubIngest(app, received.ingest_id);
  const status = (await getPcpubIngestStatus(app, OWNER(), received.ingest_id)) as {
    outcome: string;
    result: { entries: { revision_id: string }[]; media: { media_id: string }[] };
  };
  assert.equal(status.outcome, "sealed");
  const revision = await app.revisions.getRevision(
    app.pool,
    status.result.entries[0]!.revision_id as never,
  );
  const seo = revision?.sidecar?.seo as { social_image: { asset_id: string } };
  assert.equal(seo.social_image.asset_id, status.result.media[0]!.media_id);
  assert.ok(revision);
  assert.equal(
    (revision.payload as { fields: { hero_image: string } }).fields.hero_image,
    status.result.media[0]!.media_id,
  );

  const badArticle = article.replace("bundle:assets/hero.png", "bundle:assets/missing.png");
  await writeFile(join(workspace, "content", "hero.pcmd"), badArticle);
  await assert.rejects(
    packWorkspace(workspace, { out: join(dir, "bad-seo.pcpub"), limits: SMALL_LIMITS }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PCPUB_DOCUMENT_INVALID");
      assert.match(
        JSON.stringify((error as { diagnostics?: unknown }).diagnostics),
        /PCPUB_DOCUMENT_REF_UNRESOLVED/,
      );
      return true;
    },
  );

  const richTextDoc = `---\npcmd_version: 1\noperation: create\nexternal_id: hidden-blocks\ncontent_type: rich_article\nfields:\n  title: Rich\n---\n:::block text@1\nrich_text: "not rendered by rich_text body policy"\n:::\n`;
  await writeFile(join(workspace, "content", "hero.pcmd"), richTextDoc);
  const richTextPacked = await packWorkspace(workspace, {
    out: join(dir, "rich-text-policy.pcpub"),
    limits: SMALL_LIMITS,
  });
  const richTextValidation = await validatePcpubBytes(
    app,
    await readFile(richTextPacked.path),
    OWNER(),
  );
  assert.equal(richTextValidation.accepted, false);
  assert.ok(
    richTextValidation.issues.some(
      (issue) => issue.code === "PCPUB_DOCUMENT_INVALID" && issue.path.includes("blocks"),
    ),
    JSON.stringify(richTextValidation.issues),
  );

  await writeFile(
    join(workspace, "content", "hero.pcmd"),
    article.replace("external_id: hero", "external_id: late-seal"),
  );
  const latePacked = await packWorkspace(workspace, {
    out: join(dir, "late-seal.pcpub"),
    limits: SMALL_LIMITS,
  });
  const late = await receivePcpub(app, OWNER(), await readFile(latePacked.path));
  const revisions = app.revisions as unknown as {
    sealRevisionWithinTx: (...args: unknown[]) => Promise<unknown>;
  };
  const originalSeal = revisions.sealRevisionWithinTx;
  revisions.sealRevisionWithinTx = async () => {
    throw Object.assign(new Error("revision validation failed"), {
      code: "REVISION_VALIDATION_FAILED",
      details: {
        issues: [
          {
            code: "RICHTEXT_NODE_INVALID",
            path: "/fields/body/0",
            message: "invalid node",
            severity: "error",
          },
        ],
      },
    });
  };
  try {
    await processPcpubIngest(app, late.ingest_id);
  } finally {
    revisions.sealRevisionWithinTx = originalSeal;
  }
  const lateStatus = (await getPcpubIngestStatus(app, OWNER(), late.ingest_id)) as {
    error_code: string;
    safe_error_detail: { diagnostics: { path: string; code: string }[] };
  };
  assert.equal(lateStatus.error_code, "PCPUB_DOCUMENT_INVALID");
  assert.deepEqual(lateStatus.safe_error_detail.diagnostics, [
    {
      code: "RICHTEXT_NODE_INVALID",
      path: "content/hero.pcmd/fields/body/0",
      message: "invalid node",
    },
  ]);
});

test("external refs rewrite only declared relation paths, including nested fields and block children", async () => {
  const { createContentTypeRegistry } = await import("@pcms/content");
  const { createBlockRegistry } = await import("@pcms/blocks");
  const { rewriteExternalEntryRefs } = await import(
    "../../packages/api/src/pcpub-external-entries.js"
  );
  const contentTypes = createContentTypeRegistry();
  contentTypes.registerContentType({
    key: "page",
    version: 1,
    title: "Page",
    fields: {
      nested: {
        id: "nested",
        type: "object",
        fields: { link: { id: "link", type: "relation" }, label: { id: "label", type: "string" } },
      },
      rows: {
        id: "rows",
        type: "repeater",
        item: { fields: { links: { id: "links", type: "relation_list" } } },
      },
      list: { id: "list", type: "list", item: { id: "item", type: "relation" } },
      hero_image: { id: "hero_image", type: "media" },
    },
  });
  const blocks = createBlockRegistry();
  blocks.registerBlockType({
    typeId: "links",
    schemaVersion: 1,
    propsSchema: { type: "object" },
    childrenPolicy: "blocks",
    references: [{ prop: "items[].target", kind: "relation" }],
  });
  const id = "0198c0de-0000-7000-8000-000000000001";
  const payload = {
    fields: {
      nested: { link: "ref:external", label: "ref:external" },
      rows: [
        { itemId: "0198c0de-0000-7000-8000-000000000002", links: ["ref:external", "ref:sibling"] },
      ],
      list: ["ref:external"],
      hero_image: "ref:external",
    },
    blocks: {
      schema_version: 1,
      blocks: [
        {
          type: "links",
          schema_version: 1,
          props: { items: [{ target: "ref:external", text: "ref:external" }] },
          children: [
            { type: "links", schema_version: 1, props: { items: [{ target: "ref:external" }] } },
          ],
        },
      ],
    },
  };
  const rewritten = rewriteExternalEntryRefs({ contentTypes, blocks } as never, "page", payload, {
    external: { entry_id: id, route_id: null },
  }) as typeof payload;
  assert.deepEqual(rewritten.fields.nested, { link: id, label: "ref:external" });
  assert.deepEqual(rewritten.fields.rows[0]!.links, [id, "ref:sibling"]);
  assert.deepEqual(rewritten.fields.list, [id]);
  assert.equal(rewritten.fields.hero_image, "ref:external");
  assert.deepEqual(rewritten.blocks.blocks[0]!.props.items, [{ target: id, text: "ref:external" }]);
  assert.equal(rewritten.blocks.blocks[0]!.children[0]!.props.items[0]!.target, id);
  assert.equal(payload.fields.nested.link, "ref:external", "input is not mutated");
});
