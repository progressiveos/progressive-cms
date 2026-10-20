import type { ComponentType } from "react";

export interface AdminNavItem {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly permission?: string;
  readonly order?: number;
}

export interface AdminNavSection {
  readonly id: string;
  readonly title: string;
  readonly items: readonly AdminNavItem[];
}

export interface AdminRoute {
  readonly pattern: string;
  readonly title: string;
  readonly permission?: string;
  readonly load: () => Promise<{ readonly default: ComponentType<Record<string, string>> }>;
}

/** Options for the host's current-session JSON client. Raw uploads reuse
 * the same client; rawBody takes precedence over body. */
export interface AdminRequestOptions {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rawBody?: NonNullable<RequestInit["body"]>;
}

export interface AdminContributionApi {
  readonly extensionId: string;
  /** Normalized path relative to /api/v1 (e.g. /extensions/example.shop/operations/save).
   * Authentication lifecycle and credentials remain owned by the host. */
  request<T>(method: string, path: string, options?: AdminRequestOptions): Promise<T>;
  readonly t: (key: string, vars?: Record<string, string | number>) => string;
  nav(section: AdminNavSection): void;
  route(route: AdminRoute): void;
  translations(fragment: {
    readonly ru: Record<string, string>;
    readonly en: Record<string, string>;
  }): void;
}

export interface ExtensionContribution {
  readonly extensionId: string;
  readonly register: (api: AdminContributionApi) => Promise<void> | void;
}
