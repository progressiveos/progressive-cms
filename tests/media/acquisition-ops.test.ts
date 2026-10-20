// PCMS-MPA-T009/T010/T011 — acquisition security + ingest integration:
// candidate tokens are server-authoritative (tamper/expiry rejected), stock
// import goes through the canonical ingest pipeline with provenance and is
// duplicate-safe, generation accept replays to the same asset, and the
// permission boundary matches the registry (media.stock.search / import /
// generate are distinct from media.providers.manage).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ApplicationServices,
  acceptGeneratedMediaOp,
  createMediaGenerationOp,
  importStockCandidateOp,
  type OperationContext,
  searchStockMediaOp,
} from "@pcms/api";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createGenerationRun,
  type ImageGenerationProvider,
  InMemoryMediaStorage,
  type MediaStockProvider,
  markGenerationRunReady,
  markGenerationRunRunning,
  signStockCandidate,
  verifyStockCandidate,
} from "@pcms/media";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const SIGNING_KEY = "test-signing-key-material";

const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1" +
    "ee60000000049454e44ae426082",
  "hex",
);

const fixedClock = { now: () => new Date("2026-09-25T00:00:00.000Z") };

const stockProvider: MediaStockProvider = {
  providerId: "teststock",
  displayName: "Test Stock",
  capabilities: () => ({ providerId: "teststock", displayName: "Test Stock" }),
  async search(_ctx, _request) {
    return {
      candidates: [
        {
          providerId: "teststock",
          providerAssetId: "asset-1",
          previewUrl: "https://cdn.example.test/preview.jpg",
          downloadUrl: "https://cdn.example.test/full.jpg",
          width: 1600,
          height: 900,
          creatorName: "Test Creator",
          creatorUrl: "https://creator.example.test",
          sourceUrl: "https://stock.example.test/asset-1",
          licenseName: "Test License",
          licenseUrl: "https://license.example.test",
        },
      ],
      nextCursor: null,
    };
  },
  async fetch() {
    return { bytes: PNG_1PX, mimeType: "image/png", filename: "asset-1.png" };
  },
  async testConnection() {
    return { ok: true, message: null };
  },
};

const generationProvider: ImageGenerationProvider = {
  providerId: "testgen",
  displayName: "Test Gen",
  capabilities: () => ({
    providerId: "testgen",
    displayName: "Test Gen",
    models: ["m1"],
    maxCount: 4,
    supportsSeed: true,
    supportsNegativePrompt: true,
    aspects: ["1:1", "16:9"],
  }),
  async generate(_ctx, _request) {
    return {
      candidates: [
        {
          index: 0,
          previewUrl: "https://gen.example.test/0.png",
          downloadUrl: "https://gen.example.test/0.png",
          width: 1024,
          height: 1024,
          mimeType: "image/png",
          model: "m1",
          providerRequestId: "req-1",
          seed: 42,
          cost: 0.5,
        },
      ],
      providerRequestId: "task-1",
      cost: 0.5,
    };
  },
  async fetch() {
    return { bytes: PNG_1PX, mimeType: "image/png", filename: "gen-0.png" };
  },
  async testConnection() {
    return { ok: true, message: null };
  },
};

function fakeApp(pool: DbPool, permissions: ReadonlySet<string>): ApplicationServices {
  return {
    pool,
    mediaCandidateSigningKey: SIGNING_KEY,
    authorize(_actor: { id: string }, permission: string): void {
      if (!permissions.has(permission)) {
        throw Object.assign(new Error("denied"), { code: "AUTH_PERMISSION_DENIED" });
      }
    },
    mediaProviders: {
      async list() {
        return [];
      },
      async get(providerId: string) {
        return providerId === "teststock" || providerId === "testgen"
          ? {
              provider_id: providerId,
              extension_id: `com.test.${providerId}`,
              kind: providerId === "teststock" ? "stock" : "generation",
              display_name: providerId,
              configured: true,
            }
          : null;
      },
      async stock(providerId: string) {
        return providerId === "teststock" ? stockProvider : null;
      },
      async generation(providerId: string) {
        return providerId === "testgen" ? generationProvider : null;
      },
      async stockProviders() {
        return [stockProvider];
      },
      async generationProviders() {
        return [generationProvider];
      },
    },
    mediaStorage: new InMemoryMediaStorage(),
    mediaQuarantine: new InMemoryMediaStorage(),
    mediaLimits: undefined,
    mediaPresets: { listPresets: () => [] },
    jobs: {
      async enqueue(_input: { idempotencyKey: string }) {},
    },
  } as unknown as ApplicationServices;
}

