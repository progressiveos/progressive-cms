// Media acquisition model (PCMS-MPA-T009/T010/T011; ADR-0013, Media spec
// §71.3–§71.7): signed stock candidate tokens, asset provenance and the
// generation-run store. Candidate tokens are stateless and server-signed —
// the client never authors candidate metadata, and a re-used/expired/tampered
// token fails with a typed error. Generated candidates live only in the
// server-owned run row.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DbPool } from "@pcms/core";
import { MediaError } from "./errors.js";
import type { GeneratedCandidate, StockCandidate } from "./providers.js";

export class CandidateTokenError extends MediaError {
  constructor(code: "MEDIA_CANDIDATE_INVALID" | "MEDIA_CANDIDATE_EXPIRED", message: string) {
    super(code, message);
    this.name = "CandidateTokenError";
  }
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

interface StockCandidatePayload {
  readonly candidate: StockCandidate;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Issues an opaque, TTL-bounded, provider-bound stock candidate reference. */
export function signStockCandidate(
  candidate: StockCandidate,
  key: string,
  now = Date.now(),
): string {
  const payload: StockCandidatePayload = {
    candidate,
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, key)}`;
}

/** Verifies a candidate reference: tamper ⇒ invalid, old ⇒ expired (typed). */
export function verifyStockCandidate(token: string, key: string, now = Date.now()): StockCandidate {
  const dot = token.lastIndexOf(".");
  const body = dot === -1 ? "" : token.slice(0, dot);
  const signature = dot === -1 ? "" : token.slice(dot + 1);
  let payload: StockCandidatePayload;
  try {
    const expected = Buffer.from(sign(body, key));
    const provided = Buffer.from(signature);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new Error("signature mismatch");
    }
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StockCandidatePayload;
  } catch {
    throw new CandidateTokenError(
      "MEDIA_CANDIDATE_INVALID",
      "stock candidate reference is not valid",
    );
  }
  if (typeof payload.expiresAt !== "number" || payload.expiresAt < now) {
    throw new CandidateTokenError(
      "MEDIA_CANDIDATE_EXPIRED",
      "stock candidate reference has expired — search again",
    );
  }
  const candidate = payload.candidate;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.providerId !== "string" ||
    typeof candidate.providerAssetId !== "string"
  ) {
    throw new CandidateTokenError(
      "MEDIA_CANDIDATE_INVALID",
      "stock candidate reference is not valid",
    );
  }
  return candidate;
}

// ---- provenance ----

export interface AssetProvenance {
  readonly origin: "upload" | "import" | "stock" | "generated";
  readonly providerId: string | null;
  readonly providerAssetId: string | null;
  readonly provenance: Record<string, unknown> | null;
}

export async function setAssetProvenance(
  pool: DbPool,
  mediaId: string,
  provenance: AssetProvenance,
): Promise<void> {
  await pool.query(
    `UPDATE media_assets
     SET origin = $2, provider_id = $3, provider_asset_id = $4, provenance = $5
     WHERE id = $1`,
    [
      mediaId,
      provenance.origin,
      provenance.providerId,
      provenance.providerAssetId,
      provenance.provenance === null ? null : JSON.stringify(provenance.provenance),
    ],
  );
}

/** Duplicate-safe re-import: the same provider asset already in the library. */
export async function findAssetIdByProviderAsset(
  pool: DbPool,
  providerId: string,
  providerAssetId: string,
): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM media_assets WHERE provider_id = $1 AND provider_asset_id = $2
     ORDER BY created_at, id LIMIT 1`,
    [providerId, providerAssetId],
  );
  return result.rows[0]?.id ?? null;
}

// ---- generation runs ----

export type GenerationRunStatus = "pending" | "running" | "ready" | "failed";

