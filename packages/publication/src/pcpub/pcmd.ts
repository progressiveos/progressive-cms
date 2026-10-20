// PCMD v1 — Progressive Content Markdown (ADR-0014 §3; Content spec §95).
//
// The authoring format agents and humans write; it serializes INTO the
// canonical bundle payload { fields, blocks } and introduces no new content
// semantics. Structure: YAML front matter + a body of `:::block type@ver`
// fences whose payloads are YAML documents. Parsing is strict: unknown keys,
// bad versions or malformed fences are errors — never warnings.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PcpubError } from "./diagnostics.js";

export const PCMD_VERSION = 1;

export const EXTERNAL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface PcmdBlock {
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: Record<string, unknown>;
}

export interface PcmdRoute {
  readonly path: string;
  readonly frees_path?: string;
  readonly site_key?: string;
}

export interface PcmdDocument {
  readonly operation: "create" | "update";
  readonly externalId: string;
  readonly contentType: string;
  readonly locale?: string;
  /** Update-only CAS pair (create never carries them). */
  readonly targetEntryId?: string;
  readonly baseRevisionId?: string;
  readonly fields: Record<string, unknown>;
  readonly seo?: Record<string, unknown>;
  readonly route?: PcmdRoute;
  readonly blocks: readonly PcmdBlock[];
}

const FRONT_MATTER_KEYS = new Set([
  "pcmd_version",
  "operation",
  "external_id",
  "content_type",
  "locale",
  "target_entry_id",
  "base_revision_id",
  "fields",
  "seo",
  "route",
]);

const BLOCK_TYPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(\.[a-zA-Z0-9][a-zA-Z0-9_-]*){0,4}$/;
const STABLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FENCE_OPEN = /^:::block\s+([^\s@]+)@(\d+)\s*$/;

function fail(
  path: string,
  message: string,
  code: "PCPUB_DOCUMENT_INVALID" | "PCPUB_DOCUMENT_UNSUPPORTED_VERSION" = "PCPUB_DOCUMENT_INVALID",
): never {
  throw new PcpubError(code, message, { path });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Splits `---\\n…\\n---` front matter off the body. Returns null if absent. */
function splitFrontMatter(text: string): { front: string; body: string } {
  if (!text.startsWith("---")) return { front: "", body: text };
  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1) fail("", "front matter is not terminated");
  const close = text.indexOf("\n---", firstNewline);
  if (close === -1) fail("", "front matter is not terminated");
  const rest = text.slice(close + 4);
  return {
    front: text.slice(firstNewline + 1, close),
    body: rest.startsWith("\n") ? rest.slice(1) : rest,
  };
}

function parseFrontMatter(front: string, path: string): Record<string, unknown> {
  if (front.trim().length === 0) fail(path, "front matter is required");
  let parsed: unknown;
  try {
    parsed = parseYaml(front, { strict: true, uniqueKeys: true });
  } catch (cause) {
    throw new PcpubError("PCPUB_DOCUMENT_INVALID", "front matter is not valid YAML", {
      path,
      cause,
    });
  }
  if (!isPlainObject(parsed)) fail(path, "front matter must be a mapping");
  for (const key of Object.keys(parsed)) {
    if (!FRONT_MATTER_KEYS.has(key)) fail(path, `unknown front-matter key "${key}"`);
  }
  return parsed;
}

function parseBlocks(body: string, path: string, maxBlocks: number): PcmdBlock[] {
  const blocks: PcmdBlock[] = [];
  const lines = body.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!.trim();
    if (line.length === 0) {
      index += 1;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open === null) {
      fail(path, `expected a :::block fence, got "${line.slice(0, 60)}"`);
    }
    const type = open![1]!;
    const schemaVersion = Number(open![2]);
    if (!BLOCK_TYPE_PATTERN.test(type) || type.endsWith(".") || type.startsWith(".")) {
      fail(path, `invalid block type "${type}"`);
    }
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      fail(path, `invalid schema version for block "${type}"`);
    }
    const payloadLines: string[] = [];
    index += 1;
    let closed = false;
    while (index < lines.length) {
      if (lines[index]!.trim() === ":::") {
        closed = true;
        index += 1;
        break;
      }
      payloadLines.push(lines[index] ?? "");
      index += 1;
    }
    if (!closed) fail(path, `block "${type}" fence is not closed`);
    let payload: unknown = {};
    const payloadText = payloadLines.join("\n").trim();
    if (payloadText.length > 0) {
      try {
        payload = parseYaml(payloadText, { strict: true, uniqueKeys: true });
      } catch (cause) {
        throw new PcpubError(
          "PCPUB_DOCUMENT_INVALID",
          `payload of block "${type}" is not valid YAML`,
          { path, cause },
        );
      }
    }
    if (!isPlainObject(payload)) {
      fail(path, `payload of block "${type}" must be a mapping`);
    }
    blocks.push({ type, schemaVersion, payload });
    if (blocks.length > maxBlocks) {
      fail(path, `more than ${maxBlocks} blocks`);
    }
  }
  return blocks;
}

