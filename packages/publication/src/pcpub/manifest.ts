// .pcpub manifest.json (ADR-0014 §2/§4; API spec §81). Machine-generated,
// deterministic (canonical key order, sorted descriptors, RFC3339 UTC time),
// independently versioned from the logical bundle contract. The server
// re-validates every field and recomputes every hash — the manifest grants
// no trust.
import { PcpubError } from "./diagnostics.js";
import type { PcpubLimits } from "./limits.js";
import { assertValidEntryPath, isAllowedEntryPath } from "./paths.js";
import { isUlid } from "./ulid.js";

export const PCPUB_FORMAT = "progressive-cms-publication-bundle";
export const PCPUB_VERSION = 1;
export const PCPUB_EXTERNAL_ENTRIES_VERSION = 2;
export const PCPUB_SUPPORTED_VERSIONS = [PCPUB_VERSION, PCPUB_EXTERNAL_ENTRIES_VERSION];

export type ExternalEntries = Readonly<
  Record<string, { readonly path: string; readonly locale: string }>
>;

/** Structural validation only; the server applies the target Routing Policy. */
export function parseExternalEntries(
  value: unknown,
  limits: PcpubLimits,
  path: string,
): ExternalEntries {
  const fail = (message: string): never => {
    throw new PcpubError("PCPUB_EXTERNAL_ENTRY_INVALID", message, { path });
  };
  if (!isPlainObject(value)) fail("external_entries must be a mapping");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > limits.maxDocuments) fail("too many external entries");
  return Object.fromEntries(
    entries
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([alias, target]) => {
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(alias) || /^m[0-9]+$/.test(alias))
          fail(`invalid or reserved alias ${alias}`);
        if (
          !isPlainObject(target) ||
          Object.keys(target).some((key) => !["path", "locale"].includes(key))
        )
          fail(`invalid target ${alias}`);
        const record = target as Record<string, unknown>;
        const targetPath = record["path"];
        if (
          typeof targetPath !== "string" ||
          targetPath.length > 2048 ||
          !targetPath.startsWith("/") ||
          /[?#%\\]/.test(targetPath) ||
          [...targetPath].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
          (targetPath !== "/" &&
            targetPath
              .replace(/\/$/, "")
              .slice(1)
              .split("/")
              .some((segment) => ["", ".", ".."].includes(segment)))
        )
          fail(`unsafe site path for ${alias}`);
        if (
          typeof record["locale"] !== "string" ||
          !/^(default|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/.test(record["locale"])
        )
          fail(`locale required for ${alias}`);
        return [alias, { path: targetPath as string, locale: record["locale"] as string }];
      }),
  );
}

export function assertExternalEntryAliases(
  external: ExternalEntries | undefined,
  documentIds: readonly string[],
): void {
  if (new Set(documentIds).size !== documentIds.length)
    throw new PcpubError("PCPUB_DOCUMENT_INVALID", "duplicate document external_id");
  for (const alias of Object.keys(external ?? {})) {
    if (documentIds.includes(alias))
      throw new PcpubError(
        "PCPUB_EXTERNAL_ENTRY_INVALID",
        `alias ${alias} collides with a document`,
        { path: `external_entries/${alias}` },
      );
  }
}
export const PCMD_VERSION_SUPPORTED = 1;
/** The server-side logical bundle contract this format serializes. */
export const BUNDLE_CONTRACT = "1";
export const CONTENT_CONTRACT = "1";

export type PublicationMode = "now" | "none";

export interface ManifestDocument {
  readonly path: string;
  readonly external_id: string;
  readonly operation: "create" | "update";
  readonly size: number;
  readonly sha256: string;
}

export interface ManifestAsset {
  readonly path: string;
  readonly media_type: string;
  readonly size: number;
  readonly sha256: string;
  readonly provenance?: Record<string, unknown>;
}

export interface ManifestArtifact {
  readonly path: string;
  readonly kind: "research" | "review" | "author_notes";
  readonly size: number;
  readonly sha256: string;
}