export interface GenerationRunRecord {
  readonly id: string;
  readonly providerId: string;
  readonly extensionId: string;
  readonly model: string | null;
  readonly prompt: string;
  readonly negativePrompt: string | null;
  readonly settings: Record<string, unknown>;
  readonly status: GenerationRunStatus;
  readonly candidates: readonly GeneratedCandidate[];
  readonly providerRequestId: string | null;
  readonly cost: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** candidate index → accepted MediaAsset id (replay-safe accept). */
  readonly accepted: Record<string, string>;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

function rowToRun(row: Record<string, unknown>): GenerationRunRecord {
  return {
    id: String(row["id"]),
    providerId: String(row["provider_id"]),
    extensionId: String(row["extension_id"]),
    model: (row["model"] as string | null) ?? null,
    prompt: String(row["prompt"]),
    negativePrompt: (row["negative_prompt"] as string | null) ?? null,
    settings: (row["settings"] as Record<string, unknown>) ?? {},
    status: row["status"] as GenerationRunStatus,
    candidates: (row["candidates"] as GeneratedCandidate[]) ?? [],
    providerRequestId: (row["provider_request_id"] as string | null) ?? null,
    cost: row["cost"] === null || row["cost"] === undefined ? null : Number(row["cost"]),
    errorCode: (row["error_code"] as string | null) ?? null,
    errorMessage: (row["error_message"] as string | null) ?? null,
    accepted: (row["accepted"] as Record<string, string>) ?? {},
    createdBy: String(row["created_by"]),
    createdAt: row["created_at"] as Date,
    completedAt: (row["completed_at"] as Date | null) ?? null,
  };
}

export interface NewGenerationRun {
  readonly providerId: string;
  readonly extensionId: string;
  readonly prompt: string;
  readonly negativePrompt: string | null;
  readonly settings: Record<string, unknown>;
  readonly model: string | null;
  readonly createdBy: string;
}

export async function createGenerationRun(
  pool: DbPool,
  input: NewGenerationRun,
): Promise<GenerationRunRecord> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO media_generation_runs
       (id, provider_id, extension_id, model, prompt, negative_prompt, settings, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
    [
      id,
      input.providerId,
      input.extensionId,
      input.model,
      input.prompt,
      input.negativePrompt,
      JSON.stringify(input.settings),
      input.createdBy,
    ],
  );
  return requireGenerationRun(pool, id);
}

export async function requireGenerationRun(pool: DbPool, id: string): Promise<GenerationRunRecord> {
  const result = await pool.query(`SELECT * FROM media_generation_runs WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new MediaError("MEDIA_GENERATION_UNKNOWN", `generation run "${id}" does not exist`);
  }
  return rowToRun(row);
}

export async function markGenerationRunRunning(pool: DbPool, id: string): Promise<void> {
  await pool.query(
    `UPDATE media_generation_runs SET status = 'running' WHERE id = $1 AND status = 'pending'`,
    [id],
  );
}

export async function markGenerationRunReady(
  pool: DbPool,
  id: string,
  candidates: readonly GeneratedCandidate[],
  meta: {
    readonly providerRequestId: string | null;
    readonly cost: number | null;
    readonly model: string | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE media_generation_runs
     SET status = 'ready', candidates = $2, provider_request_id = $3, cost = $4,
         model = COALESCE($5, model), completed_at = now()
     WHERE id = $1`,
    [id, JSON.stringify(candidates), meta.providerRequestId, meta.cost, meta.model],
  );
}

export async function markGenerationRunFailed(
  pool: DbPool,
  id: string,
  code: string,
  message: string,
): Promise<void> {
  await pool.query(
    `UPDATE media_generation_runs
     SET status = 'failed', error_code = $2, error_message = $3, completed_at = now()
     WHERE id = $1`,
    [id, code, message.slice(0, 500)],
  );
}

/** Records an accept; idempotent — re-accept returns the original asset id. */
export async function recordCandidateAccept(
  pool: DbPool,
  runId: string,
  candidateIndex: number,
  mediaId: string,
): Promise<string | null> {
  const run = await requireGenerationRun(pool, runId);
  const existing = run.accepted[String(candidateIndex)];
  if (existing !== undefined) return existing;
  const merged = { ...run.accepted, [String(candidateIndex)]: mediaId };
  await pool.query(`UPDATE media_generation_runs SET accepted = $2 WHERE id = $1`, [
    runId,
    JSON.stringify(merged),
  ]);
  return null;
}

/** TTL sweep: unaccepted runs (and their candidates) expire together. */
export async function deleteExpiredGenerationRuns(pool: DbPool, olderThan: Date): Promise<number> {
  const result = await pool.query(
    `DELETE FROM media_generation_runs
     WHERE created_at < $1
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_object_keys(accepted) key
       ) IS NOT TRUE
       AND accepted = '{}'::jsonb`,
    [olderThan],
  );
  return result.rowCount ?? 0;
}
