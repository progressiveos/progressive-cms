// Deterministic workspace reader/packer (ADR-0014 §2/§9; owner §29).
//
// The workspace is allowlist-driven: `publication.yaml` + `content/*.pcmd`
// + `assets/**` + `research/**` + `review/**` + `author-notes.md`. Anything
// else (scratch, `.pcms/**`) is EXCLUDED, never packed. Pack output is
// byte-stable for identical inputs (sorted entries, fixed mtime, canonical
// manifest); bundle_id/created_at are injectable for tests. Normal packs
// generate a fresh bundle_id — retries reuse the same packed bytes.

import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as yamlParseSync } from "yaml";
import { openPcpubArchive, sha256Hex, writePcpubArchive } from "./archive.js";
import { DiagnosticCollector, PcpubError } from "./diagnostics.js";
import { DEFAULT_PCPUB_LIMITS, type PcpubLimits } from "./limits.js";
import {
  assertExternalEntryAliases,
  declaredPaths,
  type ExternalEntries,
  logicalPayloadDigest,
  type ManifestArtifact,
  type ManifestAsset,
  type ManifestDocument,
  type PcpubManifest,
  type PublicationMode,
  parseExternalEntries,
  parseManifest,
  serializeManifest,
} from "./manifest.js";
import { artifactKindOf } from "./paths.js";
import { type PcmdDocument, parsePcmd } from "./pcmd.js";
import { generateUlid } from "./ulid.js";

export const PCMS_DIR = ".pcms";

export interface WorkspaceMeta {
  readonly external_entries?: ExternalEntries;
  readonly changeset_title: string;
  readonly publication: { readonly mode: PublicationMode };
  readonly producer?: { readonly name?: string; readonly version?: string };
}

export interface PackedBundle {
  readonly path: string;
  readonly bundleId: string;
  readonly manifest: PcpubManifest;
  readonly archiveSha256: string;
  readonly payloadDigest: string;
}

export interface PackOptions {
  readonly out: string;
  readonly limits?: PcpubLimits;
  readonly producer?: { readonly name: string; readonly version: string };
  /** Test hooks for byte-identical fixtures. */
  readonly now?: () => number;
  readonly random?: (size: number) => Uint8Array;
}

function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function walkFiles(dir: string, base: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, base, out);
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join("/"));
    }
  }
}

function parseWorkspaceMeta(bytes: Buffer, limits: PcpubLimits): WorkspaceMeta {
  let parsed: unknown;
  try {
    parsed = yamlParseSync(bytes.toString("utf8"), { strict: true, uniqueKeys: true });
  } catch (cause) {
    throw new PcpubError("PCPUB_DOCUMENT_INVALID", "publication.yaml is not valid YAML", {
      path: "publication.yaml",
      cause,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new PcpubError("PCPUB_DOCUMENT_INVALID", "publication.yaml must be a mapping", {
      path: "publication.yaml",
    });
  }
  const raw = parsed as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) => !["changeset_title", "publication", "producer", "external_entries"].includes(key),
    )
  )
    throw new PcpubError("PCPUB_DOCUMENT_INVALID", "unknown publication.yaml key", {
      path: "publication.yaml",
    });
  const external =
    raw["external_entries"] === undefined
      ? undefined
      : parseExternalEntries(raw["external_entries"], limits, "publication.yaml/external_entries");
  const title = raw["changeset_title"];
  if (typeof title !== "string" || title.length === 0 || title.length > 300) {
    throw new PcpubError(
      "PCPUB_DOCUMENT_INVALID",
      "publication.yaml: changeset_title is required (<= 300 chars)",
      { path: "publication.yaml" },
    );
  }
  const publication = raw["publication"];
  const mode =
    typeof publication === "object" && publication !== null
      ? (publication as Record<string, unknown>)["mode"]
      : undefined;
  if (mode !== "now" && mode !== "none") {
    throw new PcpubError(
      "PCPUB_DOCUMENT_INVALID",
      'publication.yaml: publication.mode must be "now" or "none"',
      { path: "publication.yaml" },
    );
  }
  const producer = raw["producer"];
  return {
    ...(external === undefined ? {} : { external_entries: external }),
    changeset_title: title,
    publication: { mode },
    ...(typeof producer === "object" && producer !== null
      ? {
          producer: {
            ...(typeof (producer as Record<string, unknown>)["name"] === "string"
              ? { name: (producer as Record<string, unknown>)["name"] as string }
              : {}),
            ...(typeof (producer as Record<string, unknown>)["version"] === "string"
              ? { version: (producer as Record<string, unknown>)["version"] as string }
              : {}),
          },
        }
      : {}),
  };
}