const ctx: OperationContext = {
  actor: {
    type: "SERVICE_ACCOUNT",
    id: "agent-1",
    permissions: new Set<string>(),
    siteKey: null,
    environment: null,
    strength: { factors: ["access_token"], authenticatedAt: new Date(), mfaAt: null },
    sessionId: null,
  },
  transport: "rest",
  requestId: "req-1",
};

async function setup(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

async function integration(t: { after: (fn: () => void) => void }) {
  if (!testDatabaseConfigured()) return null;
  return setup(t);
}

test("stock search enforces media.stock.search and never leaks download URLs", async (t) => {
  const pool = await integration(t);
  if (pool === null) return;
  const app = fakeApp(pool, new Set<string>());
  await assert.rejects(
    () => searchStockMediaOp(app, ctx, { query: "steel" }),
    (error: unknown) => (error as { code?: string }).code === "AUTH_PERMISSION_DENIED",
  );
  const allowed = fakeApp(pool, new Set<string>(["media.stock.search"]));
  const result = (await searchStockMediaOp(allowed, ctx, { query: "steel" })) as {
    items: { candidate_ref: string; provider_asset_id: string }[];
  };
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.provider_asset_id, "asset-1");
  // The wire shape must not carry the trusted download URL...
  assert.equal(JSON.stringify(result).includes("full.jpg"), false);
  // ...even though it rides inside the signed (tamper-proof) token.
  assert.equal(result.items[0]?.candidate_ref.includes("."), true);
});

test("candidate tokens: tamper and expiry rejected with typed errors", () => {
  const token = signStockCandidate(
    {
      providerId: "teststock",
      providerAssetId: "a",
      previewUrl: null,
      downloadUrl: null,
      width: null,
      height: null,
      creatorName: null,
      creatorUrl: null,
      sourceUrl: null,
      licenseName: null,
      licenseUrl: null,
    },
    SIGNING_KEY,
  );
  assert.equal(verifyStockCandidate(token, SIGNING_KEY).providerAssetId, "a");
  assert.throws(
    () => verifyStockCandidate(`${token}x`, SIGNING_KEY),
    (error: unknown) => (error as { code?: string }).code === "MEDIA_CANDIDATE_INVALID",
  );
  assert.throws(
    () => verifyStockCandidate(token, "another-key"),
    (error: unknown) => (error as { code?: string }).code === "MEDIA_CANDIDATE_INVALID",
  );
  const expired = signStockCandidate(
    {
      providerId: "teststock",
      providerAssetId: "a",
      previewUrl: null,
      downloadUrl: null,
      width: null,
      height: null,
      creatorName: null,
      creatorUrl: null,
      sourceUrl: null,
      licenseName: null,
      licenseUrl: null,
    },
    SIGNING_KEY,
    Date.now() - 25 * 60 * 60 * 1000,
  );
  assert.throws(
    () => verifyStockCandidate(expired, SIGNING_KEY),
    (error: unknown) => (error as { code?: string }).code === "MEDIA_CANDIDATE_EXPIRED",
  );
});

