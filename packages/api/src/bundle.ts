// Publication Bundle (PCMS-API-T017/T018; API spec §42–§46).
//
// First-class bulk machine operation for agent content workflows: many
// entries, media and route moves accepted in ONE strict all-or-nothing
// transaction over the existing M02/M05/M06/M07 contracts — never a parallel
// transaction engine and never raw table writes (owner instructions #34/#35).
//
// Stages stay distinguishable (spec §36 / owner #36):
//   mode "validate" — full structural + semantic report, zero writes;
//   mode "apply"    — media ingest, then ONE transaction: entries, working
//                     revisions, seals, SEO documents, changeset, items and
//                     (when requested) the public pointer flip.
// Retries: HTTP-layer durable Idempotency-Key (PCMS-API-T007) makes a replay
// return the stored result — no duplicate entries/revisions/changesets.
import { type BlockDocument, validateBlockDocument } from "@pcms/blocks";
import { type LoadedContentType, validateContentPayload } from "@pcms/content";
import type { DbClient, StableId } from "@pcms/core";
import { type AcceptedMedia, fetchRemoteMedia, uploadMedia } from "@pcms/media";
import { parseSeoDocument, type SeoDocument } from "@pcms/seo";
import type { RevisionRecord } from "@pcms/revisions";
import {
  type ApplicationServices,
  type OperationContext,
  requirePermission,
  revisionActorFrom,
} from "./context.js";
import { ApiError } from "./errors.js";
import { createIdempotencyService } from "./http/idempotency.js";
import { requireQuarantine, requireStorage } from "./http/routes/helpers.js";

/** Internal adapter checks run in the candidate transaction, never from request JSON. */
export interface BundleApplyChecks {
  readonly literalRefs?: readonly string[];
  readonly beforeCandidates?: (tx: DbClient) => Promise<void>;
  readonly sourcePathForEntry?: (entry: BundleEntryInput) => string | undefined;
}

export const BUNDLE_VERSION = 1;
export const MAX_BUNDLE_ENTRIES = 50;
export const MAX_BUNDLE_MEDIA = 50;

export interface BundleEntryInput {
  readonly ref?: string;
  readonly entry_id?: string;
  readonly content_type: string;
  readonly payload: { readonly fields?: unknown; readonly blocks?: unknown };
  readonly locale?: string;
  readonly seo?: unknown;
  readonly route?: {
    readonly path: string;
    readonly frees_path?: string;
    readonly site_key?: string;
  };
}

export interface BundleMediaInput {
  readonly ref: string;
  readonly import_url?: string;
  readonly media_id?: string;
}

export interface BundleInput {
  readonly bundle_version: number;
  readonly external_id: string;
  readonly changeset: { readonly title: string };
  readonly entries: readonly BundleEntryInput[];
  readonly media?: readonly BundleMediaInput[];
  readonly publication?: { readonly mode: "now" | "none" };
}

export interface BundleIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

export interface BundleResult {
  readonly accepted: boolean;
  readonly external_id: string;
  readonly changeset_id: string;
  readonly published: boolean;
  readonly entries: {
    readonly ref: string | null;
    readonly entry_id: string;
    readonly revision_id: string;
  }[];
  readonly media: {
    readonly ref: string;
    readonly media_id: string;
    readonly duplicate_blob: boolean;
  }[];
  readonly validation_report: { readonly ok: boolean; readonly issues: readonly BundleIssue[] };
}

const REF_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ---------------------------------------------------------------------------
// Structural + semantic validation (mode "validate" and apply pre-flight).
// ---------------------------------------------------------------------------

