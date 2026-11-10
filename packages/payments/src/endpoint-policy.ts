// Provider-owned endpoint policy (CORE-PAYMENTS-ADMIN-CONFIG-01 review R3).
//
// A saved merchant credential must only ever be sent to an endpoint the
// PROVIDER PACKAGE declares. The check is not a form feature: it is applied at
// save time, at readiness/diagnostic time AND at runtime wiring, because a
// document written before this policy existed (or by an older CRUD) can still
// carry an arbitrary apiBase/gatewayUrl — the import must not make such a
// value silently authoritative.
import { PaymentError } from "./errors.js";
import type { PaymentProvider } from "./providers.js";

/** Config keys that select WHERE credentials are sent. */
export const ENDPOINT_CONFIG_KEYS: readonly string[] = ["apiBase", "gatewayUrl"];

export interface EndpointPolicyIssue {
  readonly key: string;
  readonly reason:
    | "not_a_string"
    | "not_absolute_url"
    | "not_http"
    | "embedded_credentials"
    | "origin_not_trusted";
  /** Parsed origin, when the value was a URL at all (never a secret). */
  readonly origin?: string;
  readonly allowed?: readonly string[];
}

/**
 * Non-throwing evaluation of the endpoint policy for one stored config.
 * Empty when every endpoint is acceptable (or absent — the adapter default).
 */
export function endpointPolicyIssues(
  provider: PaymentProvider,
  config: Readonly<Record<string, unknown>>,
): readonly EndpointPolicyIssue[] {
  const issues: EndpointPolicyIssue[] = [];
  for (const key of ENDPOINT_CONFIG_KEYS) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      issues.push({ key, reason: "not_a_string" });
      continue;
    }
    if (value.trim() === "") continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      issues.push({ key, reason: "not_absolute_url" });
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      issues.push({ key, reason: "not_http" });
      continue;
    }
    if (parsed.username !== "" || parsed.password !== "") {
      issues.push({ key, reason: "embedded_credentials" });
      continue;
    }
    const allowed = provider.trustedEndpointOrigins ?? [];
    if (!allowed.includes(parsed.origin)) {
      issues.push({ key, reason: "origin_not_trusted", origin: parsed.origin, allowed });
    }
  }
  return issues;
}

export function describeEndpointIssue(issue: EndpointPolicyIssue): string {
  switch (issue.reason) {
    case "not_a_string":
      return `"${issue.key}" must be a string`;
    case "not_absolute_url":
      return `"${issue.key}" must be an absolute URL`;
    case "not_http":
      return `"${issue.key}" must be an http(s) URL`;
    case "embedded_credentials":
      return `"${issue.key}" must not embed credentials in the URL`;
    case "origin_not_trusted":
      return issue.allowed === undefined || issue.allowed.length === 0
        ? `"${issue.key}" cannot be overridden: the provider package declares no trusted endpoints (update the payment extension)`
        : `"${issue.key}" origin "${issue.origin}" is not a trusted endpoint — allowed: ${issue.allowed.join(", ")}`;
  }
}

/** Runtime/import refusal: typed, and it names the origin that was refused. */
export function assertTrustedEndpoints(
  provider: PaymentProvider,
  config: Readonly<Record<string, unknown>>,
  instanceName: string,
): void {
  const issues = endpointPolicyIssues(provider, config);
  if (issues.length === 0) return;
  throw new PaymentError(
    "PAYMENT_PROVIDER_ENDPOINT_UNTRUSTED",
    `provider instance "${instanceName}" has an endpoint this provider package does not trust: ${issues
      .map(describeEndpointIssue)
      .join(
        "; ",
      )} — no provider call was made; save the connection settings with a trusted endpoint`,
    { details: { issues } },
  );
}

/** Save-time refusal (settings form/API). */
export function assertTrustedEndpointValue(
  provider: PaymentProvider,
  key: string,
  value: unknown,
): void {
  const issues = endpointPolicyIssues(provider, { [key]: value });
  const issue = issues[0];
  if (issue === undefined) return;
  throw new PaymentError("PAYMENT_REQUEST_INVALID", describeEndpointIssue(issue), {
    details: { key: issue.key, origin: issue.origin ?? null, allowed: issue.allowed ?? [] },
  });
}
