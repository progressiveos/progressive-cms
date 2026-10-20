// Content type descriptor loading from the deployment-owned versioned JSON
// (Core config schema `content.typesFile`). An invalid descriptor file fails
// startup — neither web nor worker ever invent or partially load a business
// schema (unknown types would make rendering and derived search documents
// undecidable, fail-secure).
import { readFileSync } from "node:fs";
import { ContentError } from "../errors.js";
import type { ContentTypeDefinition } from "./content-type.js";

export function loadContentTypeDefinitions(file: string): ContentTypeDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ContentError("SCHEMA_INVALID", `content types file "${file}" is not valid JSON`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new ContentError("SCHEMA_INVALID", `content types file "${file}" must hold an array`);
  }
  return parsed as ContentTypeDefinition[];
}