export function validateBundleStructure(
  app: ApplicationServices,
  bundle: unknown,
  checks: BundleApplyChecks = {},
): {
  readonly bundle: BundleInput;
  readonly issues: readonly BundleIssue[];
} {
  const issues: BundleIssue[] = [];
  const fail = (path: string, message: string, code = "BUNDLE_INVALID"): void => {
    issues.push({ code, path, message, severity: "error" });
  };
  if (typeof bundle !== "object" || bundle === null) {
    fail("", "bundle must be an object");
    return { bundle: undefined as never, issues };
  }
  const raw = bundle as Record<string, unknown>;
  if (raw["bundle_version"] !== BUNDLE_VERSION) {
    fail(
      "/bundle_version",
      `only bundle_version ${BUNDLE_VERSION} is supported`,
      "BUNDLE_VERSION_UNSUPPORTED",
    );
  }
  if (typeof raw["external_id"] !== "string" || (raw["external_id"] as string).length < 8) {
    fail("/external_id", "external_id is required (>= 8 chars; it is the retry identity)");
  }
  const changeset = raw["changeset"] as Record<string, unknown> | undefined;
  if (
    changeset === undefined ||
    typeof changeset !== "object" ||
    typeof changeset["title"] !== "string" ||
    (changeset["title"] as string).length === 0
  ) {
    fail("/changeset/title", "changeset.title is required");
  }
  if (!Array.isArray(raw["entries"]) || raw["entries"].length === 0) {
    fail("/entries", "entries must be a non-empty array");
    return { bundle: raw as never, issues };
  }
  if (raw["entries"].length > MAX_BUNDLE_ENTRIES) {
    fail("/entries", `bundle exceeds ${MAX_BUNDLE_ENTRIES} entries`, "BUNDLE_TOO_LARGE");
  }
  const refs = new Set<string>();
  const entryIds = new Set<string>();
  const entries = raw["entries"] as readonly Record<string, unknown>[];
  entries.forEach((entry, index) => {
    const path = `/entries/${index}`;
    if (typeof entry !== "object" || entry === null) {
      fail(path, "entry must be an object");
      return;
    }
    const ref = entry["ref"];
    if (ref !== undefined) {
      if (typeof ref !== "string" || !REF_PATTERN.test(ref)) {
        fail(`${path}/ref`, "ref must match [a-z0-9][a-z0-9_-]{0,63}");
      } else if (refs.has(ref)) {
        fail(`${path}/ref`, `duplicate ref "${ref}"`);
      } else {
        refs.add(ref);
      }
    }
    const entryId = entry["entry_id"];
    if (entryId !== undefined) {
      if (typeof entryId !== "string" || !/^[0-9a-f-]{36}$/i.test(entryId)) {
        fail(`${path}/entry_id`, "entry_id must be a stable id");
      } else if (entryIds.has(entryId)) {
        fail(`${path}/entry_id`, `entry ${entryId} appears twice`);
      } else {
        entryIds.add(entryId);
      }
    }
    const contentType = entry["content_type"];
    if (typeof contentType !== "string" || contentType.length === 0) {
      fail(`${path}/content_type`, "content_type is required");
    } else if (app.contentTypes.getLatestContentType(contentType) === null) {
      fail(`${path}/content_type`, `content type "${contentType}" is not registered`);
    }
    if (typeof entry["payload"] !== "object" || entry["payload"] === null) {
      fail(`${path}/payload`, "payload object is required");
    }
  });

  const media = (raw["media"] ?? []) as readonly Record<string, unknown>[];
  if (media.length > MAX_BUNDLE_MEDIA) {
    fail("/media", `bundle exceeds ${MAX_BUNDLE_MEDIA} media items`, "BUNDLE_TOO_LARGE");
  }
  const mediaRefs = new Set<string>();
  media.forEach((item, index) => {
    const path = `/media/${index}`;
    if (typeof item !== "object" || item === null) {
      fail(path, "media item must be an object");
      return;
    }
    const ref = item["ref"];
    if (typeof ref !== "string" || !REF_PATTERN.test(ref)) {
      fail(`${path}/ref`, "media ref must match [a-z0-9][a-z0-9_-]{0,63}");
    } else if (mediaRefs.has(ref)) {
      fail(`${path}/ref`, `duplicate media ref "${ref}"`);
    } else {
      mediaRefs.add(ref);
    }
    const sources = ["import_url", "media_id"].filter((key) => item[key] !== undefined);
    if (sources.length !== 1) {
      fail(`${path}`, "exactly one of import_url / media_id is required");
    }
    if (typeof item["import_url"] === "string" && item["media_id"] === undefined) {
      try {
        const parsed = new URL(item["import_url"] as string);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          fail(`${path}/import_url`, "only http(s) import URLs are allowed");
        }
      } catch {
        fail(`${path}/import_url`, "import_url is not a valid URL");
      }
    }
    if (
      item["media_id"] !== undefined &&
      (typeof item["media_id"] !== "string" || !/^[0-9a-f-]{36}$/i.test(item["media_id"] as string))
    ) {
      fail(`${path}/media_id`, "media_id must be a stable id");
    }
  });

  // Publication intent: only the explicit modes exist; scheduling is a
  // separate stage via the plan endpoints (spec §36 staged semantics).
  const publication = raw["publication"] as Record<string, unknown> | undefined;
  if (
    publication !== undefined &&
    (typeof publication !== "object" || !["now", "none"].includes(publication["mode"] as string))
  ) {
    fail("/publication/mode", 'publication.mode must be "now" or "none"');
  }

  // Semantic payload checks against the content type registry (publish level
  // — the same checks seal enforces), without touching the database.
  // Entries whose payload defers values to bundle refs get a structural ref
  // check only: field-type validation runs after resolution at apply/seal.
  const declaredRefs = new Set<string>([
    ...media.flatMap((item) => (typeof item?.["ref"] === "string" ? [item["ref"] as string] : [])),
    ...entries.flatMap((entry) =>
      typeof entry?.["ref"] === "string" ? [entry["ref"] as string] : [],
    ),
  ]);
  for (const [index, entry] of entries.entries()) {
    const contentType = entry?.["content_type"];
    if (typeof contentType !== "string") continue;
    const payload = (entry?.["payload"] ?? {}) as { fields?: unknown; blocks?: unknown };
    const seo = entry?.["seo"];
    const usedRefs = [
      ...collectRefs(payload).filter((ref) => !checks.literalRefs?.includes(ref)),
      ...collectSeoMediaRef(seo),
    ];
    const unknownRefs = usedRefs.filter((ref) => !declaredRefs.has(ref));
    for (const ref of unknownRefs) {
      issues.push({
        code: "BUNDLE_REF_UNRESOLVED",
        path: `/entries/${index}/payload`,
        message: `reference "ref:${ref}" is not declared in this bundle`,
        severity: "error",
      });
    }
    if (usedRefs.length > 0) {
      issues.push({
        code: "REF_DEFERRED",
        path: `/entries/${index}/payload`,
        message: "field-type validation deferred to apply (values resolved from bundle refs)",
        severity: "warning",
      });
      continue;
    }
    const loaded = app.contentTypes.getLatestContentType(contentType);
    if (loaded === null) continue;
    issues.push(
      ...semanticIssues(
        loaded,
        payload,
        `/entries/${index}`,
        (payloadBlocks) =>
          validateBlockDocument(payloadBlocks, app.blocks) as {
            readonly ok: boolean;
            readonly issues: readonly {
              readonly code: string;
              readonly path: string;
              readonly message: string;
            }[];
          },
      ),
    );
    if (seo !== undefined && seo !== null) {
      try {
        parseSeoDocument(seo);
      } catch (error) {
        issues.push({
          code: "SEO_DOCUMENT_INVALID",
          path: `/entries/${index}/seo`,
          message: error instanceof Error ? error.message : "invalid SEO document",
          severity: "error",
        });
      }
    }
  }

  return { bundle: raw as unknown as BundleInput, issues };
}

