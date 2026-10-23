// .pcpub bundle validation + inspection (ADR-0014 §4/§7; owner §30.1).
//
// One validator serves CLI (offline, optional target registries) and server
// ingest (authoritative, registries always provided). Structure checks are
// unconditional; semantic checks run when registries are available and are
// fail-closed on unknown content types / unsupported block versions.

import { type OpenedPcpubArchive, openPcpubArchive, sha256Hex } from "./archive.js";
import type { CanonicalBlockDocument, PcmdRichTextBridge } from "./canonical.js";
import { pcmdBlockDocument, type RichTextPropsResolver } from "./canonical.js";
import { DiagnosticCollector, type PcpubDiagnostic, PcpubError } from "./diagnostics.js";
import { DEFAULT_PCPUB_LIMITS, type PcpubLimits } from "./limits.js";
import { declaredPaths, type PcpubManifest, parseManifest } from "./manifest.js";
import { collectRefs } from "./pack.js";
import { type PcmdDocument, parsePcmd } from "./pcmd.js";

/**
 * Structural target contracts (layering: L1 defines the shape, L2 — api for
 * the server, cli for offline validation — adapts the real registries).
 * Every issue returned by the adapter already carries a PCPUB_* code.
 */
export interface PcpubTargetContracts {
  /** Unknown content type ⇒ null (compat: PCPUB_COMPAT_CONTENT_TYPE_UNKNOWN). */
  getContentType(key: string): PcpubTargetContentType | null;
  /** Distinct block type ids with available schema versions (discovery). */
  blockVersions(): readonly { readonly typeId: string; readonly versions: readonly number[] }[];
  /**
   * Validates one entry's canonical block document against the target
   * (props schemas, per-block versions, migrations). Must return PCPUB_*-
   * coded issues, with PCPUB_COMPAT_UNSUPPORTED_BLOCK_VERSION for unknown
   * types/versions and PCPUB_COMPAT_* for migration gaps.
   */
  validateEntryBlocks(
    documentPath: string,
    blocks: CanonicalBlockDocument,
  ): readonly PcpubDiagnostic[];
}

export interface PcpubTargetContentType {
  /** Publish-level field validation (same checks seal enforces). */
  validateFields(fields: unknown): readonly { readonly path: string; readonly message: string }[];
  /** Additional entry seal checks that require the Core content registries. */
  validateEntry?(
    path: string,
    payload: { fields: unknown; blocks: unknown },
  ): readonly PcpubDiagnostic[];
}

export interface PcpubAdapterServices {
  readonly bridge?: PcmdRichTextBridge;
}

export interface BundleDocument {
  readonly path: string;
  readonly manifestExternalId: string;
  readonly document: PcmdDocument;
}

/** A fully parsed, hash-verified bundle (pre-semantic). */
export interface VerifiedBundle {
  readonly manifest: PcpubManifest;
  readonly documents: readonly BundleDocument[];
  readonly rawManifest: Buffer;
  readonly archive: OpenedPcpubArchive;
}

export interface VerifyOptions {
  readonly limits?: PcpubLimits;
}

/**
 * Opens + structurally verifies an archive: manifest parse, exact-set,
 * per-descriptor SHA-256/size verification, PCMD parse, document/manifest
 * identity agreement, offline reference resolution. Throws PcpubError on
 * the first structural failure; use validatePcpub for a full report.
 */
