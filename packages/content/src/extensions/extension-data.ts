// Unknown extension namespace preservation (PCMS-CONT-T023; Content spec §68).
//
// A schema-aware round-trip must not destroy extension data the current
// component does not own. Extension payloads live in a dedicated root
// namespace on the fields payload:
//
//   { "title": "…", "extensions": { "vendor.module": { … } } }
//
// Unknown namespaces are carried through read/edit/write cycles verbatim as
// long as they respect the safety bounds; a namespace explicitly provided by
// the writer wins over the stored one.
export const EXTENSIONS_KEY = "extensions";

/** Hard safety bound for the total extensions payload (Content spec §68/§71). */
export const MAX_EXTENSIONS_BYTES = 262_144;

const NAMESPACE_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

export interface ExtensionIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export function isExtensionNamespace(namespace: string): boolean {
  return NAMESPACE_RE.test(namespace);
}

/** Extracts the extension namespace map from a fields payload (may be empty). */
export function extractExtensions(fields: unknown): Record<string, unknown> {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return {};
  const extensions = (fields as Record<string, unknown>)[EXTENSIONS_KEY];
  if (typeof extensions !== "object" || extensions === null || Array.isArray(extensions)) return {};
  return extensions as Record<string, unknown>;
}

/** Structural/safety validation of the extensions namespace map. */
export function extensionIssues(fields: unknown): ExtensionIssue[] {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return [];
  const extensions = (fields as Record<string, unknown>)[EXTENSIONS_KEY];
  if (extensions === undefined) return [];
  if (typeof extensions !== "object" || extensions === null || Array.isArray(extensions)) {
    return [
      {
        code: "EXTENSION_MALFORMED",
        path: `/${EXTENSIONS_KEY}`,
        message: "extensions must be an object of namespace → payload",
      },
    ];
  }
  const issues: ExtensionIssue[] = [];
  const map = extensions as Record<string, unknown>;
  for (const namespace of Object.keys(map)) {
    if (!isExtensionNamespace(namespace)) {
      issues.push({
        code: "EXTENSION_NAMESPACE_INVALID",
        path: `/${EXTENSIONS_KEY}/${namespace}`,
        message: `namespace "${namespace}" must be lowercase with dots/dashes/digits`,
      });
    }
  }
  let serializedSize: number;
  try {
    serializedSize = JSON.stringify(map).length;
  } catch {
    return [
      ...issues,
      {
        code: "EXTENSION_NOT_SERIALIZABLE",
        path: `/${EXTENSIONS_KEY}`,
        message: "extensions payload must be JSON-serializable",
      },
    ];
  }
  if (serializedSize > MAX_EXTENSIONS_BYTES) {
    issues.push({
      code: "EXTENSION_TOO_LARGE",
      path: `/${EXTENSIONS_KEY}`,
      message: `extensions exceed the safety limit (${MAX_EXTENSIONS_BYTES} bytes)`,
    });
  }
  return issues;
}

/**
 * Merges extension namespaces across an edit cycle: namespaces the writer
 * explicitly provided win; all other namespaces from the original payload are
 * preserved verbatim. Non-destructive by construction (Content spec §68).
 */
export function mergeExtensions<T>(original: unknown, updated: T): T {
  const originalExtensions = extractExtensions(original);
  const updatedExtensions = extractExtensions(updated);
  const merged: Record<string, unknown> = { ...originalExtensions, ...updatedExtensions };
  const updatedRecord = updated as Record<string, unknown> | null;
  if (updatedRecord === null || typeof updatedRecord !== "object" || Array.isArray(updatedRecord)) {
    return updated;
  }
  if (Object.keys(merged).length === 0) {
    // Drop an empty extensions envelope the writer did not provide.
    if (EXTENSIONS_KEY in updatedRecord && updatedExtensions === undefined) {
      const { [EXTENSIONS_KEY]: _drop, ...rest } = updatedRecord;
      void _drop;
      return rest as T;
    }
    return updated;
  }
  return { ...updatedRecord, [EXTENSIONS_KEY]: merged } as T;
}
