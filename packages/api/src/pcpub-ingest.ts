// .pcpub secure ingest (PCMS-PCPUB E5/E6; ADR-0014 §5–§8, Publication spec
// §83). One path from physical artifact to the CANONICAL Publication Bundle
// application operation — never a second importer:
//
//   receive (quarantine + ledger + enqueue)      ← REST transport
//   validating_archive → validating_documents    ← shared publication/pcpub code
//   staging_media                                ← canonical media pipeline
//   resolving_refs → creating_candidates         ← pcpub → BundleInput mapping
//   validating_candidates → creating_changeset   ← canonical submitBundle
//   applying_intent → complete
//
// Strict acceptance: any technical/semantic failure leaves ZERO domain
// mutation. CAS: update documents carry target_entry_id + base_revision_id
// and the base is checked BEFORE the canonical apply — a stale base ends the
// ingest with outcome "conflict" and the public pointer untouched.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recordSecurityEvent } from "@pcms/auth";
import type { DbPool, StableId } from "@pcms/core";
import { type AcceptedMedia, getAsset, type IngestLimits, uploadMedia } from "@pcms/media";
import {
  DEFAULT_PCPUB_LIMITS,
  type PcpubDiagnostic,
  PcpubError,
  type PcpubLimits,
  pcmdPayload,
  sha256Hex,
  type VerifiedBundle,
  validatePcpub,
  verifyPcpub,
} from "@pcms/publication";
import { parseSeoDocument } from "@pcms/seo";
import { type BundleEntryInput, type BundleInput, submitBundle } from "./bundle.js";
import { type ApplicationServices, type OperationContext, requirePermission } from "./context.js";
import { ApiError } from "./errors.js";
import { requireQuarantine, requireStorage } from "./http/routes/helpers.js";
import { generateVariantsAfterAccept } from "./operations.js";
import {
  createPcpubTargetContracts,
  pcpubRichTextBridge,
  richTextPropsResolver,
} from "./pcpub-contracts.js";
import { resolveExternalEntries, rewriteExternalEntryRefs } from "./pcpub-external-entries.js";

export const PCPUB_INGEST_JOB_TYPE = "publication_bundle.ingest";

export type PcpubIngestStage =
  | "received"
  | "validating_archive"
  | "validating_documents"
  | "staging_media"
  | "resolving_refs"
  | "creating_candidates"
  | "validating_candidates"
  | "creating_changeset"
  | "applying_intent"
  | "complete";

export type PcpubIngestOutcome = "sealed" | "published" | "conflict" | "rejected" | "failed";

export interface PcpubIngestRow {
  readonly id: string;
  readonly bundle_id: string;
  readonly principal_type: string;
  readonly principal_id: string;
  readonly pcpub_version: number;
  readonly pcmd_version: number;
  readonly payload_digest: string;
  readonly archive_sha256: string;
  readonly stage: PcpubIngestStage;
  readonly outcome: PcpubIngestOutcome | null;
  readonly changeset_id: string | null;
  readonly result: Record<string, unknown> | null;
  readonly error_code: string | null;
  readonly safe_error_detail: Record<string, unknown> | null;
  readonly received_at: string;
  readonly completed_at: string | null;
}

interface LedgerMeta {
  readonly manifest_json: unknown;
  readonly quarantine_path: string | null;
  readonly principal_permissions: unknown;
}

export function pcpubLimitsFrom(app: ApplicationServices): PcpubLimits {
  return app.pcpubBundleLimits ?? DEFAULT_PCPUB_LIMITS;
}

// The media package keeps its ingest defaults internal (only the type is
// exported); these mirror DEFAULT_INGEST_LIMITS as the base for pcpub
// staging limits (packages/media/src/ingest.ts).
const MEDIA_DEFAULT_INGEST_LIMITS: IngestLimits = {
  maxUploadBytes: 26_214_400, // 25 MiB
  maxVideoUploadBytes: 268_435_456, // 256 MiB
  maxAudioUploadBytes: 268_435_456, // 256 MiB
  maxImagePixels: 64_000_000, // 64 MP
  maxImageDimension: 16_384,
};