export async function verifyPcpub(
  zipPath: string,
  options: VerifyOptions = {},
): Promise<VerifiedBundle> {
  const limits = options.limits ?? DEFAULT_PCPUB_LIMITS;
  const archive = await openPcpubArchive(zipPath, limits);
  const fail = async (error: PcpubError): Promise<never> => {
    await archive.close();
    throw error;
  };
  let rawManifest: Buffer;
  let manifest: PcpubManifest;
  try {
    rawManifest = await archive.readBytes("manifest.json");
    manifest = parseManifest(rawManifest, limits);
    archive.assertExactSet(declaredPaths(manifest));
  } catch (cause) {
    return fail(
      cause instanceof PcpubError
        ? cause
        : new PcpubError("PCPUB_MANIFEST_INVALID", String(cause), { cause }),
    );
  }
  for (const descriptor of [...manifest.documents, ...manifest.assets, ...manifest.artifacts]) {
    const bytes = await archive
      .readBytes(descriptor.path)
      .catch((cause: unknown) =>
        fail(
          cause instanceof PcpubError
            ? cause
            : new PcpubError("PCPUB_ARCHIVE_UNREADABLE", String(cause), { cause }),
        ),
      );
    if (bytes.length !== descriptor.size) {
      return fail(
        new PcpubError("PCPUB_SIZE_MISMATCH", `size mismatch for "${descriptor.path}"`, {
          path: descriptor.path,
        }),
      );
    }
    if (sha256Hex(bytes) !== descriptor.sha256) {
      return fail(
        new PcpubError("PCPUB_CHECKSUM_MISMATCH", `checksum mismatch for "${descriptor.path}"`, {
          path: descriptor.path,
        }),
      );
    }
  }
  const documents: BundleDocument[] = [];
  const documentIssues = new DiagnosticCollector();
  for (const descriptor of manifest.documents) {
    const bytes = await archive.readBytes(descriptor.path);
    let document: PcmdDocument;
    try {
      document = parsePcmd(bytes.toString("utf8"), descriptor.path, limits.maxBlocksPerDocument);
    } catch (cause) {
      if (cause instanceof PcpubError) {
        for (const issue of cause.diagnostics.length > 0
          ? cause.diagnostics
          : [toDiagnostic(cause)]) {
          documentIssues.add(issue.code, issue.path, issue.message);
        }
        continue;
      }
      return fail(
        new PcpubError("PCPUB_DOCUMENT_INVALID", String(cause), { path: descriptor.path, cause }),
      );
    }
    if (
      document.externalId !== descriptor.external_id ||
      document.operation !== descriptor.operation
    ) {
      documentIssues.add(
        "PCPUB_MANIFEST_MISMATCH",
        descriptor.path,
        "document identity/operation disagrees with the manifest",
      );
    }
    documents.push({ path: descriptor.path, manifestExternalId: descriptor.external_id, document });
  }
  if (!documentIssues.ok) {
    return fail(
      new PcpubError("PCPUB_DOCUMENT_INVALID", "document validation failed", {
        diagnostics: documentIssues.all,
      }),
    );
  }
  // Offline reference resolution (server re-checks after media staging).
  const externalIds = new Set([
    ...manifest.documents.map((item) => item.external_id),
    ...Object.keys(manifest.external_entries ?? {}),
  ]);
  const assetSet = new Set(manifest.assets.map((item) => item.path));
  const refIssues = new DiagnosticCollector();
  for (const bundle of documents) {
    const refs = { entry: new Set<string>(), bundle: new Set<string>(), id: new Set<string>() };
    collectRefs(bundle.document.fields, refs);
    collectRefs(bundle.document.blocks, refs);
    if (bundle.document.seo !== undefined) collectRefs(bundle.document.seo, refs);
    for (const ref of refs.entry) {
      if (!externalIds.has(ref)) {
        refIssues.add("PCPUB_DOCUMENT_REF_UNRESOLVED", bundle.path, `ref:${ref} is not declared`);
      }
    }
    for (const ref of refs.bundle) {
      if (!assetSet.has(ref)) {
        refIssues.add(
          "PCPUB_DOCUMENT_REF_UNRESOLVED",
          bundle.path,
          `bundle:${ref} is not a declared asset`,
        );
      }
    }
    for (const _ref of refs.id) {
      if (bundle.document.operation === "create") {
        refIssues.add(
          "PCPUB_DOCUMENT_MEDIA_REF_FORBIDDEN",
          bundle.path,
          "id: media references are only allowed on update operations",
        );
      }
    }
  }
  if (!refIssues.ok) {
    return fail(
      new PcpubError("PCPUB_DOCUMENT_REF_UNRESOLVED", "reference validation failed", {
        diagnostics: refIssues.all,
      }),
    );
  }
  return { manifest, documents, rawManifest, archive };
}

/** Manifest + counts summary (offline; used by `cms bundle inspect`). */
export async function inspectPcpub(
  zipPath: string,
  options: VerifyOptions = {},
): Promise<PcpubManifest> {
  const verified = await verifyPcpub(zipPath, options);
  try {
    return verified.manifest;
  } finally {
    await verified.archive.close();
  }
}