/** Parses one *.pcmd document (strict; throws PcpubError). */
export function parsePcmd(text: string, path: string, maxBlocks = 200): PcmdDocument {
  const { front, body } = splitFrontMatter(text);
  const meta = parseFrontMatter(front, path);

  if (meta["pcmd_version"] !== PCMD_VERSION) {
    fail(
      path,
      `only pcmd_version ${PCMD_VERSION} is supported`,
      "PCPUB_DOCUMENT_UNSUPPORTED_VERSION",
    );
  }
  const operation = meta["operation"];
  if (operation !== "create" && operation !== "update") {
    fail(path, 'operation must be "create" or "update"');
  }
  const externalId = meta["external_id"];
  if (typeof externalId !== "string" || !EXTERNAL_ID_PATTERN.test(externalId)) {
    fail(path, "external_id must match [a-z0-9][a-z0-9_-]{0,63}");
  }
  const contentType = meta["content_type"];
  if (typeof contentType !== "string" || contentType.length === 0 || contentType.length > 64) {
    fail(path, "content_type is required");
  }
  let locale: string | undefined;
  if (meta["locale"] !== undefined) {
    if (
      typeof meta["locale"] !== "string" ||
      !/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(meta["locale"])
    ) {
      fail(path, "locale must be a BCP-47-ish language tag");
    }
    locale = meta["locale"];
  }
  let targetEntryId: string | undefined;
  let baseRevisionId: string | undefined;
  if (operation === "update") {
    for (const key of ["target_entry_id", "base_revision_id"] as const) {
      const value = meta[key];
      if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
        fail(path, `update requires a valid ${key}`);
      }
      if (key === "target_entry_id") targetEntryId = value;
      else baseRevisionId = value;
    }
  } else {
    if (meta["target_entry_id"] !== undefined || meta["base_revision_id"] !== undefined) {
      fail(path, "create documents must not carry target_entry_id/base_revision_id");
    }
  }
  const fields = meta["fields"] ?? {};
  if (!isPlainObject(fields)) fail(path, "fields must be a mapping");
  let seo: Record<string, unknown> | undefined;
  if (meta["seo"] !== undefined) {
    if (!isPlainObject(meta["seo"])) fail(path, "seo must be a mapping");
    seo = meta["seo"];
  }
  let route: PcmdRoute | undefined;
  if (meta["route"] !== undefined) {
    if (!isPlainObject(meta["route"])) fail(path, "route must be a mapping");
    const value = meta["route"];
    if (typeof value["path"] !== "string" || !value["path"].startsWith("/")) {
      fail(path, "route.path must start with /");
    }
    if (value["path"] === "/") fail(path, "route.path / is reserved for the homepage binding");
    route = {
      path: value["path"],
      ...(typeof value["frees_path"] === "string" ? { frees_path: value["frees_path"] } : {}),
      ...(typeof value["site_key"] === "string" ? { site_key: value["site_key"] } : {}),
    };
  }

  const blocks = parseBlocks(body, path, maxBlocks);
  return {
    operation,
    externalId,
    contentType,
    ...(locale === undefined ? {} : { locale }),
    ...(targetEntryId === undefined ? {} : { targetEntryId }),
    ...(baseRevisionId === undefined ? {} : { baseRevisionId }),
    fields,
    ...(seo === undefined ? {} : { seo }),
    ...(route === undefined ? {} : { route }),
    blocks,
  };
}

const FENCED = (block: PcmdBlock): string => {
  const payload = JSON.stringify(block.payload) === "{}" ? "" : `\n${yamlText(block.payload)}`;
  return `:::block ${block.type}@${block.schemaVersion}${payload}\n:::`;
};

/** Deterministic YAML emitter for payloads and front matter. */
function yamlText(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 100 });
}

/** Serializes a document back to PCMD (used by tooling/tests, round-trip). */
export function serializePcmd(document: PcmdDocument): string {
  const meta: Record<string, unknown> = {
    pcmd_version: PCMD_VERSION,
    operation: document.operation,
    external_id: document.externalId,
    content_type: document.contentType,
    ...(document.locale === undefined ? {} : { locale: document.locale }),
    ...(document.targetEntryId === undefined ? {} : { target_entry_id: document.targetEntryId }),
    ...(document.baseRevisionId === undefined ? {} : { base_revision_id: document.baseRevisionId }),
    fields: document.fields,
    ...(document.seo === undefined ? {} : { seo: document.seo }),
    ...(document.route === undefined ? {} : { route: document.route }),
  };
  const front = yamlText(meta).trimEnd();
  const body = document.blocks.map(FENCED).join("\n\n");
  return `---\n${front}\n---\n${body.length > 0 ? `\n${body}\n` : ""}`;
}
