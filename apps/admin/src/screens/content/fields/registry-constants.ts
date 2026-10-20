// The v1 field type vocabulary (Content spec field registry, 23 types).
// Kept DOM/React-free so both the browser registry and the node test suite
// can consume it; the server-side canonical list is pinned by tests/api.
export const FIELD_TYPES_V1: readonly string[] = [
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
];
