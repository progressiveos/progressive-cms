// Stable .pcpub diagnostic codes (ADR-0014, API spec §81; owner task §86).
// Codes are contract — messages may evolve. Families group by concern;
// every failure surfaces as a typed code, never prose-only.

export type PcpubErrorCode =
  // archive (physical safety)
  | "PCPUB_ARCHIVE_UNREADABLE"
  | "PCPUB_ARCHIVE_UNSUPPORTED_VERSION"
  | "PCPUB_ARCHIVE_ENCRYPTED_ENTRY"
  | "PCPUB_ARCHIVE_UNSUPPORTED_COMPRESSION"
  | "PCPUB_ARCHIVE_NONREGULAR_ENTRY"
  | "PCPUB_ARCHIVE_DUPLICATE_PATH"
  | "PCPUB_ARCHIVE_UNSAFE_PATH"
  | "PCPUB_ARCHIVE_UNDECLARED_ENTRY"
  | "PCPUB_ARCHIVE_MISSING_ENTRY"
  | "PCPUB_ARCHIVE_TOO_LARGE"
  | "PCPUB_ARCHIVE_ENTRY_TOO_LARGE"
  // manifest
  | "PCPUB_MANIFEST_INVALID"
  | "PCPUB_MANIFEST_MISMATCH"
  | "PCPUB_MANIFEST_TOO_LARGE"
  // paths (workspace-side)
  | "PCPUB_PATH_INVALID"
  | "PCPUB_PATH_CASE_COLLISION"
  // checksums / sizes
  | "PCPUB_CHECKSUM_MISMATCH"
  | "PCPUB_SIZE_MISMATCH"
  // documents (PCMD)
  | "PCPUB_DOCUMENT_INVALID"
  | "PCPUB_DOCUMENT_UNSUPPORTED_VERSION"
  | "PCPUB_DOCUMENT_REF_UNRESOLVED"
  | "PCPUB_DOCUMENT_MEDIA_REF_FORBIDDEN"
  // compatibility
  | "PCPUB_COMPAT_UNSUPPORTED_BLOCK_VERSION"
  | "PCPUB_COMPAT_UNSUPPORTED_CONTRACT"
  | "PCPUB_COMPAT_CONTENT_TYPE_UNKNOWN"
  // media
  | "PCPUB_MEDIA_UNSUPPORTED_TYPE"
  | "PCPUB_MEDIA_MIME_MISMATCH"
  | "PCPUB_MEDIA_UNAUTHORIZED_REF"
  // targets / CAS
  | "PCPUB_EXTERNAL_ENTRY_INVALID"
  | "PCPUB_EXTERNAL_ENTRY_NOT_FOUND"
  | "PCPUB_EXTERNAL_ENTRY_UNPUBLISHED"
  | "PCPUB_EXTERNAL_ENTRY_LOCALE_UNKNOWN"
  | "PCPUB_CONFLICT_EXTERNAL_ENTRY_CHANGED"
  | "PCPUB_TARGET_NOT_FOUND"
  | "PCPUB_TARGET_BASE_REVISION_NOT_FOUND"
  | "PCPUB_TARGET_BASE_REVISION_NOT_CURRENT"
  // conflicts & policy
  | "PCPUB_CONFLICT_STALE_BASE"
  | "PCPUB_AUTH_INSUFFICIENT_SCOPE"
  // idempotency
  | "PCPUB_IDEMPOTENCY_BUNDLE_ID_REUSED"
  // internal
  | "PCPUB_INTERNAL_FAILURE";

/** One typed finding; `path` points at the archive/workspace location. */
export interface PcpubDiagnostic {
  readonly code: PcpubErrorCode;
  readonly path: string;
  readonly message: string;
}

export class PcpubError extends Error {
  readonly code: PcpubErrorCode;
  readonly path: string;
  readonly diagnostics: readonly PcpubDiagnostic[];

  constructor(
    code: PcpubErrorCode,
    message: string,
    options?: { path?: string; diagnostics?: readonly PcpubDiagnostic[]; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PcpubError";
    this.code = code;
    this.path = options?.path ?? "";
    this.diagnostics = options?.diagnostics ?? [];
  }
}

/** Mutable collector for strict validation passes. */
export class DiagnosticCollector {
  private readonly items: PcpubDiagnostic[] = [];

  add(code: PcpubDiagnostic["code"], path: string, message: string): void {
    this.items.push({ code, path, message });
  }

  get all(): readonly PcpubDiagnostic[] {
    return this.items;
  }

  get ok(): boolean {
    return this.items.length === 0;
  }
}
