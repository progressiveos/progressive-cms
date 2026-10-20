// First-party `form` / `quiz` Content Block types (PCMS-FORM-T014; Forms spec
// §25, ADR-0005, Content spec §35). Blocks hold a stable Definition ID — they
// are structured references, never opaque HTML. This module declares the
// descriptors against a *structural* registry interface: @pcms/forms must not
// import @pcms/blocks (L1→L1 is a boundary violation); the composition layer
// (packages/api context) passes the real registry in, exactly like
// registerFirstPartyBlocksV1 does.
import { isStableId } from "@pcms/core";

/** JSON-Schema pattern mirroring core StableId (UUIDv7 canonical). */
const STABLE_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/** Minimal structural slice of the M02 block registry we register against. */
export interface BlockRegistrar {
  registerBlockType(descriptor: {
    readonly typeId: string;
    readonly schemaVersion: number;
    readonly propsSchema: Record<string, unknown>;
    readonly childrenPolicy: "none" | "blocks" | readonly string[];
  }): unknown;
}

export const INTERACTION_BLOCK_TYPES_V1 = ["form", "quiz"] as const;

/** Registers `form@1` and `quiz@1`. Idempotent-unfriendly by design: the
 * registry rejects duplicate type ids loudly. */
export function registerInteractionBlocks(registry: BlockRegistrar): void {
  registry.registerBlockType({
    typeId: "form",
    schemaVersion: 1,
    childrenPolicy: "none",
    propsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        form_definition_id: { type: "string", pattern: STABLE_ID_PATTERN },
        presentation_hint: { type: "string", enum: ["normal", "compact"] },
      },
      required: ["form_definition_id"],
    },
  });
  registry.registerBlockType({
    typeId: "quiz",
    schemaVersion: 1,
    childrenPolicy: "none",
    propsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        quiz_definition_id: { type: "string", pattern: STABLE_ID_PATTERN },
        presentation_hint: { type: "string", enum: ["normal", "compact"] },
      },
      required: ["quiz_definition_id"],
    },
  });
}

/** Runtime guard mirroring the block schema: composition may validate that a
 * form/quiz block references an existing definition before render. */
export function definitionIdOfProps(
  typeId: string,
  props: Readonly<Record<string, unknown>>,
): string | null {
  const key =
    typeId === "form" ? "form_definition_id" : typeId === "quiz" ? "quiz_definition_id" : null;
  if (key === null) return null;
  const value = props[key];
  return typeof value === "string" && isStableId(value) ? value : null;
}