export interface PcpubManifest {
  readonly format: string;
  readonly pcpub_version: number;
  readonly bundle_id: string;
  readonly created_at: string;
  readonly producer: { readonly name: string; readonly version: string };
  readonly authoring: { readonly pcmd_version: number };
  readonly requires: {
    readonly bundle_contract: string;
    readonly content_contract: string;
    readonly blocks: Readonly<Record<string, string>>;
  };
  readonly intent: {
    readonly changeset_title: string;
    readonly publication: { readonly mode: PublicationMode };
  };
  readonly external_entries?: ExternalEntries;
  readonly documents: readonly ManifestDocument[];
  readonly assets: readonly ManifestAsset[];
  readonly artifacts: readonly ManifestArtifact[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function fail(
  message: string,
  code: "PCPUB_MANIFEST_INVALID" | "PCPUB_MANIFEST_MISMATCH" = "PCPUB_MANIFEST_INVALID",
): never {
  throw new PcpubError(code, message, { path: "manifest.json" });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function descriptorKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) fail("descriptors must be objects");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) fail(`unknown descriptor key "${key}"`);
  }
  return record;
}

function requirePath(record: Record<string, unknown>): string {
  const path = record["path"];
  if (typeof path !== "string") fail("descriptor path required");
  if (!isAllowedEntryPath(path)) fail(`path "${path}" is outside the bundle allowlist`);
  assertValidEntryPath(path);
  return path;
}

function requireSizeSha(record: Record<string, unknown>): { size: number; sha256: string } {
  const size = record["size"];
  const sha256 = record["sha256"];
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0)
    fail("descriptor size invalid");
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    fail("descriptor sha256 must be lowercase hex sha256");
  }
  return { size, sha256 };
}

function sortedByPath<T extends { readonly path: string }>(items: readonly T[]): boolean {
  for (let i = 1; i < items.length; i += 1) {
    if (items[i - 1]!.path >= items[i]!.path) return false;
  }
  return true;
}