/**
 * Full report validation: every structural + semantic finding, with the
 * target registries when known (the server always provides them; the CLI
 * provides them when a deployment typesFile is configured).
 */
export async function validatePcpub(
  zipPath: string,
  options: VerifyOptions & {
    readonly contracts?: PcpubTargetContracts;
    readonly richTextBridge?: PcmdRichTextBridge;
    readonly richTextPropsFor?: RichTextPropsResolver;
  } = {},
): Promise<readonly PcpubDiagnostic[]> {
  const issues = new DiagnosticCollector();
  let verified: VerifiedBundle;
  try {
    verified = await verifyPcpub(zipPath, options);
  } catch (cause) {
    if (cause instanceof PcpubError) {
      return cause.diagnostics.length > 0 ? cause.diagnostics : [toDiagnostic(cause)];
    }
    return [{ code: "PCPUB_INTERNAL_FAILURE", path: "", message: String(cause) }];
  }
  const { archive, manifest, documents } = verified;
  try {
    const contracts = options.contracts;
    if (contracts === undefined) return issues.all;
    const usedBlocks = new Map<string, number>();
    for (const item of documents) {
      const loaded = contracts.getContentType(item.document.contentType);
      if (loaded === null) {
        issues.add(
          "PCPUB_COMPAT_CONTENT_TYPE_UNKNOWN",
          item.path,
          `content type "${item.document.contentType}" is not registered on the target`,
        );
        continue;
      }
      const canonicalDocument = pcmdBlockDocument(
        item.document,
        item.path,
        options.richTextBridge,
        options.richTextPropsFor,
      );
      const referenceIds = new Map<string, string>();
      const fields = replaceDeferredReferences(item.document.fields, referenceIds);
      for (const error of loaded.validateFields(fields)) {
        issues.add("PCPUB_DOCUMENT_INVALID", `${item.path}/fields${error.path}`, error.message);
      }
      for (const node of canonicalDocument.blocks) usedBlocks.set(node.type, node.schema_version);
      // Check structure with temporary stable IDs; reference existence is
      // verified above and real IDs replace these before transactional apply.
      const blocks = replaceDeferredReferences(canonicalDocument, referenceIds);
      for (const issue of contracts.validateEntryBlocks(item.path, blocks)) {
        issues.add(issue.code, issue.path || item.path, issue.message);
      }
      for (const issue of loaded.validateEntry?.(item.path, { fields, blocks }) ?? []) {
        issues.add(issue.code, issue.path || item.path, issue.message);
      }
    }
    // requires must list EXACTLY the blocks actually used (owner §37).
    const declared = new Set(Object.keys(manifest.requires.blocks));
    for (const type of usedBlocks.keys()) {
      if (!declared.has(type)) {
        issues.add(
          "PCPUB_MANIFEST_MISMATCH",
          "manifest.json",
          `block "${type}" is used but not declared in requires`,
        );
      }
    }
    for (const type of declared) {
      if (!usedBlocks.has(type)) {
        issues.add(
          "PCPUB_MANIFEST_MISMATCH",
          "manifest.json",
          `requires declares unused block "${type}"`,
        );
      }
    }
    return issues.all;
  } finally {
    await archive.close();
  }
}

function toDiagnostic(error: PcpubError): PcpubDiagnostic {
  return { code: error.code, path: error.path, message: error.message };
}

/** Replace deferred tokens only for schema checks; apply resolves the originals. */
function replaceDeferredReferences<T>(value: T, ids: Map<string, string>): T {
  if (typeof value === "string" && /^(?:ref:|bundle:|id:)/.test(value)) {
    let id = ids.get(value);
    if (id === undefined) {
      id = `0198c0de-0000-7000-8000-${(ids.size + 1).toString(16).padStart(12, "0")}`;
      ids.set(value, id);
    }
    return id as T;
  }
  if (Array.isArray(value)) return value.map((item) => replaceDeferredReferences(item, ids)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, member]) => [
        key,
        replaceDeferredReferences(member, ids),
      ]),
    ) as T;
  }
  return value;
}
