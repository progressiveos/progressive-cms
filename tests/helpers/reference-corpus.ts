// Loader for the reference Content Type corpus (PCMS-CONT-T025).
// Shared by the T025 fixture test, the T026 compatibility corpus and the
// T028 integration suite — one source of truth for the five reference
// Content Types and their edge-case payloads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ContentTypeDefinition,
  type ContentTypeRegistry,
  createContentTypeRegistry,
  type LoadedContentType,
} from "@pcms/content";

export interface ReferenceFixture {
  readonly name: string;
  readonly contentType: string;
  readonly expect: "valid" | "invalid";
  readonly level: "draft" | "publish";
  readonly expectedCode?: string;
  readonly fields: Record<string, unknown>;
}

export interface ReferenceCorpus {
  readonly registry: ContentTypeRegistry;
  readonly schemas: ReadonlyMap<string, LoadedContentType>;
  readonly fixtures: readonly ReferenceFixture[];
}

interface CorpusFile {
  contentTypes: ContentTypeDefinition[];
  fixtures: ReferenceFixture[];
}

let cached: ReferenceCorpus | null = null;

export function loadReferenceCorpus(): ReferenceCorpus {
  if (cached !== null) return cached;
  const raw = JSON.parse(
    readFileSync(join("fixtures", "content", "reference-content-types.json"), "utf8"),
  ) as CorpusFile;
  const registry = createContentTypeRegistry();
  for (const definition of raw.contentTypes) {
    registry.registerContentType(definition);
  }
  const schemas = new Map<string, LoadedContentType>();
  for (const schema of registry.listContentTypes()) {
    if (!schemas.has(schema.key)) schemas.set(schema.key, schema);
  }
  cached = { registry, schemas, fixtures: raw.fixtures };
  return cached;
}
