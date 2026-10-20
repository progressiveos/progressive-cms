// ContentType registry + versioned schema loader (PCMS-CONT-T011;
// Content spec §8/§9/§10/§11/§73).
//
// A ContentType describes the meaning and structure of data — never HTML/CSS
// (§8/§9). Every schema change that affects serialized payloads registers as a
// new version (`service@1`, `service@2`, §10); loading a specific version is
// deterministic and old versions stay readable for the compatibility corpus.
// Field schemas are validated at registration through the Field Registry
// machinery (PCMS-CONT-T005..T008), so unknown field types cannot enter.
import { ContentError } from "../errors.js";
import { defineObjectSchema, type ObjectFieldSchema } from "../fields/structured-schemas.js";

/**
 * Stable semantic field vocabulary available to most Content Types (§11).
 * A Content Type is never obliged to include all of them.
 */
export const SEMANTIC_FIELD_IDS_V1 = [
  "title",
  "menu_title",
  "h1",
  "slug_hint",
  "intro",
  "hero_image",
  "body",
] as const;

export type BodyPolicyType = "none" | "rich_text" | "block_document";

export interface ContentTypeDefinition {
  /** Stable machine key, e.g. "service" (Content spec §8). */
  readonly key: string;
  /** Schema version, starts at 1 (Content spec §10). */
  readonly version: number;
  readonly title: string;
  readonly description?: string;
  /** Typed semantic field schema (Content spec §9/§12). */
  readonly fields: Record<string, import("../fields/structured-schemas.js").FieldSchema>;
  /** Body/block policy (Content spec §9). */
  readonly bodyPolicy?: BodyPolicyType;
  /** Template hint is presentation metadata, not a binding (§8; Theme binds separately). */
  readonly defaultTemplateHint?: string;
}

/** Fully validated + normalized content type schema ready for discovery. */
export interface LoadedContentType {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly description?: string;
  /** Normalized field schema object (strict field ids/types). */
  readonly fieldSchema: ObjectFieldSchema;
  readonly bodyPolicy: BodyPolicyType;
  readonly defaultTemplateHint?: string;
}

const CONTENT_TYPE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const BODY_POLICIES: readonly BodyPolicyType[] = ["none", "rich_text", "block_document"];

export interface ContentTypeRegistry {
  /** Registers and validates one (key, version) schema (controlled entry). */
  registerContentType(definition: ContentTypeDefinition): LoadedContentType;
  /** Returns the exact requested version, or null. */
  getContentType(key: string, version: number): LoadedContentType | null;
  /** Returns the highest registered version for a key, or null. */
  getLatestContentType(key: string): LoadedContentType | null;
  /** All registered versions, sorted by key then version — deterministic. */
  listContentTypes(): LoadedContentType[];
  /** Distinct keys with their available versions, sorted by key. */
  listContentTypeVersions(): Array<{ key: string; versions: number[] }>;
}

/** Creates a ContentType registry; instances are independent. */
export function createContentTypeRegistry(): ContentTypeRegistry {
  const byKeyVersion = new Map<string, LoadedContentType>();

  return {
    registerContentType(definition: ContentTypeDefinition): LoadedContentType {
      const { key, version, title } = definition;
      if (!CONTENT_TYPE_KEY_RE.test(key)) {
        throw new ContentError(
          "CONTENT_TYPE_KEY_INVALID",
          `content type key "${key}" must be lowercase snake_case (≤64 chars)`,
        );
      }
      if (!Number.isInteger(version) || version < 1) {
        throw new ContentError(
          "CONTENT_TYPE_VERSION_INVALID",
          `content type "${key}": version must be a positive integer`,
        );
      }
      if (title.length === 0) {
        throw new ContentError(
          "CONTENT_TYPE_TITLE_REQUIRED",
          `content type "${key}": title is required`,
        );
      }
      if (definition.bodyPolicy !== undefined && !BODY_POLICIES.includes(definition.bodyPolicy)) {
        throw new ContentError(
          "CONTENT_TYPE_BODY_POLICY_INVALID",
          `content type "${key}": bodyPolicy must be one of ${BODY_POLICIES.join(", ")}`,
        );
      }
      const mapKey = `${key}@${version}`;
      if (byKeyVersion.has(mapKey)) {
        throw new ContentError(
          "CONTENT_TYPE_EXISTS",
          `content type ${mapKey} is already registered`,
        );
      }
      // Field schema validation happens through the structured-schema
      // machinery: invalid field ids/types/limits cannot register.
      const fieldSchema = defineObjectSchema(definition.fields);

      const loaded: LoadedContentType = {
        key,
        version,
        title,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        fieldSchema,
        bodyPolicy: definition.bodyPolicy ?? "none",
        ...(definition.defaultTemplateHint === undefined
          ? {}
          : { defaultTemplateHint: definition.defaultTemplateHint }),
      };
      byKeyVersion.set(mapKey, loaded);
      return loaded;
    },

    getContentType(key: string, version: number): LoadedContentType | null {
      return byKeyVersion.get(`${key}@${version}`) ?? null;
    },

    getLatestContentType(key: string): LoadedContentType | null {
      const versions = [...byKeyVersion.keys()]
        .filter((mapKey) => mapKey.startsWith(`${key}@`))
        .map((mapKey) => Number(mapKey.slice(key.length + 1)))
        .sort((a, b) => b - a);
      const latest = versions[0];
      return latest === undefined ? null : (byKeyVersion.get(`${key}@${latest}`) ?? null);
    },

    listContentTypes(): LoadedContentType[] {
      return [...byKeyVersion.values()].sort((a, b) =>
        a.key === b.key ? a.version - b.version : a.key < b.key ? -1 : 1,
      );
    },

    listContentTypeVersions(): Array<{ key: string; versions: number[] }> {
      const grouped = new Map<string, number[]>();
      for (const loaded of byKeyVersion.values()) {
        const versions = grouped.get(loaded.key) ?? [];
        versions.push(loaded.version);
        grouped.set(loaded.key, versions);
      }
      return [...grouped.entries()]
        .map(([key, versions]) => ({ key, versions: versions.sort((a, b) => a - b) }))
        .sort((a, b) => (a.key < b.key ? -1 : 1));
    },
  };
}
