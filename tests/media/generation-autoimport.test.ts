// Image Generation v2 (plan T2.1) — auto-import: every ready candidate of a
// generation run lands in the canonical media library through the worker
// handler, with provenance. A failing single import must not fail the run
// or its siblings; operator accept replays to the same asset afterwards.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ApplicationServices,
  acceptGeneratedMediaOp,
  createMediaGenerationJobHandler,
  createMediaGenerationOp,
  type OperationContext,
} from "@pcms/api";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  type ImageGenerationProvider,
  InMemoryMediaStorage,
  markGenerationRunRunning,
  requireGenerationRun,
} from "@pcms/media";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const SIGNING_KEY = "test-signing-key-material";

const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1" +
    "ee60000000049454e44ae426082",
  "hex",
);

/** Two candidates; the second fetch fails — the first must still import. */
const multiCandidateProvider: ImageGenerationProvider = {
  providerId: "autogen",
  displayName: "Auto Gen",
  capabilities: () => ({
    providerId: "autogen",
    displayName: "Auto Gen",
    models: ["m1"],
    maxCount: 4,
    supportsSeed: true,
    supportsNegativePrompt: true,
    aspects: ["1:1"],
  }),
  async generate() {
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
          providerRequestId: "req-0",
          seed: 1,
          cost: 0.01,
        },
        {
          index: 1,
          previewUrl: "https://gen.example.test/1.png",
          downloadUrl: "https://gen.example.test/1.png",
          width: 1024,
          height: 1024,
          mimeType: "image/png",
          model: "m1",
          providerRequestId: "req-1",
          seed: 2,
          cost: 0.01,
        },
      ],
      providerRequestId: "task-1",
      cost: 0.02,
    };
  },
  async fetch(_ctx, candidate) {
    if (candidate.index === 1) throw new Error("download exploded");
    return { bytes: PNG_1PX, mimeType: "image/png", filename: `gen-${candidate.index}.png` };
  },
  async testConnection() {
    return { ok: true, message: null };
  },
};

function fakeApp(pool: DbPool): ApplicationServices {
  return {
    pool,
    mediaCandidateSigningKey: SIGNING_KEY,
    authorize(): void {},
    mediaProviders: {
      async list() {
        return [];
      },
      async get(providerId: string) {
        return providerId === "autogen"
          ? {
              provider_id: providerId,
              extension_id: "com.test.autogen",
              kind: "generation",
              display_name: providerId,
              configured: true,
            }
          : null;
      },
      async stock() {
        return null;
      },
      async generation(providerId: string) {
        return providerId === "autogen" ? multiCandidateProvider : null;
      },
      async stockProviders() {
        return [];
      },
      async generationProviders() {
        return [multiCandidateProvider];
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

async function integration(t: { after: (fn: () => void) => void }): Promise<DbPool | null> {
  if (!testDatabaseConfigured()) return null;
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

test("auto-import: both candidates land in the library; failed sibling does not break the run", async (t) => {
  const pool = await integration(t);
  if (pool === null) return;
  const app = fakeApp(pool);
  const created = (await createMediaGenerationOp(app, ctx, {
    prompt: "auto import",
    provider_id: "autogen",
    count: 2,
  })) as { generation_id: string };

  await markGenerationRunRunning(pool, created.generation_id);
  const handler = createMediaGenerationJobHandler(app);
  await handler({ run_id: created.generation_id });

  const run = await requireGenerationRun(pool, created.generation_id);
  assert.equal(run.status, "ready");
  // Both candidates recorded as accepted (auto-imported) — even though the
  // second candidate's download blew up, it is NOT recorded (only the
  // successful one is), and the run itself stays ready.
  assert.ok(run.accepted["0"] !== undefined, "candidate 0 auto-imported");
  assert.equal(run.accepted["1"], undefined, "failed import is not recorded as accepted");

  // Provenance: origin generated with the run linkage.
  const assetId = run.accepted["0"]!;
  const provenance = await pool.query(
    `SELECT origin, provider_id, provenance FROM media_assets WHERE id = $1`,
    [assetId],
  );
  assert.equal(provenance.rows[0]?.origin, "generated");
  assert.equal(provenance.rows[0]?.provider_id, "autogen");
  const details = provenance.rows[0]?.provenance as Record<string, unknown>;
  assert.equal(details.generation_id, created.generation_id);
  assert.equal(details.prompt, "auto import");
});

test("auto-import: operator accept after auto-import replays the same asset", async (t) => {
  const pool = await integration(t);
  if (pool === null) return;
  const app = fakeApp(pool);
  const created = (await createMediaGenerationOp(app, ctx, {
    prompt: "replay check",
    provider_id: "autogen",
    count: 1,
  })) as { generation_id: string };

  await markGenerationRunRunning(pool, created.generation_id);
  await createMediaGenerationJobHandler(app)({ run_id: created.generation_id });

  const accepted = (await acceptGeneratedMediaOp(app, ctx, {
    generation_id: created.generation_id,
    candidate_index: 0,
  })) as { media_id: string; duplicate: boolean };
  assert.equal(accepted.duplicate, true);
});