/** Collects ref:/bundle:/id: leaf strings from a payload tree. */
export function collectRefs(
  value: unknown,
  refs: { entry: Set<string>; bundle: Set<string>; id: Set<string> },
): void {
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.startsWith("ref:")) refs.entry.add(node.slice(4));
      else if (node.startsWith("bundle:")) refs.bundle.add(node.slice(7));
      else if (node.startsWith("id:")) refs.id.add(node.slice(3));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const child of Object.values(node as Record<string, unknown>)) walk(child);
    }
  };
  walk(value);
}

export interface ParsedWorkspace {
  readonly meta: WorkspaceMeta;
  readonly documents: readonly { readonly path: string; readonly document: PcmdDocument }[];
  readonly assetPaths: readonly string[];
  readonly artifactPaths: readonly string[];
}

/** Reads + strictly parses the workspace (offline; no target CMS needed). */
export async function readWorkspace(
  workspacePath: string,
  limits: PcpubLimits = DEFAULT_PCPUB_LIMITS,
): Promise<ParsedWorkspace> {
  const info = await stat(workspacePath).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new PcpubError("PCPUB_PATH_INVALID", "workspace directory does not exist");
  }
  const metaBytes = await readFile(join(workspacePath, "publication.yaml"), {}).catch(() => null);
  if (metaBytes === null) {
    throw new PcpubError("PCPUB_DOCUMENT_INVALID", "publication.yaml is required", {
      path: "publication.yaml",
    });
  }
  const meta = parseWorkspaceMeta(metaBytes, limits);

  const all: string[] = [];
  for (const dir of ["content", "assets", "research", "review"]) {
    const full = join(workspacePath, dir);
    if ((await stat(full).catch(() => null))?.isDirectory() === true) {
      await walkFiles(full, workspacePath, all);
    }
  }
  const authorNotes =
    (await stat(join(workspacePath, "author-notes.md")).catch(() => null))?.isFile() === true;
  const paths = all
    .filter((path) => !path.startsWith(`${PCMS_DIR}/`) && !path.includes(`/${PCMS_DIR}/`))
    .sort();

  const documents: { path: string; document: PcmdDocument }[] = [];
  const assetPaths: string[] = [];
  const artifactPaths: string[] = [];
  const issues = new DiagnosticCollector();
  for (const path of paths) {
    if (path.startsWith("content/")) {
      if (!path.endsWith(".pcmd")) {
        issues.add("PCPUB_PATH_INVALID", path, "content/ holds only *.pcmd documents");
        continue;
      }
      const bytes = await readFile(join(workspacePath, path));
      if (bytes.length > limits.maxDocumentBytes) {
        issues.add(
          "PCPUB_ARCHIVE_ENTRY_TOO_LARGE",
          path,
          `document exceeds ${limits.maxDocumentBytes} bytes`,
        );
        continue;
      }
      try {
        documents.push({
          path,
          document: parsePcmd(bytes.toString("utf8"), path, limits.maxBlocksPerDocument),
        });
      } catch (cause) {
        if (cause instanceof PcpubError) {
          for (const diagnostic of cause.diagnostics.length > 0
            ? cause.diagnostics
            : [{ code: cause.code, path: cause.path, message: cause.message }]) {
            issues.add(diagnostic.code, diagnostic.path, diagnostic.message);
          }
          continue;
        }
        throw cause;
      }
    } else if (path.startsWith("assets/")) {
      assetPaths.push(path);
    } else if (artifactKindOf(path) !== null) {
      artifactPaths.push(path);
    }
  }
  if (authorNotes) artifactPaths.push("author-notes.md");
  artifactPaths.sort((a, b) => (a < b ? -1 : 1));
  if (documents.length === 0) {
    issues.add("PCPUB_DOCUMENT_INVALID", "content/", "workspace has no *.pcmd documents");
  }
  if (!issues.ok) {
    throw new PcpubError("PCPUB_DOCUMENT_INVALID", "workspace validation failed", {
      diagnostics: issues.all,
    });
  }
  const externalIds = new Set<string>();
  for (const item of documents) {
    if (externalIds.has(item.document.externalId)) {
      throw new PcpubError(
        "PCPUB_DOCUMENT_INVALID",
        `duplicate external_id "${item.document.externalId}"`,
        { path: item.path },
      );
    }
    externalIds.add(item.document.externalId);
  }

  assertExternalEntryAliases(meta.external_entries, [...externalIds]);
  for (const alias of Object.keys(meta.external_entries ?? {})) externalIds.add(alias);

  // Offline reference resolution (owner §15): entry refs must name workspace
  // documents, bundle: refs must name bundled assets; id: media reuse is
  // update-only; file:/data: media refs are always forbidden.
  const assetSet = new Set(assetPaths);
  for (const item of documents) {
    const refs = { entry: new Set<string>(), bundle: new Set<string>(), id: new Set<string>() };
    collectRefs(item.document.fields, refs);
    collectRefs(item.document.blocks, refs);
    if (item.document.seo !== undefined) collectRefs(item.document.seo, refs);
    for (const ref of refs.entry) {
      if (!externalIds.has(ref)) {
        issues.add(
          "PCPUB_DOCUMENT_REF_UNRESOLVED",
          item.path,
          `ref:${ref} is not a workspace document`,
        );
      }
    }
    for (const ref of refs.bundle) {
      if (!assetSet.has(ref)) {
        issues.add(
          "PCPUB_DOCUMENT_REF_UNRESOLVED",
          item.path,
          `bundle:${ref} is not a bundled asset`,
        );
      }
    }
    for (const _ref of refs.id) {
      if (item.document.operation === "create") {
        issues.add(
          "PCPUB_DOCUMENT_MEDIA_REF_FORBIDDEN",
          item.path,
          "id: media references are only allowed on update operations",
        );
      }
    }
  }
  if (!issues.ok) {
    throw new PcpubError("PCPUB_DOCUMENT_INVALID", "workspace validation failed", {
      diagnostics: issues.all,
    });
  }
  return { meta, documents, assetPaths, artifactPaths };
}

