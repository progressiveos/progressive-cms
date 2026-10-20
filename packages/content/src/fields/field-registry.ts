// Field Registry v1 primitives (PCMS-CONT-T005; Content spec §12/§13/§73).
//
// The registry is the controlled extension point for field types: the 23 v1
// types are registered here and new types may only enter through
// `registerFieldType` — never by special-casing strings elsewhere. Discovery
// (`listFieldTypes`) is deterministic so agents/machines can enumerate the
// vocabulary without source-code knowledge (Content spec §73/§81).
import { ContentError } from "../errors.js";

export const FIELD_TYPES_V1 = [
  "string",
  "text",
  "rich_text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "enum",
  "slug",
  "url",
  "email",
  "phone",
  "icon",
  "money",
  "media",
  "media_list",
  "relation",
  "relation_list",
  "object",
  "list",
  "repeater",
  "block_document",
] as const;

/** A registered field type name (one of the v1 types or an approved extension). */
export type FieldTypeName = (typeof FIELD_TYPES_V1)[number] | (string & {});

export interface FieldTypeDescriptor {
  /** Machine-stable type key, lowercase snake_case (Content spec §13). */
  readonly name: string;
  /** Optional human/agent-facing description for discovery surfaces. */
  readonly description?: string;
}

export interface FieldRegistry {
  /** Registers a new field type (controlled extension point). */
  registerFieldType(descriptor: FieldTypeDescriptor): void;
  /** Returns the descriptor or null when the type is not registered. */
  getFieldType(name: string): FieldTypeDescriptor | null;
  /** All registered types, sorted by name — deterministic discovery order. */
  listFieldTypes(): FieldTypeDescriptor[];
  hasFieldType(name: string): boolean;
}

const FIELD_TYPE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Creates a Field Registry pre-populated with the v1 primitive set.
 * Registries are independent instances: extension registrations never leak
 * into other registries or into the built-in v1 set.
 */
export function createFieldRegistry(): FieldRegistry {
  const types = new Map<string, FieldTypeDescriptor>();
  for (const name of FIELD_TYPES_V1) {
    types.set(name, {
      name,
      ...(name === "icon"
        ? {
            description:
              'Font Awesome class string, e.g. "fa-solid fa-shield-halved" (style + single icon name); see GET /discovery/content/icons for the catalog',
          }
        : {}),
    });
  }

  return {
    registerFieldType(descriptor: FieldTypeDescriptor): void {
      const { name } = descriptor;
      if (!FIELD_TYPE_NAME_RE.test(name)) {
        throw new ContentError(
          "FIELD_TYPE_INVALID",
          `field type name "${name}" must be lowercase snake_case (≤64 chars)`,
        );
      }
      if (types.has(name)) {
        throw new ContentError("FIELD_TYPE_EXISTS", `field type "${name}" is already registered`);
      }
      types.set(name, descriptor.description === undefined ? { name } : { ...descriptor });
    },

    getFieldType(name: string): FieldTypeDescriptor | null {
      const descriptor = types.get(name);
      if (descriptor === undefined) return null;
      // Freeze: registry content is a contract surface, not a mutable cache.
      return Object.freeze({ ...descriptor });
    },

    listFieldTypes(): FieldTypeDescriptor[] {
      return [...types.values()]
        .map((descriptor) => Object.freeze({ ...descriptor }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    hasFieldType(name: string): boolean {
      return types.has(name);
    },
  };
}
