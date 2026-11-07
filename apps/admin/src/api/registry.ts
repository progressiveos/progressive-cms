// Community Registry admin API (Community Registry plan §4): catalog,
// package cards, publishing of installed community skills, one-click
// install of approved packages and engine-release updates. All calls ride
// the shared session/CSRF client; the server stays the SSRF guard and the
// authority for the security-check pipeline.
import { apiGet, apiPost } from "./client.js";

export type RegistryPackageKind = "skill" | "extension" | "theme";
export type RegistryCheckStatus = "pending" | "approved" | "rejected";

export interface RegistryPackageIndexItem {
  readonly id: string;
  readonly kind: RegistryPackageKind;
  readonly version: string;
  readonly summary: string;
  readonly author: string;
  readonly price: number | null;
  readonly check: RegistryCheckStatus;
  readonly updated: string;
  /** Direct artifact URL on the registry (approved packages only). */
  readonly download_url: string | null;
}

export interface RegistryRelease {
  readonly version: string;
  readonly artifact: string;
  readonly sha256: string;
  readonly notes: string;
}

export interface RegistryIndex {
  readonly packages: readonly RegistryPackageIndexItem[];
  readonly releases: readonly RegistryRelease[];
  readonly configured: boolean;
}

export interface RegistryPackageDetail {
  readonly id: string;
  readonly kind: RegistryPackageKind;
  readonly version: string;
  readonly summary: string;
  readonly author: string;
  readonly price: number | null;
  readonly check: RegistryCheckStatus;
  readonly description_md: string;
}

export interface RegistryPublishResult {
  readonly published: boolean;
  readonly id: string;
  readonly check: RegistryCheckStatus;
}

/** Same shape as the skills installer result ({id, version}). */
export interface RegistryInstallResult {
  readonly id: string;
  readonly version: string;
}

export interface RegistryUpdateOutcome {
  readonly id: string | null;
  readonly status: "RUNNING" | "SUCCEEDED" | "FAILED" | "NO_OP";
  readonly request_id?: string;
  readonly product_id?: string;
  readonly from_version: string | null;
  readonly to_version: string | null;
  readonly failure_code: string | null;
  readonly backup_warnings?: readonly string[];
}

export interface RegistryUpdateResult {
  readonly staged: string | null;
  readonly sha256: string | null;
  readonly update: RegistryUpdateOutcome;
}

/** GET /registry/update-status — the async-apply arbiter: the outcome lives
 * in pcms_update_history on the server, never in a proxied POST body. */
export interface RegistryUpdateStatus {
  readonly current_version: string;
  readonly update: RegistryUpdateOutcome | null;
}

export const fetchUpdateStatus = (
  productId = "progressive.cms",
  requestId?: string,
): Promise<RegistryUpdateStatus> => {
  const query = new URLSearchParams({ product_id: productId });
  if (requestId) query.set("request_id", requestId);
  return apiGet<RegistryUpdateStatus>(`/registry/update-status?${query}`);
};

export interface RegistryExtensionPlan {
  readonly outcome: "READY" | "BLOCKED";
  readonly no_op: boolean;
  readonly new_permissions: readonly string[];
  readonly issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly blocking: boolean;
  }[];
}

export const planRegistryExtension = (
  productId: string,
  version: string,
): Promise<RegistryExtensionPlan> =>
  apiPost<RegistryExtensionPlan>("/update/preflight", { product_id: productId, version });

export const fetchRegistryIndex = (): Promise<RegistryIndex> =>
  apiGet<RegistryIndex>("/registry/index");

export const fetchRegistryPackage = (id: string): Promise<RegistryPackageDetail> =>
  apiGet<RegistryPackageDetail>(`/registry/packages/${encodeURIComponent(id)}`);

/** Publishes an installed community skill (zip is assembled server-side). */
export const publishSkillToRegistry = (skillId: string): Promise<RegistryPublishResult> =>
  apiPost<RegistryPublishResult>(`/registry/publish/${encodeURIComponent(skillId)}`);

/** Installs an approved package through the existing skills installer. */
export const installRegistryPackage = (url: string): Promise<RegistryInstallResult> =>
  apiPost<RegistryInstallResult>("/registry/install", { url });

export interface RegistryInstanceInfo {
  readonly instance_code: string;
  readonly account_token_set?: boolean;
}

/** Stable per-instance registry identity (generated server-side on first
 * read; NOT secret — the owner types it into the account-area claim form). */
export const fetchRegistryInstance = (): Promise<RegistryInstanceInfo> =>
  apiGet<RegistryInstanceInfo>("/registry/instance");

export interface RegistryInstanceStatus {
  readonly status: "unknown" | "unclaimed" | "pending" | "confirmed";
  readonly instance_code?: string;
  readonly account_email?: string;
}

export const fetchRegistryInstanceStatus = (): Promise<RegistryInstanceStatus> =>
  apiGet<RegistryInstanceStatus>("/registry/instance/status");

/** Registry v2 binding phase 2: confirm the pending claim and store the
 * issued per-instance token (encrypted server-side, never displayed). */
export const confirmRegistryInstance = (): Promise<{
  readonly bound: boolean;
  readonly account_email: string;
}> => apiPost<{ bound: boolean; account_email: string }>("/registry/instance/confirm", {});

export const applyRegistryUpdate = (
  version: string,
  productId = "progressive.cms",
  approvedPermissions: readonly string[] = [],
): Promise<RegistryUpdateResult> =>
  apiPost<RegistryUpdateResult>("/registry/apply-update", {
    version,
    product_id: productId,
    approved_permissions: approvedPermissions,
    wait: false,
  });

// Account-token API routes (POST/DELETE /registry/account-token) remain
// available as an API-level fallback but have no admin UI (owner 2026-10-06:
// the binding alone opens the catalog — the token field confused operators).