/** Parses + structurally validates manifest bytes (no payload hashing here). */
export function parseManifest(bytes: Uint8Array, limits: PcpubLimits): PcpubManifest {
  if (bytes.length > limits.maxManifestBytes) {
    throw new PcpubError("PCPUB_MANIFEST_TOO_LARGE", "manifest exceeds the size limit", {
      path: "manifest.json",
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new PcpubError("PCPUB_MANIFEST_INVALID", "manifest is not valid UTF-8 JSON", {
      path: "manifest.json",
      cause,
    });
  }
  if (!isPlainObject(raw)) fail("manifest must be an object");
  const allowed = new Set([
    "format",
    "pcpub_version",
    "bundle_id",
    "created_at",
    "producer",
    "authoring",
    "requires",
    "intent",
    "documents",
    "assets",
    "artifacts",
    "external_entries",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(`unknown manifest key "${key}"`);
  }
  if (raw["format"] !== PCPUB_FORMAT) fail(`format must be "${PCPUB_FORMAT}"`);
  if (!PCPUB_SUPPORTED_VERSIONS.includes(raw["pcpub_version"] as number)) {
    throw new PcpubError(
      "PCPUB_ARCHIVE_UNSUPPORTED_VERSION",
      `supported pcpub versions: ${PCPUB_SUPPORTED_VERSIONS.join(", ")}`,
      { path: "manifest.json" },
    );
  }
  const bundleId = raw["bundle_id"];
  if (typeof bundleId !== "string" || !isUlid(bundleId)) fail("bundle_id must be a ULID");
  const createdAt = raw["created_at"];
  if (typeof createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(createdAt)) {
    fail("created_at must be RFC3339 UTC (YYYY-MM-DDTHH:MM:SSZ)");
  }
  const producer = raw["producer"];
  if (!isPlainObject(producer)) fail("producer must be an object");
  for (const key of ["name", "version"] as const) {
    if (
      typeof producer[key] !== "string" ||
      producer[key] === "" ||
      String(producer[key]).length > 128
    ) {
      fail(`producer.${key} required (<= 128 chars)`);
    }
  }
  const authoring = raw["authoring"];
  if (!isPlainObject(authoring) || authoring["pcmd_version"] !== PCMD_VERSION_SUPPORTED) {
    fail(`authoring.pcmd_version must be ${PCMD_VERSION_SUPPORTED}`);
  }
  const requires = raw["requires"];
  if (!isPlainObject(requires)) fail("requires must be an object");
  if (requires["bundle_contract"] !== BUNDLE_CONTRACT) {
    throw new PcpubError("PCPUB_COMPAT_UNSUPPORTED_CONTRACT", "unsupported bundle_contract", {
      path: "manifest.json",
    });
  }
  if (requires["content_contract"] !== CONTENT_CONTRACT) {
    throw new PcpubError("PCPUB_COMPAT_UNSUPPORTED_CONTRACT", "unsupported content_contract", {
      path: "manifest.json",
    });
  }
  const blocks = requires["blocks"];
  if (!isPlainObject(blocks)) fail("requires.blocks must be an object");
  const blockKeys = Object.keys(blocks);
  if (blockKeys.length > 64) fail("requires.blocks lists too many block types");
  for (const key of blockKeys) {
    const range = blocks[key];
    if (typeof range !== "string" || !/^\^?\d+(\.\d+){0,2}$/.test(range)) {
      fail(`requires.blocks["${key}"] must be a simple semver range`);
    }
  }
  const intent = raw["intent"];
  if (!isPlainObject(intent)) fail("intent must be an object");
  const title = intent["changeset_title"];
  if (typeof title !== "string" || title.length === 0 || title.length > 300) {
    fail("intent.changeset_title required (<= 300 chars)");
  }
  const publication = intent["publication"];
  if (!isPlainObject(publication)) fail("intent.publication must be an object");
  const mode = publication["mode"];
  if (mode !== "now" && mode !== "none") {
    fail('intent.publication.mode must be "now" or "none"');
  }

  const external =
    raw["external_entries"] === undefined
      ? undefined
      : parseExternalEntries(raw["external_entries"], limits, "manifest.json/external_entries");
  if (external !== undefined && raw["pcpub_version"] !== PCPUB_EXTERNAL_ENTRIES_VERSION)
    fail("external_entries requires pcpub_version 2");
  const documentsRaw = raw["documents"];
  if (!Array.isArray(documentsRaw) || documentsRaw.length === 0)
    fail("documents must be non-empty");
  if (documentsRaw.length > limits.maxDocuments) {
    fail(`more than ${limits.maxDocuments} documents`);
  }
  const documents = documentsRaw.map((value) => {
    const record = descriptorKeys(value, ["path", "external_id", "operation", "size", "sha256"]);
    const path = requirePath(record);
    if (!path.startsWith("content/") || !path.endsWith(".pcmd")) {
      fail(`document path "${path}" must live under content/ with .pcmd`);
    }
    const externalId = record["external_id"];
    if (typeof externalId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(externalId)) {
      fail("document external_id invalid");
    }
    const operation = record["operation"];
    if (operation !== "create" && operation !== "update") fail("document operation invalid");
    const { size, sha256 } = requireSizeSha(record);
    return {
      path,
      external_id: externalId,
      operation: operation as "create" | "update",
      size,
      sha256,
    };
  });
  assertExternalEntryAliases(
    external,
    documents.map((d) => d.external_id),
  );
  if (!sortedByPath(documents)) fail("documents must be sorted by path");

  const assetsRaw = raw["assets"] ?? [];
  if (!Array.isArray(assetsRaw)) fail("assets must be an array");
  if (assetsRaw.length > limits.maxAssets) fail(`more than ${limits.maxAssets} assets`);
  const assets = assetsRaw.map((value) => {
    const record = descriptorKeys(value, ["path", "media_type", "size", "sha256", "provenance"]);
    const path = requirePath(record);
    if (!path.startsWith("assets/")) fail(`asset path "${path}" must live under assets/`);
    const mediaType = record["media_type"];
    if (typeof mediaType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) {
      fail("asset media_type invalid");
    }
    const { size, sha256 } = requireSizeSha(record);
    const provenance = record["provenance"];
    if (provenance !== undefined && !isPlainObject(provenance))
      fail("asset provenance must be an object");
    return {
      path,
      media_type: mediaType,
      size,
      sha256,
      ...(provenance === undefined ? {} : { provenance: provenance as Record<string, unknown> }),
    };
  });
  if (!sortedByPath(assets)) fail("assets must be sorted by path");

  const artifactsRaw = raw["artifacts"] ?? [];
  if (!Array.isArray(artifactsRaw)) fail("artifacts must be an array");
  if (artifactsRaw.length > limits.maxArtifacts) fail(`more than ${limits.maxArtifacts} artifacts`);
  const artifacts = artifactsRaw.map((value) => {
    const record = descriptorKeys(value, ["path", "kind", "size", "sha256"]);
    const path = requirePath(record);
    const kind = record["kind"];
    if (kind !== "research" && kind !== "review" && kind !== "author_notes") {
      fail("artifact kind invalid");
    }
    if (kind === "author_notes" ? path !== "author-notes.md" : !path.startsWith(`${kind}/`)) {
      fail(`artifact kind "${kind}" does not match path "${path}"`);
    }
    const { size, sha256 } = requireSizeSha(record);
    return { path, kind, size, sha256 } as ManifestArtifact;
  });
  if (!sortedByPath(artifacts)) fail("artifacts must be sorted by path");

  return {
    format: PCPUB_FORMAT,
    pcpub_version: raw["pcpub_version"] as number,
    bundle_id: bundleId,
    created_at: createdAt,
    producer: { name: producer["name"] as string, version: producer["version"] as string },
    authoring: { pcmd_version: PCMD_VERSION_SUPPORTED },
    requires: {
      bundle_contract: BUNDLE_CONTRACT,
      content_contract: CONTENT_CONTRACT,
      blocks: blocks as Readonly<Record<string, string>>,
    },
    intent: { changeset_title: title, publication: { mode } },
    ...(external === undefined ? {} : { external_entries: external }),
    documents,
    assets,
    artifacts,
  };
}

/** Declared archive paths == manifest descriptors + the manifest itself. */
export function declaredPaths(manifest: PcpubManifest): Set<string> {
  return new Set([
    "manifest.json",
    ...manifest.documents.map((item) => item.path),
    ...manifest.assets.map((item) => item.path),
    ...manifest.artifacts.map((item) => item.path),
  ]);
}

/** Deterministic logical payload digest (ADR-0014 §7; ihpub §34 shape). */
export function logicalPayloadDigest(
  rawManifestBytes: Uint8Array,
  manifest: PcpubManifest,
  hash: (data: Uint8Array) => string,
): string {
  const parts: string[] = [];
  const descriptors = [
    ...manifest.documents.map((d) => ({ path: d.path, size: d.size, sha256: d.sha256 })),
    ...manifest.assets.map((d) => ({ path: d.path, size: d.size, sha256: d.sha256 })),
    ...manifest.artifacts.map((d) => ({ path: d.path, size: d.size, sha256: d.sha256 })),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const item of descriptors) {
    parts.push(`${item.path}\0${item.size}\0${item.sha256}\n`);
  }
  const payload = new Uint8Array(
    rawManifestBytes.length + 1 + Buffer.from(parts.join(""), "utf8").length,
  );
  payload.set(rawManifestBytes, 0);
  payload[rawManifestBytes.length] = 0;
  payload.set(Buffer.from(parts.join(""), "utf8"), rawManifestBytes.length + 1);
  return hash(payload);
}

/** Canonical serialization — deterministic key order via literal construction. */
export function serializeManifest(manifest: PcpubManifest): string {
  return `${JSON.stringify(
    {
      format: manifest.format,
      pcpub_version: manifest.pcpub_version,
      bundle_id: manifest.bundle_id,
      created_at: manifest.created_at,
      producer: { name: manifest.producer.name, version: manifest.producer.version },
      authoring: { pcmd_version: manifest.authoring.pcmd_version },
      requires: {
        bundle_contract: manifest.requires.bundle_contract,
        content_contract: manifest.requires.content_contract,
        blocks: manifest.requires.blocks,
      },
      intent: {
        changeset_title: manifest.intent.changeset_title,
        publication: { mode: manifest.intent.publication.mode },
      },
      ...(manifest.external_entries === undefined
        ? {}
        : { external_entries: manifest.external_entries }),
      documents: manifest.documents.map((d) => ({
        path: d.path,
        external_id: d.external_id,
        operation: d.operation,
        size: d.size,
        sha256: d.sha256,
      })),
      assets: manifest.assets.map((a) => ({
        path: a.path,
        media_type: a.media_type,
        size: a.size,
        sha256: a.sha256,
        ...(a.provenance === undefined ? {} : { provenance: a.provenance }),
      })),
      artifacts: manifest.artifacts.map((a) => ({
        path: a.path,
        kind: a.kind,
        size: a.size,
        sha256: a.sha256,
      })),
    },
    null,
    "\t",
  )}\n`;
}