/** Collects every `ref:*` string leaf in a payload (first occurrence wins). */
function collectRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.startsWith("ref:")) refs.add(node.slice(4));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const child of Object.values(node as Record<string, unknown>)) walk(child);
    }
  };
  walk(value);
  return [...refs];
}

function collectSeoMediaRef(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const image = (value as Record<string, unknown>).social_image;
  if (typeof image !== "object" || image === null || Array.isArray(image)) return [];
  const assetId = (image as Record<string, unknown>).asset_id;
  return typeof assetId === "string" && assetId.startsWith(REF_PREFIX)
    ? [assetId.slice(REF_PREFIX.length)]
    : [];
}

function resolveSeoMediaRef(value: unknown, resolve: (ref: string) => string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const seo = { ...(value as Record<string, unknown>) };
  const image = seo.social_image;
  if (typeof image !== "object" || image === null || Array.isArray(image)) return seo;
  const socialImage = { ...(image as Record<string, unknown>) };
  const assetId = socialImage.asset_id;
  if (typeof assetId === "string" && assetId.startsWith(REF_PREFIX))
    socialImage.asset_id = resolve(assetId.slice(REF_PREFIX.length));
  seo.social_image = socialImage;
  return seo;
}

function semanticIssues(
  loaded: LoadedContentType,
  payload: { readonly fields?: unknown; readonly blocks?: unknown },
  path: string,
  validateBlocks: (value: unknown) => {
    readonly ok: boolean;
    readonly issues: readonly {
      readonly code: string;
      readonly path: string;
      readonly message: string;
    }[];
  },
): BundleIssue[] {
  const issues: BundleIssue[] = [];
  const result = validateContentPayload(loaded, payload.fields ?? {}, "publish");
  for (const issue of result.errors) {
    issues.push({
      code: issue.code,
      path: `${path}/payload${issue.path}`,
      message: issue.message,
      severity: "error",
    });
  }
  if (loaded.bodyPolicy === "block_document") {
    const blockResult = validateBlocks(payload.blocks ?? null);
    if (!blockResult.ok && "issues" in blockResult) {
      for (const issue of blockResult.issues) {
        issues.push({
          code: issue.code,
          path: `${path}/payload/blocks${issue.path}`,
          message: issue.message,
          severity: "error",
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Intra-bundle reference resolution (T018, spec §45).
// ---------------------------------------------------------------------------

const REF_PREFIX = "ref:";

function resolveRefsIn(
  value: unknown,
  resolve: (ref: string) => string,
  path: string,
  issues: BundleIssue[],
  literalRefs: readonly string[] = [],
): unknown {
  if (typeof value === "string") {
    if (value.startsWith(REF_PREFIX)) {
      const ref = value.slice(REF_PREFIX.length);
      if (literalRefs.includes(ref)) return value;
      const resolved = resolve(ref);
      if (resolved === null) {
        issues.push({
          code: "BUNDLE_REF_UNRESOLVED",
          path,
          message: `reference "${value}" does not match any bundle ref`,
          severity: "error",
        });
        return value;
      }
      return resolved;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      resolveRefsIn(item, resolve, `${path}/${index}`, issues, literalRefs),
    );
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveRefsIn(child, resolve, `${path}/${key}`, issues, literalRefs);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Apply (mode "apply").
// ---------------------------------------------------------------------------

function requireBundlePermissions(
  app: ApplicationServices,
  ctx: OperationContext,
  bundle: BundleInput,
): void {
  // Operation-level authorization computed from the bundle contents: a
  // content-scoped agent can never publish through a bundle (owner #22).
  requirePermission(app, ctx, "content.create");
  if (bundle.entries.some((entry) => entry.entry_id !== undefined))
    requirePermission(app, ctx, "content.edit");
  const wantsImport = (bundle.media ?? []).some((item) => item.import_url !== undefined);
  if (wantsImport) requirePermission(app, ctx, "media.import");
  if ((bundle.media ?? []).length > 0) requirePermission(app, ctx, "media.write");
  if (bundle.entries.some((entry) => entry.seo !== undefined)) {
    requirePermission(app, ctx, "seo.edit");
  }
  if (bundle.entries.some((entry) => entry.route !== undefined)) {
    requirePermission(app, ctx, "publication.plan");
  }
  if (bundle.publication?.mode === "now") requirePermission(app, ctx, "publication.publish");
}

/** Accepts a bundle (strict mode): all-or-nothing across every subsystem. */
export async function applyBundle(
  app: ApplicationServices,
  ctx: OperationContext,
  bundle: BundleInput,
  options: { readonly publishNow: boolean } & BundleApplyChecks,
): Promise<BundleResult> {
  // Media phase happens BEFORE the transaction: network I/O must not hold a
  // DB transaction open (owner instruction #70). Nothing is persisted yet,
  // so a failure here leaves no partial state.
  const mediaResults: { ref: string; mediaId: string; duplicateBlob: boolean }[] = [];
  for (const item of bundle.media ?? []) {
    if (item.import_url !== undefined) {
      const fetched = await fetchRemoteMedia(item.import_url);
      const accepted: AcceptedMedia = await uploadMedia(
        {
          pool: app.pool,
          storage: requireStorage(app),
          quarantine: requireQuarantine(app),
          ...(app.mediaLimits === undefined ? {} : { limits: app.mediaLimits }),
        },
        {
          bytes: fetched.body,
          filename: decodeURIComponent(fetched.finalUrl.split("/").pop() ?? "imported"),
          ...(fetched.contentType === null ? {} : { declaredMimeType: fetched.contentType }),
          createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
        },
      );
      mediaResults.push({
        ref: item.ref,
        mediaId: accepted.asset.id,
        duplicateBlob: accepted.duplicateBlob,
      });
    } else if (item.media_id !== undefined) {
      const { getAsset } = await import("@pcms/media");
      const asset = await getAsset(app.pool, item.media_id as never);
      if (asset === null) {
        throw new ApiError("BUNDLE_REF_UNRESOLVED", `media_id ${item.media_id} does not exist`, {
          status: 422,
        });
      }
      mediaResults.push({ ref: item.ref, mediaId: item.media_id, duplicateBlob: false });
    }
  }

  const actor = revisionActorFrom(ctx);
  const createdBy = `${ctx.actor.type}:${ctx.actor.id}`;
  const publishNow = options.publishNow;

  const outcome = await app.pool.withTransaction(async (tx) => {
    await options.beforeCandidates?.(tx);
    const created: { ref: string | null; entry_id: string; revision_id: string }[] = [];
    const entryRefMap = new Map<string, string>();
    for (const entry of bundle.entries) {
      const loaded = app.contentTypes.getLatestContentType(entry.content_type);
      if (loaded === null) {
        throw new ApiError(
          "BUNDLE_INVALID",
          `content type "${entry.content_type}" is not registered`,
          { status: 422 },
        );
      }
      const entityId =
        entry.entry_id !== undefined
          ? (entry.entry_id as StableId)
          : (
              (await app.entries.createEntryWithinTx(tx, {
                contentTypeId: entry.content_type,
                createdBy,
              })) as { id: StableId }
            ).id;
      if (entry.ref !== undefined) entryRefMap.set(entry.ref, entityId);
      created.push({
        ref: entry.ref ?? null,
        entry_id: entityId,
        revision_id: "",
      });
    }

    const resolveRef = (ref: string): string => {
      const media = mediaResults.find((item) => item.ref === ref);
      if (media !== undefined) return media.mediaId;
      const entryId = entryRefMap.get(ref);
      if (entryId !== undefined) return entryId;
      throw new ApiError(
        "BUNDLE_REF_UNRESOLVED",
        `reference "ref:${ref}" does not match any bundle ref (transaction rolled back)`,
        { status: 422 },
      );
    };

    for (const [index, entry] of bundle.entries.entries()) {
      const target = created[index]!;
      const resolvedPayload = resolveRefsIn(
        { fields: entry.payload.fields ?? {}, blocks: entry.payload.blocks ?? null },
        resolveRef,
        `/entries/${index}/payload`,
        [],
        options.literalRefs,
      ) as { fields: unknown; blocks: BlockDocument | null };
      const resolvedSeo =
        entry.seo === undefined || entry.seo === null
          ? null
          : resolveSeoMediaRef(entry.seo, resolveRef);
      const seoDocument = resolvedSeo === null ? null : parseSeoDocument(resolvedSeo);
      const revision = await app.revisions.createWorkingRevisionWithinTx(tx, {
        entityType: "entry",
        entityId: target.entry_id as StableId,
        payload: resolvedPayload,
        schemaVersion: String(app.contentTypes.getLatestContentType(entry.content_type)!.version),
        ...(entry.locale === undefined ? {} : { locale: entry.locale }),
        actor: { ...actor, bundleId: bundle.external_id },
      });
      let sealed: RevisionRecord;
      try {
        sealed = await app.revisions.sealRevisionWithinTx(tx, {
          revisionId: revision.id,
          ...(seoDocument === null ? {} : { sidecar: { seo: seoDocument } }),
        });
      } catch (error) {
        const details = (error as { details?: { issues?: unknown } } | null)?.details;
        if (
          (error as { code?: unknown } | null)?.code === "REVISION_VALIDATION_FAILED" &&
          Array.isArray(details?.issues)
        ) {
          const sourcePath = options.sourcePathForEntry?.(entry) ?? `/entries/${index}`;
          throw new ApiError("BUNDLE_INVALID", "bundle entry failed seal validation", {
            status: 422,
            details: details.issues.map((issue) => {
              const item = issue as { code?: unknown; path?: unknown; message?: unknown };
              return {
                code: typeof item.code === "string" ? item.code : "REVISION_VALIDATION_FAILED",
                path: `${sourcePath}${typeof item.path === "string" ? item.path : ""}`,
                message:
                  typeof item.message === "string" ? item.message : "revision validation failed",
              };
            }),
            cause: error,
          });
        }
        throw error;
      }
      target.revision_id = sealed.id;
      if (seoDocument !== null) {
        await app.seo.saveDocumentWithinTx(tx, target.entry_id, seoDocument);
      }
    }

    const changeset = await app.changesets.createChangesetWithinTx(tx, {
      title: bundle.changeset.title,
      actor,
    });
    for (const [index, entry] of bundle.entries.entries()) {
      const target = created[index]!;
      const route = entry.route;
      let siteId: string | undefined;
      if (route !== undefined) {
        const site =
          route.site_key === undefined
            ? await app.routes.findSiteByKey(app.defaultSiteKey)
            : await app.routes.findSiteByKey(route.site_key);
        if (site === null) {
          throw new ApiError(
            "BUNDLE_INVALID",
            `route site "${route.site_key ?? app.defaultSiteKey}" does not exist`,
            { status: 422 },
          );
        }
        siteId = site.id;
      }
      // CAS baseline = the entry's LIVE publication generation at authoring
      // time (0 only when the entry was never published). A hardcoded 0 made
      // every re-application against published entries fail as stale —
      // blocking the documented route-move use of bundles.
      const livePublication = await app.publications.getPublication(
        tx,
        "entry",
        target.entry_id as StableId,
      );
      await app.changesets.addItemWithinTx(tx, changeset.id, {
        entityType: "entry",
        entityId: target.entry_id as StableId,
        intent: "PUBLISH",
        targetRevisionId: target.revision_id as StableId,
        expectedGeneration: livePublication?.generation ?? 0,
        ...(route === undefined || siteId === undefined
          ? {}
          : {
              routeOperation: {
                kind: "set",
                siteId,
                path: route.path,
                ...(route.frees_path === undefined ? {} : { freesPath: route.frees_path }),
              },
            }),
      });
    }

    let published = false;
    if (publishNow) {
      // The public flip rides the SAME transaction: atomic bundle semantics
      // (apply re-runs staleness + combined-state validation at commit time).
      await app.changesets.applyWithinTx(tx, changeset.id, {
        actor,
        expectedStates: ["OPEN", "READY"],
      });
      published = true;
    }

    return { changesetId: changeset.id, created, mediaResults, published };
  });

  return {
    accepted: true,
    external_id: bundle.external_id,
    changeset_id: outcome.changesetId,
    published: outcome.published,
    entries: outcome.created,
    media: outcome.mediaResults.map((item) => ({
      ref: item.ref,
      media_id: item.mediaId,
      duplicate_blob: item.duplicateBlob,
    })),
    validation_report: { ok: true, issues: [] },
  };
}

/** Entry-point used by both REST and MCP: validate-then-apply or report. */
export async function submitBundle(
  app: ApplicationServices,
  ctx: OperationContext,
  bundle: unknown,
  mode: "validate" | "apply",
  checks: BundleApplyChecks = {},
): Promise<
  | BundleResult
  | { accepted: false; validation_report: { ok: boolean; issues: readonly BundleIssue[] } }
> {
  const { bundle: parsed, issues } = validateBundleStructure(app, bundle, checks);
  const ok = !issues.some((issue) => issue.severity === "error");
  if (!ok) {
    if (mode === "validate") return { accepted: false, validation_report: { ok, issues } };
    // Strict apply: clear no-partial-commit semantics (spec §43).
    throw new ApiError("BUNDLE_INVALID", "bundle failed strict validation", {
      status: 422,
      details: issues,
    });
  }
  if (mode === "validate") {
    return { accepted: false, validation_report: { ok, issues } };
  }
  requireBundlePermissions(app, ctx, parsed);
  const publicationMode = parsed.publication?.mode ?? "none";
  // Transport-independent idempotency (spec §10/§11): the bundle's
  // external_id IS the retry identity, so REST, MCP and CLI replays all
  // return the stored result and never duplicate state (owner #37).
  const idempotency = createIdempotencyService(app.pool);
  const outcome = await idempotency.run({
    operation: "bundle_apply",
    key: parsed.external_id,
    scope: `bundle:${ctx.actor.type}:${ctx.actor.id}`,
    fingerprint: parsed,
    run: () => applyBundle(app, ctx, parsed, { publishNow: publicationMode === "now", ...checks }),
  });
  return outcome.result;
}