function safeDetail(cause: unknown): Record<string, unknown> {
  if (cause instanceof PcpubError) {
    return {
      diagnostics:
        cause.diagnostics.length > 0
          ? cause.diagnostics
          : [{ code: cause.code, path: cause.path, message: cause.message }],
    };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { message: message.slice(0, 500) };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const ROW_COLUMNS = `id, bundle_id, principal_type, principal_id, pcpub_version,
  pcmd_version, payload_digest, archive_sha256, stage, outcome, changeset_id,
  result, manifest_json, error_code, safe_error_detail, received_at,
  completed_at, quarantine_path, principal_permissions`;

function rowOf(raw: Record<string, unknown>): PcpubIngestRow & LedgerMeta {
  return raw as unknown as PcpubIngestRow & LedgerMeta;
}

async function findIngest(
  pool: DbPool,
  principalType: string,
  principalId: string,
  bundleId: string,
): Promise<(PcpubIngestRow & LedgerMeta) | null> {
  const result = await pool.query(
    `SELECT ${ROW_COLUMNS} FROM publication_bundle_ingest
     WHERE principal_type = $1 AND principal_id = $2 AND bundle_id = $3`,
    [principalType, principalId, bundleId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row === undefined ? null : rowOf(row);
}

async function findIngestById(
  pool: DbPool,
  ingestId: string,
): Promise<(PcpubIngestRow & LedgerMeta) | null> {
  const result = await pool.query(
    `SELECT ${ROW_COLUMNS} FROM publication_bundle_ingest WHERE id = $1`,
    [ingestId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row === undefined ? null : rowOf(row);
}

async function advanceStage(
  pool: DbPool,
  ingestId: string,
  stage: PcpubIngestStage,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE publication_bundle_ingest
     SET stage = $2, started_at = COALESCE(started_at, now())
     WHERE id = $1 AND outcome IS NULL`,
    [ingestId, stage],
  );
  return result.rowCount === 1;
}

async function completeIngest(
  pool: DbPool,
  ingestId: string,
  patch: {
    outcome: PcpubIngestOutcome;
    changesetId?: string | null;
    result?: Record<string, unknown> | null;
    errorCode?: string | null;
    safeErrorDetail?: Record<string, unknown> | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE publication_bundle_ingest
     SET stage = 'complete', outcome = $2, changeset_id = $3, result = $4,
         error_code = $5, safe_error_detail = $6, completed_at = now()
     WHERE id = $1`,
    [
      ingestId,
      patch.outcome,
      patch.changesetId ?? null,
      patch.result === undefined ? null : JSON.stringify(patch.result),
      patch.errorCode ?? null,
      patch.safeErrorDetail === undefined ? null : JSON.stringify(patch.safeErrorDetail),
    ],
  );
}

/** Quarantine file with 0700 dir + 0600 file, bounded at write time. */
async function quarantineWrite(app: ApplicationServices, bytes: Buffer): Promise<string> {
  const dir = app.pcpubQuarantineDir ?? join(tmpdir(), "pcms-pcpub-quarantine");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const quarantine = await mkdtemp(join(dir, "pcpub-"));
  await writeFile(join(quarantine, "bundle.pcpub"), bytes, { mode: 0o600 });
  return join(quarantine, "bundle.pcpub");
}

// ---------------------------------------------------------------------------
// Receive (REST entry point)
// ---------------------------------------------------------------------------

export interface PcpubValidateReport {
  readonly mode: "validate";
  readonly accepted: boolean;
  readonly bundle_id: string | null;
  readonly issues: readonly PcpubDiagnostic[];
}

export interface PcpubReceived {
  readonly mode: "apply";
  readonly bundle_id: string;
  readonly ingest_id: string;
  readonly stage: PcpubIngestStage;
  readonly status_url: string;
  readonly replayed: boolean;
}

/** Validate-only: full structural+semantic report, ZERO writes, no ledger. */
export async function validatePcpubBytes(
  app: ApplicationServices,
  bytes: Buffer,
  ctx?: OperationContext,
): Promise<PcpubValidateReport> {
  const limits = pcpubLimitsFrom(app);
  if (bytes.length > limits.maxCompressedBytes) {
    return {
      mode: "validate",
      accepted: false,
      bundle_id: null,
      issues: [
        {
          code: "PCPUB_ARCHIVE_TOO_LARGE",
          path: "",
          message: "bundle exceeds the compressed size limit",
        },
      ],
    };
  }
  const dir = await mkdtemp(join(tmpdir(), "pcms-pcpub-validate-"));
  const path = join(dir, "bundle.pcpub");
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    const verified = await verifyPcpub(path, { limits });
    try {
      const issues = [
        ...(await validatePcpub(path, {
          limits,
          contracts: createPcpubTargetContracts(app.contentTypes, app.blocks),
          richTextBridge: pcpubRichTextBridge,
          richTextPropsFor: richTextPropsResolver(app.blocks),
        })),
      ];
      for (const item of verified.documents) {
        if (item.document.seo === undefined || item.document.seo === null) continue;
        const seo = structuredClone(item.document.seo) as Record<string, unknown>;
        const socialImage = seo.social_image;
        if (
          socialImage !== null &&
          typeof socialImage === "object" &&
          !Array.isArray(socialImage)
        ) {
          const image = socialImage as Record<string, unknown>;
          if (typeof image.asset_id === "string" && image.asset_id.startsWith("bundle:"))
            image.asset_id = "01900000-0000-7000-8000-000000000001";
        }
        try {
          parseSeoDocument(seo);
        } catch (error) {
          const rawIssues = (error as { details?: { issues?: unknown } } | null)?.details?.issues;
          const diagnostics = Array.isArray(rawIssues)
            ? rawIssues.map((raw) => {
                const issue = raw as { code?: unknown; path?: unknown; message?: unknown };
                return {
                  code: "PCPUB_DOCUMENT_INVALID" as const,
                  path: `${item.path}/seo${typeof issue.path === "string" ? issue.path : ""}`,
                  message:
                    typeof issue.message === "string" ? issue.message : "invalid SEO document",
                };
              })
            : [
                {
                  code: "PCPUB_DOCUMENT_INVALID" as const,
                  path: `${item.path}/seo`,
                  message: "invalid SEO document",
                },
              ];
          issues.push(...diagnostics);
        }
      }
      if (verified.manifest.external_entries !== undefined) {
        if (ctx === undefined || !ctx.actor.permissions.has("content.read"))
          throw new PcpubError(
            "PCPUB_AUTH_INSUFFICIENT_SCOPE",
            "content.read required for external_entries",
          );
        await resolveExternalEntries(app, verified.manifest.external_entries);
      }
      return { mode: "validate", accepted: issues.length === 0, bundle_id: null, issues };
    } finally {
      await verified.archive.close();
    }
  } catch (cause) {
    if (cause instanceof PcpubError) {
      return {
        mode: "validate",
        accepted: false,
        bundle_id: null,
        issues:
          cause.diagnostics.length > 0
            ? cause.diagnostics
            : [{ code: cause.code, path: cause.path, message: cause.message }],
      };
    }
    throw cause;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Receives an apply ingest: quarantine, ledger identity, enqueue. Replays
 * return the stored result (no duplicate domain state); same bundle_id with
 * a different payload is a typed 409.
 */
export async function receivePcpub(
  app: ApplicationServices,
  ctx: OperationContext,
  bytes: Buffer,
): Promise<PcpubReceived> {
  // The route spec declares "content.create"; enforce it inside the op too
  // (fail-secure: no quarantine/ledger writes without it). The worker path
  // (processPcpubIngest) is a server context and never calls this.
  requirePermission(app, ctx, "content.create");
  const limits = pcpubLimitsFrom(app);
  if (bytes.length === 0) {
    throw new ApiError("PCPUB_ARCHIVE_UNREADABLE", "empty request body", { status: 400 });
  }
  if (bytes.length > limits.maxCompressedBytes) {
    throw new ApiError("PCPUB_ARCHIVE_TOO_LARGE", "bundle exceeds the compressed size limit", {
      status: 413,
    });
  }
  const archiveSha256 = sha256Hex(bytes);
  const quarantinePath = await quarantineWrite(app, bytes);
  try {
    // Structural verification BEFORE the ledger row: garbage never occupies
    // an identity (and bundle_id comes from the manifest).
    const verified = await verifyPcpub(quarantinePath, { limits }).catch((cause: unknown) => {
      if (cause instanceof PcpubError) {
        throw new ApiError(cause.code, cause.message, {
          status: 422,
          ...(cause.diagnostics.length > 0 ? { details: cause.diagnostics } : {}),
        });
      }
      throw cause;
    });
    const manifest = verified.manifest;
    await verified.archive.close();
    if (manifest.external_entries !== undefined) requirePermission(app, ctx, "content.read");
    const digest = manifestDigest(manifest, archiveSha256);

    const existing = await findIngest(app.pool, ctx.actor.type, ctx.actor.id, manifest.bundle_id);
    if (existing !== null) {
      await rm(dirname(quarantinePath), { recursive: true, force: true });
      if (existing.payload_digest !== digest) {
        throw new ApiError(
          "PCPUB_IDEMPOTENCY_BUNDLE_ID_REUSED",
          "bundle_id was already used with a different payload",
          { status: 409 },
        );
      }
      return {
        mode: "apply",
        bundle_id: existing.bundle_id,
        ingest_id: existing.id,
        stage: existing.stage,
        status_url: `/api/v1/bundles/pcpub/ingests/${existing.id}`,
        replayed: true,
      };
    }

    const ingestId = randomUUID();
    const inserted = await app.pool.query(
      `INSERT INTO publication_bundle_ingest
        (id, bundle_id, principal_type, principal_id, pcpub_version, pcmd_version,
         payload_digest, archive_sha256, stage, manifest_json, quarantine_path,
         received_at, principal_permissions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received',$9,$10, now(), $11)
       ON CONFLICT (principal_type, principal_id, bundle_id) DO NOTHING`,
      [
        ingestId,
        manifest.bundle_id,
        ctx.actor.type,
        ctx.actor.id,
        manifest.pcpub_version,
        manifest.authoring.pcmd_version,
        digest,
        archiveSha256,
        JSON.stringify(manifest),
        quarantinePath,
        JSON.stringify([...ctx.actor.permissions]),
      ],
    );
    if (inserted.rowCount !== 1) {
      // Lost a race against a concurrent submit: treat as replay — but only
      // after the same digest check as the sequential path; a different
      // payload under the same bundle_id is the same typed 409.
      const winner = await findIngest(app.pool, ctx.actor.type, ctx.actor.id, manifest.bundle_id);
      await rm(dirname(quarantinePath), { recursive: true, force: true });
      if (winner === null || winner.payload_digest !== digest) {
        throw new ApiError(
          "PCPUB_IDEMPOTENCY_BUNDLE_ID_REUSED",
          "bundle_id was already used with a different payload",
          { status: 409 },
        );
      }
      return {
        mode: "apply",
        bundle_id: manifest.bundle_id,
        ingest_id: winner?.id ?? ingestId,
        stage: winner?.stage ?? "received",
        status_url: `/api/v1/bundles/pcpub/ingests/${winner?.id ?? ingestId}`,
        replayed: true,
      };
    }
    await app.jobs.enqueue({
      type: PCPUB_INGEST_JOB_TYPE,
      payload: { ingest_id: ingestId },
      idempotencyKey: `pcpub:${ingestId}`,
    });
    await recordSecurityEvent(app.pool, null, {
      type: "PCPUB_SUBMITTED",
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      transport: "api",
      subjectType: "publication_bundle_ingest",
      subjectId: ingestId,
      metadata: { bundle_id: manifest.bundle_id, mode: "apply" },
    });
    return {
      mode: "apply",
      bundle_id: manifest.bundle_id,
      ingest_id: ingestId,
      stage: "received",
      status_url: `/api/v1/bundles/pcpub/ingests/${ingestId}`,
      replayed: false,
    };
  } catch (cause) {
    // Nothing was accepted: the quarantine copy has no value.
    await rm(dirname(quarantinePath), { recursive: true, force: true }).catch(() => {});
    throw cause;
  }
}

function manifestDigest(manifest: VerifiedBundle["manifest"], archiveSha256: string): string {
  return sha256Hex(Buffer.from(`${JSON.stringify(manifest)}\n${archiveSha256}`, "utf8"));
}

// ---------------------------------------------------------------------------
// Worker pipeline
// ---------------------------------------------------------------------------

class StageFailure extends Error {
  constructor(
    readonly outcome: "rejected" | "failed" | "conflict",
    readonly errorCode: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(errorCode);
  }
}

/**
 * The durable ingest worker: resumes from the recorded stage, is idempotent
 * under retry, and enforces strict acceptance (no partial domain mutation —
 * the canonical apply is one transaction; media staging before it is
 * content-addressed and orphan-collected by the existing media GC).
 */
export async function processPcpubIngest(
  app: ApplicationServices,
  ingestId: string,
): Promise<void> {
  const pool = app.pool;
  const row = await findIngestById(pool, ingestId);
  if (row === null) throw new Error(`ingest ${ingestId} not found`);
  if (row.outcome !== null) return; // terminal already (idempotent replay)
  const limits = pcpubLimitsFrom(app);
  // The submit-time permission snapshot rides the ledger row: the ingest
  // pipeline authorizes the SAME scopes the authenticated submit presented
  // (server-owned snapshot; permission names only — never secrets).
  const permissions = new Set<string>(
    Array.isArray(row.principal_permissions) ? (row.principal_permissions as string[]) : [],
  );
  const ctx: OperationContext = {
    actor: {
      type: row.principal_type as OperationContext["actor"]["type"],
      id: row.principal_id,
      permissions,
      siteKey: null,
      environment: null,
      sessionId: null,
      strength: { factors: ["access_token"], authenticatedAt: new Date(), mfaAt: null },
    },
    transport: "rest",
    requestId: `pcpub:${ingestId}`,
  };

  try {
    if (row.quarantine_path === null)
      throw new StageFailure("failed", "PCPUB_INTERNAL_FAILURE", { message: "quarantine lost" });

    // --- validating_archive -------------------------------------------------
    await advanceStage(pool, ingestId, "validating_archive");
    const verified = await verifyPcpub(row.quarantine_path, { limits }).catch((cause: unknown) => {
      if (cause instanceof PcpubError) {
        throw new StageFailure("rejected", cause.code, safeDetail(cause));
      }
      throw cause;
    });
    const manifest = verified.manifest;
    const documents = verified.documents;
    try {
      // --- validating_documents ---------------------------------------------
      await advanceStage(pool, ingestId, "validating_documents");
      const issues = await validatePcpub(row.quarantine_path, {
        limits,
        contracts: createPcpubTargetContracts(app.contentTypes, app.blocks),
        richTextBridge: pcpubRichTextBridge,
        richTextPropsFor: richTextPropsResolver(app.blocks),
      });
      if (issues.length > 0) {
        throw new StageFailure("rejected", "PCPUB_DOCUMENT_INVALID", { diagnostics: issues });
      }

      const external = manifest.external_entries ?? {};
      const required = ["content.create"];
      if (manifest.external_entries !== undefined) required.push("content.read");
      if (documents.some((doc) => doc.document.operation === "update"))
        required.push("content.edit");
      if (manifest.assets.length > 0) required.push("media.write");
      if (documents.some((doc) => doc.document.seo !== undefined)) required.push("seo.edit");
      if (documents.some((doc) => doc.document.route !== undefined))
        required.push("publication.plan");
      if (manifest.intent.publication.mode === "now") required.push("publication.publish");
      for (const permission of required) {
        if (!ctx.actor.permissions.has(permission))
          throw new StageFailure("rejected", "PCPUB_AUTH_INSUFFICIENT_SCOPE", {
            diagnostics: [
              {
                code: "PCPUB_AUTH_INSUFFICIENT_SCOPE",
                path: "manifest.json",
                message: `${permission} required`,
              },
            ],
          });
      }
      const externalMapping = await resolveExternalEntries(app, external);
      for (const [alias, target] of Object.entries(externalMapping)) {
        if (documents.some((doc) => doc.document.targetEntryId === target.entry_id))
          throw new PcpubError(
            "PCPUB_EXTERNAL_ENTRY_INVALID",
            "external target cannot also be an updated bundle entry",
            { path: `external_entries/${alias}` },
          );
      }

      // --- staging_media ------------------------------------------------
      await advanceStage(pool, ingestId, "staging_media");
      // Bundle assets are already bounded per-asset by the pcpub limits
      // (maxAssetBytes, 64 MiB by default) — the media upload default
      // (25 MiB) would reject valid bundles. Raise the upload ceiling to
      // the pcpub asset bound; other ingest ceilings keep the media policy.
      const stagingLimits: IngestLimits = {
        ...(app.mediaLimits ?? MEDIA_DEFAULT_INGEST_LIMITS),
        maxUploadBytes: limits.maxAssetBytes,
        maxVideoUploadBytes: limits.maxAssetBytes,
        maxAudioUploadBytes: limits.maxAssetBytes,
      };
      const assetIdByPath = new Map<string, string>();
      const stagedMedia: { ref: string; media_id: string; duplicate_blob: boolean }[] = [];
      const mediaVariantFailures: { media_id: string; preset: string; error: string }[] = [];
      for (const [index, asset] of manifest.assets.entries()) {
        const mediaRef = `m${index}`;
        const assetBytes = await verified.archive.readBytes(asset.path);
        const accepted: AcceptedMedia = await uploadMedia(
          {
            pool: app.pool,
            storage: requireStorage(app),
            quarantine: requireQuarantine(app),
            limits: stagingLimits,
          },
          {
            bytes: assetBytes,
            filename: asset.path.slice(asset.path.lastIndexOf("/") + 1),
            declaredMimeType: asset.media_type,
            createdBy: `${row.principal_type}:${row.principal_id}`,
            // Server-side ingest IS the trusted path (Media spec §24): the
            // manifest-declared, sha256-pinned archive never carries
            // client-supplied raw bytes; SVG still passes validateSvg.
            privileged: true,
          },
        );
        assetIdByPath.set(asset.path, accepted.asset.id);
        stagedMedia.push({
          ref: mediaRef,
          media_id: accepted.asset.id,
          duplicate_blob: accepted.duplicateBlob,
        });
        // Theme-preset derivatives for bundle images, same as REST uploads —
        // without them every gallery/hero reference renders its placeholder.
        // Per-preset failures stay non-fatal but land in the ingest result:
        // an asset with missing declared derivatives must be visible as
        // incomplete, never silently presented as ready.
        const variantOutcome = await generateVariantsAfterAccept(app, accepted);
        mediaVariantFailures.push(...variantOutcome.failures);
        // Provenance from the manifest grants no trust — it is recorded
        // metadata for the existing provenance columns (Media spec §71.5).
        await pool.query(`UPDATE media_assets SET provenance = $2 WHERE id = $1`, [
          accepted.asset.id,
          JSON.stringify({
            source: "pcpub",
            bundle_id: manifest.bundle_id,
            path: asset.path,
            ...(asset.provenance ?? {}),
          }),
        ]);
      }

      // --- resolving_refs -------------------------------------------------
      await advanceStage(pool, ingestId, "resolving_refs");
      const pathToRef = new Map<string, string>();
      for (const [index, asset] of manifest.assets.entries()) {
        pathToRef.set(asset.path, `ref:m${index}`);
      }
      const entries: BundleEntryInput[] = [];
      const conflicting: PcpubDiagnostic[] = [];
      for (const doc of documents) {
        if (doc.document.operation === "update") {
          const cas = await checkCasBase(
            app,
            doc.document.targetEntryId as string,
            doc.document.baseRevisionId as string,
            doc.document.locale ?? "default",
          );
          if (cas !== null) {
            conflicting.push({ code: cas.code, path: doc.path, message: cas.message });
            continue;
          }
        }
        const payload = pcmdPayload(
          doc.document,
          doc.path,
          pcpubRichTextBridge,
          richTextPropsResolver(app.blocks),
        );
        const rewrittenPayload = rewriteBundleRefs(
          rewriteExternalEntryRefs(app, doc.document.contentType, payload, externalMapping),
          pathToRef,
        ) as { fields: Record<string, unknown>; blocks: unknown };
        entries.push({
          ref: doc.document.externalId,
          content_type: doc.document.contentType,
          payload: rewrittenPayload,
          ...(doc.document.locale === undefined ? {} : { locale: doc.document.locale }),
          ...(doc.document.seo === undefined
            ? {}
            : { seo: rewriteSeoBundleRef(doc.document.seo, pathToRef) }),
          ...(doc.document.route === undefined ? {} : { route: doc.document.route }),
          ...(doc.document.operation === "update"
            ? { entry_id: doc.document.targetEntryId as string }
            : {}),
        });
      }
      const canonicalBundle: BundleInput = {
        bundle_version: 1,
        external_id: manifest.bundle_id,
        changeset: { title: manifest.intent.changeset_title },
        entries,
        media: stagedMedia.map((item) => ({
          ref: item.ref,
          media_id: item.media_id,
        })),
        publication: { mode: manifest.intent.publication.mode },
      };
      if (conflicting.length > 0) {
        // Stale base: outcome conflict, public unchanged, no partial mutation.
        throw new StageFailure("conflict", "PCPUB_CONFLICT_STALE_BASE", {
          diagnostics: conflicting,
        });
      }

      // --- validating_candidates -----------------------------------------
      await advanceStage(pool, ingestId, "validating_candidates");
      const checks = {
        literalRefs: Object.keys(external),
        sourcePathForEntry: (entry: import("./bundle.js").BundleEntryInput) =>
          documents.find((doc) => doc.document.externalId === entry.ref)?.path,
        beforeCandidates: async (tx: import("@pcms/core").DbClient) => {
          await resolveExternalEntries(app, external, tx, externalMapping);
          for (const doc of documents) {
            if (doc.document.operation !== "update") continue;
            const current = await tx.query<{ current_revision_id: string }>(
              `SELECT current_revision_id FROM publications WHERE entity_type = 'entry' AND entity_id = $1 AND context = $2 FOR SHARE`,
              [doc.document.targetEntryId, doc.document.locale ?? "default"],
            );
            if (
              current.rows[0]?.current_revision_id != null &&
              current.rows[0].current_revision_id !== doc.document.baseRevisionId
            )
              throw new PcpubError(
                "PCPUB_CONFLICT_STALE_BASE",
                "base changed before candidate creation",
                { path: doc.path },
              );
          }
        },
      };
      const report = await submitBundle(app, ctx, canonicalBundle, "validate", checks);
      if (!("validation_report" in report) || report.validation_report.ok !== true) {
        const reportIssues =
          "validation_report" in report ? (report.validation_report.issues as unknown[]) : [];
        throw new StageFailure("rejected", "PCPUB_DOCUMENT_INVALID", { diagnostics: reportIssues });
      }

      // --- creating_changeset / applying_intent ----------------------------
      await advanceStage(pool, ingestId, "creating_changeset");
      await advanceStage(pool, ingestId, "applying_intent");
      const result = await submitBundle(app, ctx, canonicalBundle, "apply", checks);
      if (!("accepted" in result) || result.accepted !== true) {
        throw new StageFailure("failed", "PCPUB_INTERNAL_FAILURE", {
          message: "canonical apply rejected after successful validation",
        });
      }

      // --- complete -----------------------------------------------------
      await advanceStage(pool, ingestId, "complete");
      await completeIngest(pool, ingestId, {
        outcome: result.published ? "published" : "sealed",
        changesetId: result.changeset_id,
        result: {
          entries: result.entries,
          media: result.media,
          published: result.published,
          ...(mediaVariantFailures.length === 0
            ? {}
            : { media_variant_failures: mediaVariantFailures }),
          ...(manifest.external_entries === undefined
            ? {}
            : {
                external_entries: Object.fromEntries(
                  Object.entries(externalMapping).map(([alias, target]) => [
                    alias,
                    target.entry_id,
                  ]),
                ),
              }),
        },
      });
      await recordSecurityEvent(pool, null, {
        type: "PCPUB_OUTCOME",
        actorType: row.principal_type as OperationContext["actor"]["type"],
        actorId: row.principal_id,
        transport: "operator",
        subjectType: "publication_bundle_ingest",
        subjectId: ingestId,
        metadata: {
          bundle_id: manifest.bundle_id,
          outcome: result.published ? "published" : "sealed",
          entries: result.entries.length,
        },
      });
      // Successful ingest: manifest + digest + record retained, ZIP dropped.
      await rm(row.quarantine_path, { force: true }).catch(() => {});
    } finally {
      await verified.archive.close();
    }
  } catch (error) {
    const cause =
      error instanceof PcpubError
        ? new StageFailure(
            error.code.startsWith("PCPUB_CONFLICT_") ? "conflict" : "rejected",
            error.code,
            safeDetail(error),
          )
        : error instanceof ApiError && error.code === "BUNDLE_INVALID" && error.details.length > 0
          ? new StageFailure("rejected", "PCPUB_DOCUMENT_INVALID", {
              diagnostics: error.details,
            })
          : error;
    if (cause instanceof StageFailure) {
      await completeIngest(pool, ingestId, {
        outcome: cause.outcome,
        errorCode: cause.errorCode,
        safeErrorDetail: cause.detail,
      });
      await recordSecurityEvent(pool, null, {
        type: "PCPUB_OUTCOME",
        actorType: row.principal_type as OperationContext["actor"]["type"],
        actorId: row.principal_id,
        transport: "operator",
        subjectType: "publication_bundle_ingest",
        subjectId: ingestId,
        metadata: { bundle_id: row.bundle_id, outcome: cause.outcome, error_code: cause.errorCode },
      });
      return;
    }
    await completeIngest(pool, ingestId, {
      outcome: "failed",
      errorCode: "PCPUB_INTERNAL_FAILURE",
      safeErrorDetail: safeDetail(cause),
    });
    await recordSecurityEvent(pool, null, {
      type: "PCPUB_OUTCOME",
      actorType: row.principal_type as OperationContext["actor"]["type"],
      actorId: row.principal_id,
      transport: "operator",
      subjectType: "publication_bundle_ingest",
      subjectId: ingestId,
      metadata: {
        bundle_id: row.bundle_id,
        outcome: "failed",
        error_code: "PCPUB_INTERNAL_FAILURE",
      },
    });
  }
}

/** CAS: the base revision must exist, belong to the target, and be current. */
async function checkCasBase(
  app: ApplicationServices,
  targetEntryId: string,
  baseRevisionId: string,
  context: string,
): Promise<{ code: PcpubDiagnostic["code"]; message: string } | null> {
  const revision = await app.revisions.getRevision(app.pool, baseRevisionId as StableId);
  if (revision === null || revision.entityId !== targetEntryId) {
    return {
      code: "PCPUB_TARGET_BASE_REVISION_NOT_FOUND",
      message: `base revision ${baseRevisionId} does not exist on entry ${targetEntryId}`,
    };
  }
  const publication = await app.publications.getPublication(
    app.pool,
    "entry",
    targetEntryId as StableId,
    context,
  );
  if (
    publication !== null &&
    publication.currentRevisionId !== null &&
    publication.currentRevisionId !== baseRevisionId
  ) {
    return {
      code: "PCPUB_CONFLICT_STALE_BASE",
      message: "the entry moved past the bundled base revision",
    };
  }
  return null;
}

const BUNDLE_REF_PREFIX = "bundle:";

/** Rewrites bundle: asset refs to canonical ref:<mediaRef> form. Entry refs
 * pass through — the canonical bundle resolves them inside its transaction. */
function rewriteBundleRefs(value: unknown, pathToRef: Map<string, string>): unknown {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.startsWith(BUNDLE_REF_PREFIX)) {
        return pathToRef.get(value.slice(BUNDLE_REF_PREFIX.length)) ?? value;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        // Payload keys are untrusted: never let them redefine the object
        // (prototype pollution via "__proto__" and friends).
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        out[key] = walk(child);
      }
      return out;
    }
    return value;
  };
  return walk(value);
}

function rewriteSeoBundleRef(value: unknown, pathToRef: Map<string, string>): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const seo = { ...(value as Record<string, unknown>) };
  const image = seo.social_image;
  if (typeof image !== "object" || image === null || Array.isArray(image)) return seo;
  const socialImage = { ...(image as Record<string, unknown>) };
  const assetPath = socialImage.asset_id;
  if (typeof assetPath === "string" && assetPath.startsWith(BUNDLE_REF_PREFIX)) {
    socialImage.asset_id = pathToRef.get(assetPath.slice(BUNDLE_REF_PREFIX.length)) ?? assetPath;
  }
  seo.social_image = socialImage;
  return seo;
}

/** Recent ingests, newest first (theme developer report: a lost submit
 * stdout made the ingest id unrecoverable). Own ingests for actors without
 * publication.plan; everything for those who hold it. */
export async function listPcpubIngests(
  app: ApplicationServices,
  ctx: OperationContext,
  limit: number,
): Promise<Record<string, unknown>> {
  const canSeeAll = ctx.actor.permissions.has("publication.plan");
  const filter = canSeeAll ? "" : "WHERE principal_type = $2 AND principal_id = $3";
  const rows = await app.pool.query<{
    id: string;
    bundle_id: string;
    stage: string;
    outcome: string | null;
    changeset_id: string | null;
    received_at: string;
    manifest_json: { changeset_title?: string } | null;
  }>(
    `SELECT id, bundle_id, stage, outcome, changeset_id, received_at, manifest_json
     FROM publication_bundle_ingest ${filter}
     ORDER BY received_at DESC LIMIT $1`,
    canSeeAll ? [limit] : [limit, ctx.actor.type, ctx.actor.id],
  );
  return {
    ingests: rows.rows.map((row) => ({
      ingest_id: row.id,
      bundle_id: row.bundle_id,
      stage: row.stage,
      outcome: row.outcome,
      changeset_id: row.changeset_id,
      changeset_title: row.manifest_json?.changeset_title ?? null,
      received_at: row.received_at,
    })),
  };
}

/** Status read (owner or publication-visibility permission). */
export async function getPcpubIngestStatus(
  app: ApplicationServices,
  ctx: OperationContext,
  ingestId: string,
): Promise<Record<string, unknown>> {
  const row = await findIngestById(app.pool, ingestId);
  if (row === null) {
    throw new ApiError("PCPUB_TARGET_NOT_FOUND", `no ingest ${ingestId}`, { status: 404 });
  }
  const own = row.principal_type === ctx.actor.type && row.principal_id === ctx.actor.id;
  if (!own) {
    requirePermissionOrThrow(app, ctx);
  }
  return {
    ingest_id: row.id,
    bundle_id: row.bundle_id,
    stage: row.stage,
    outcome: row.outcome,
    changeset_id: row.changeset_id,
    result: row.result,
    error_code: row.error_code,
    safe_error_detail: row.safe_error_detail,
    received_at: row.received_at,
    completed_at: row.completed_at,
  };
}

function requirePermissionOrThrow(app: ApplicationServices, ctx: OperationContext): void {
  // Visibility of other principals' ingests is a publication-management view.
  requirePermission(app, ctx, "publication.plan");
}
