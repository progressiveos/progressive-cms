// PCMD → canonical payload mapping (ADR-0014 §1/§3; Publication spec §83.5).
//
// The single place a parsed PCMD document becomes the canonical bundle
// entry payload: fields pass through; the block fences become one canonical
// BlockDocument (schema_version 1) whose nodes carry DETERMINISTIC stable
// ids derived from (document identity, fence order, type@version) — so
// unchanged blocks keep their identity across packs and submissions.
//
// Layering: this package is L1 and imports no other subsystem. The rich-text
// markdown bridge is injected as a structural parameter (L2 callers wire the
// real @pcms/content adapter).

import { createHash } from "node:crypto";
import { PcpubError } from "./diagnostics.js";
import type { PcmdDocument } from "./pcmd.js";

/** Structural rich-text bridge (L2 wires @pcms/content's markdown adapter). */
export interface PcmdRichTextBridge {
  markdownToRichText(markdown: string):
    | { readonly ok: true; readonly value: unknown }
    | {
        readonly ok: false;
        readonly issues: readonly { readonly code: string; readonly message: string }[];
      };
}

export interface CanonicalBlockNode {
  readonly id: string;
  readonly type: string;
  readonly schema_version: number;
  readonly props: Record<string, unknown>;
}

export interface CanonicalBlockDocument {
  readonly schema_version: 1;
  readonly blocks: readonly CanonicalBlockNode[];
}

/** UUIDv7-shaped id derived from a seed (deterministic, collision-safe). */
export function deterministicBlockId(seed: string): string {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Props whose canonical value is a RichText AST (first-party convention;
 * Content spec §95.2). A MARKDOWN string authored in PCMD is bridged to the
 * canonical AST via the injected adapter; the object form stays valid.
 * Legacy fallback: type-aware resolution (richTextPropsFor) takes precedence;
 * these names predate it and keep older authoring flows working.
 */
const RICH_TEXT_PROPS = new Set(["rich_text", "answer"]);

/**
 * Resolves the rich-text prop NAMES of one block type version from the
 * target's block registry (L2 wires `RegisteredBlockType.richTextProps`).
 */
export type RichTextPropsResolver = (
  typeId: string,
  schemaVersion: number,
) => ReadonlySet<string> | undefined;

/**
 * PCMD authoring sugar (Content spec §95.2): rich-text props authored as
 * MARKDOWN strings are bridged to the canonical RichText AST via the
 * injected adapter. This is the only prop-level translation PCMD performs —
 * everything else maps 1:1.
 */
export function normalizePcmdProps(
  props: Record<string, unknown>,
  context: string,
  bridge?: PcmdRichTextBridge,
  typeRichTextProps?: ReadonlySet<string>,
): Record<string, unknown> {
  if (bridge === undefined) return props;
  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}/${index}`));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = walk(child, `${path}/${key}`);
      }
      return out;
    }
    const key = path.slice(path.lastIndexOf("/") + 1);
    if (
      typeof value === "string" &&
      (RICH_TEXT_PROPS.has(key) || (typeRichTextProps?.has(key) ?? false))
    ) {
      const result = bridge.markdownToRichText(value);
      if (!result.ok) {
        throw new PcpubError(
          "PCPUB_DOCUMENT_INVALID",
          `rich-text markdown rejected at "${path}": ${result.issues.map((issue) => `${issue.code} ${issue.message}`).join("; ")}`,
          { path: context },
        );
      }
      return result.value;
    }
    return value;
  };
  return walk(props, "") as Record<string, unknown>;
}

/** Builds the canonical BlockDocument for a PCMD document. */
export function pcmdBlockDocument(
  document: PcmdDocument,
  documentKey: string,
  bridge?: PcmdRichTextBridge,
  richTextPropsFor?: RichTextPropsResolver,
): CanonicalBlockDocument {
  return {
    schema_version: 1,
    blocks: document.blocks.map((block, index) => ({
      id: deterministicBlockId(`${documentKey}#${index}#${block.type}@${block.schemaVersion}`),
      type: block.type,
      schema_version: block.schemaVersion,
      props: normalizePcmdProps(
        block.payload,
        `${documentKey}#${index}#${block.type}@${block.schemaVersion}`,
        bridge,
        richTextPropsFor?.(block.type, block.schemaVersion),
      ),
    })),
  };
}

/** The canonical bundle entry payload for a PCMD document. */
export function pcmdPayload(
  document: PcmdDocument,
  documentKey: string,
  bridge?: PcmdRichTextBridge,
  richTextPropsFor?: RichTextPropsResolver,
): { readonly fields: Record<string, unknown>; readonly blocks: CanonicalBlockDocument } {
  return {
    fields: document.fields,
    blocks: pcmdBlockDocument(document, documentKey, bridge, richTextPropsFor),
  };
}