test("stock import: pipeline ingest, provenance, duplicate-safe re-import", async (t) => {
  const pool = await integration(t);
  if (pool === null) return;
  const app = fakeApp(pool, new Set<string>(["media.stock.import"]));
  const token = signStockCandidate(await stockTokenCandidate(), SIGNING_KEY);
  const first = (await importStockCandidateOp(app, ctx, { candidate_ref: token })) as {
    media_id: string;
    duplicate: boolean;
  };
  assert.equal(first.duplicate, false);
  const row = await pool.query<{
    origin: string;
    provider_id: string;
    provider_asset_id: string;
    provenance: Record<string, unknown>;
    source_name: string | null;
    license: string | null;
  }>(
    `SELECT origin, provider_id, provider_asset_id, provenance, source_name, license
     FROM media_assets WHERE id = $1`,
    [first.media_id],
  );
  assert.equal(row.rows[0]?.origin, "stock");
  assert.equal(row.rows[0]?.provider_id, "teststock");
  assert.equal(row.rows[0]?.provider_asset_id, "asset-1");
  assert.equal(row.rows[0]?.source_name, "Test Creator");
  assert.equal(row.rows[0]?.license, "Test License");
  const provenance = row.rows[0]?.provenance as Record<string, unknown> | undefined;
  assert.equal(provenance === undefined ? undefined : provenance.creator_name, "Test Creator");
  // Re-import is idempotent: the existing asset comes back, no new row.
  const second = (await importStockCandidateOp(app, ctx, { candidate_ref: token })) as {
    media_id: string;
    duplicate: boolean;
  };
  assert.equal(second.duplicate, true);
  assert.equal(second.media_id, first.media_id);
  const count = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM media_assets WHERE provider_asset_id = 'asset-1'`,
  );
  assert.equal(count.rows[0]?.n, "1");
});

async function stockTokenCandidate() {
  const result = await stockProvider.search(
    { requestId: "seed" },
    {
      query: "seed",
      limit: 1,
      cursor: null,
      orientation: null,
      minWidth: null,
      minHeight: null,
    },
  );
  return result.candidates[0] as Awaited<
    Parameters<typeof import("@pcms/media").signStockCandidate>[0]
  >;
}

test("generation: create→ready→accept; replay returns the original asset", async (t) => {
  const pool = await integration(t);
  if (pool === null) return;
  const app = fakeApp(pool, new Set<string>(["media.generate"]));
  await assert.rejects(
    () => createMediaGenerationOp(fakeApp(pool, new Set<string>()), ctx, { prompt: "x" }),
    (error: unknown) => (error as { code?: string }).code === "AUTH_PERMISSION_DENIED",
  );
  const created = (await createMediaGenerationOp(app, ctx, { prompt: "steel plant" })) as {
    generation_id: string;
    status: string;
  };
  assert.equal(created.status, "pending");
  // Simulate the worker: mark ready with a candidate.
  const run = await (async () => {
    const { requireGenerationRun } = await import("@pcms/media");
    return requireGenerationRun(pool, created.generation_id);
  })();
  await markGenerationRunRunning(pool, run.id);
  await markGenerationRunReady(
    pool,
    run.id,
    [
      {
        index: 0,
        previewUrl: "https://gen.example.test/0.png",
        downloadUrl: "https://gen.example.test/0.png",
        width: 1024,
        height: 1024,
        mimeType: "image/png",
        model: "m1",
        providerRequestId: "req-1",
        seed: 42,
        cost: 0.5,
      },
    ],
    { providerRequestId: "task-1", cost: 0.5, model: "m1" },
  );
  const accepted = (await acceptGeneratedMediaOp(app, ctx, {
    generation_id: created.generation_id,
    candidate_index: 0,
  })) as { media_id: string; duplicate: boolean };
  assert.equal(accepted.duplicate, false);
  const row = await pool.query<{ origin: string; provenance: Record<string, unknown> }>(
    `SELECT origin, provenance FROM media_assets WHERE id = $1`,
    [accepted.media_id],
  );
  assert.equal(row.rows[0]?.origin, "generated");
  const genProvenance = row.rows[0]?.provenance as Record<string, unknown> | undefined;
  assert.equal(genProvenance === undefined ? undefined : genProvenance.prompt, "steel plant");
  assert.equal(genProvenance === undefined ? undefined : genProvenance.seed, 42);
  // Replay: the same accept returns the same asset without a new ingest.
  const replay = (await acceptGeneratedMediaOp(app, ctx, {
    generation_id: created.generation_id,
    candidate_index: 0,
  })) as { media_id: string; duplicate: boolean };
  assert.equal(replay.duplicate, true);
  assert.equal(replay.media_id, accepted.media_id);
  void fixedClock;
  void createGenerationRun;
});