/** Packs a workspace into a deterministic .pcpub (validate + build + zip). */
export async function packWorkspace(
  workspacePath: string,
  options: PackOptions,
): Promise<PackedBundle> {
  const limits = options.limits ?? DEFAULT_PCPUB_LIMITS;
  const workspace = await readWorkspace(workspacePath, limits);
  const now = options.now ?? Date.now;
  const random = options.random ?? ((size: number) => new Uint8Array(randomBytes(size)));

  const documents: ManifestDocument[] = [];
  const blocks = new Map<string, number>();
  const entryRefs: Set<string>[] = [];
  for (const item of workspace.documents) {
    const bytes = await readFile(join(workspacePath, item.path));
    documents.push({
      path: item.path,
      external_id: item.document.externalId,
      operation: item.document.operation,
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
    for (const block of item.document.blocks) {
      blocks.set(block.type, block.schemaVersion);
    }
    entryRefs.push(new Set([item.document.externalId]));
  }

  const assets: ManifestAsset[] = [];
  let totalAssets = 0;
  for (const path of workspace.assetPaths) {
    const bytes = await readFile(join(workspacePath, path));
    totalAssets += bytes.length;
    if (bytes.length > limits.maxAssetBytes) {
      throw new PcpubError(
        "PCPUB_ARCHIVE_ENTRY_TOO_LARGE",
        `asset exceeds ${limits.maxAssetBytes} bytes`,
        { path },
      );
    }
    if (totalAssets > limits.maxTotalAssetBytes) {
      throw new PcpubError("PCPUB_ARCHIVE_TOO_LARGE", "total asset size exceeds the limit", {
        path,
      });
    }
    assets.push({
      path,
      media_type: mediaTypeFor(path),
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
  }

  const artifacts: ManifestArtifact[] = [];
  let totalArtifacts = 0;
  for (const path of workspace.artifactPaths) {
    const bytes = await readFile(join(workspacePath, path));
    totalArtifacts += bytes.length;
    if (totalArtifacts > limits.maxTotalArtifactBytes) {
      throw new PcpubError("PCPUB_ARCHIVE_TOO_LARGE", "total artifact size exceeds the limit", {
        path,
      });
    }
    artifacts.push({
      path,
      kind: artifactKindOf(path)!,
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
  }

  const manifest: PcpubManifest = {
    format: "progressive-cms-publication-bundle",
    pcpub_version: workspace.meta.external_entries === undefined ? 1 : 2,
    bundle_id: generateUlid(now(), random),
    created_at: rfc3339(now()),
    producer: {
      name: options.producer?.name ?? workspace.meta.producer?.name ?? "pcms-cli",
      version: options.producer?.version ?? workspace.meta.producer?.version ?? "1.0.0",
    },
    authoring: { pcmd_version: 1 },
    requires: {
      bundle_contract: "1",
      content_contract: "1",
      blocks: Object.fromEntries(
        [...blocks.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([type, version]) => [type, `^${version}`]),
      ),
    },
    intent: {
      changeset_title: workspace.meta.changeset_title,
      publication: { mode: workspace.meta.publication.mode },
    },
    ...(workspace.meta.external_entries === undefined
      ? {}
      : { external_entries: workspace.meta.external_entries }),
    documents,
    assets,
    artifacts,
  };

  const manifestBytes = Buffer.from(serializeManifest(manifest), "utf8");
  const entries: { path: string; data: Buffer }[] = [
    { path: "manifest.json", data: manifestBytes },
  ];
  for (const doc of manifest.documents) {
    entries.push({ path: doc.path, data: await readFile(join(workspacePath, doc.path)) });
  }
  for (const asset of manifest.assets) {
    entries.push({ path: asset.path, data: await readFile(join(workspacePath, asset.path)) });
  }
  for (const artifact of manifest.artifacts) {
    entries.push({ path: artifact.path, data: await readFile(join(workspacePath, artifact.path)) });
  }
  await writePcpubArchive(options.out, entries);

  // Final self-check: reopen the packed archive and verify structure + hashes.
  const archive = await openPcpubArchive(options.out, limits);
  try {
    const parsed = parseManifest(await archive.readBytes("manifest.json"), limits);
    archive.assertExactSet(declaredPaths(parsed));
    for (const descriptor of [...parsed.documents, ...parsed.assets, ...parsed.artifacts]) {
      const bytes = await archive.readBytes(descriptor.path);
      if (sha256Hex(bytes) !== descriptor.sha256 || bytes.length !== descriptor.size) {
        throw new PcpubError(
          "PCPUB_CHECKSUM_MISMATCH",
          `packed entry "${descriptor.path}" does not match its manifest descriptor`,
          { path: descriptor.path },
        );
      }
    }
  } finally {
    await archive.close();
  }

  const { stat: statFile } = await import("node:fs/promises");
  const archiveBytes = await readFile(options.out);
  return {
    path: options.out,
    bundleId: manifest.bundle_id,
    manifest,
    archiveSha256: sha256Hex(archiveBytes),
    payloadDigest: logicalPayloadDigest(manifestBytes, manifest, sha256Hex),
  };
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  // Document kinds (Media spec §4 registry); the ingest re-sniffs bytes
  // authoritatively, but a wrong declared type (octet-stream) is rejected
  // as MEDIA_MIME_MISMATCH before that check matters.
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

/** Extension-based declared media_type; the server re-sniffs authoritatively. */
export function mediaTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return MEDIA_EXTENSIONS[ext] ?? "application/octet-stream";
}
