// Path normalization for stored routes (PCMS-NAV-T008; Navigation spec
// §24–§26/§45). Storage accepts only canonical, conservative forms: no
// percent-encodings (routes are literal decoded strings), no backslashes,
// no control characters, no empty or dot segments. Request-path handling
// (redirects for the alternate forms) is the resolution layer's job.
import { RoutingError } from "./errors.js";
import type { RoutePathPolicy } from "./policy.js";

// % (encoding), backslash, C0 controls and DEL are never valid in stored paths.
function hasUnsafeChar(path: string): boolean {
  for (const ch of path) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "%" || ch === "\\" || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates and normalizes a content route path for storage:
 * lowercase (policy), single leading slash, trailing slash per policy
 * except root and policy-allowed extensions (e.g. preserved `.html`).
 * Throws ROUTE_INVALID_ENCODING / ROUTE_PATH_INVALID on unsafe input.
 */
export function normalizeStoredPath(rawPath: string, policy: RoutePathPolicy): string {
  if (rawPath.length === 0 || rawPath.length > 2048) {
    throw new RoutingError("ROUTE_PATH_INVALID", `path must be 1..2048 characters`);
  }
  if (hasUnsafeChar(rawPath)) {
    throw new RoutingError(
      "ROUTE_INVALID_ENCODING",
      `stored paths must not contain encodings or control characters`,
      {
        details: { path: rawPath },
      },
    );
  }
  if (!rawPath.startsWith("/")) {
    throw new RoutingError("ROUTE_PATH_INVALID", `path must start with "/"`, {
      details: { path: rawPath },
    });
  }
  const segments = rawPath.split("/");
  // segments[0] is "" (leading slash); a trailing slash adds a final "" —
  // both are structural, only empty segments *between* content are invalid.
  const content = rawPath.endsWith("/") ? segments.slice(1, -1) : segments.slice(1);
  for (const segment of content) {
    if (segment === "") {
      throw new RoutingError("ROUTE_PATH_INVALID", `empty path segments are not allowed`, {
        details: { path: rawPath },
      });
    }
    if (segment === "." || segment === "..") {
      throw new RoutingError("ROUTE_PATH_INVALID", `dot segments are not allowed`, {
        details: { path: rawPath },
      });
    }
  }
  let path = rawPath;
  if (policy.lowercase) path = path.toLowerCase();
  if (path !== "/") {
    const withoutSlash = path.endsWith("/") ? path.slice(0, -1) : path;
    const extension = withoutSlash.slice(withoutSlash.lastIndexOf("."));
    const hasAllowedExtension = policy.allowedExtensions.some(
      (ext) => ext.length > 0 && withoutSlash.endsWith(ext),
    );
    if (hasAllowedExtension && extension.includes("/")) {
      throw new RoutingError("ROUTE_PATH_INVALID", `extension must sit on the last segment`, {
        details: { path },
      });
    }
    const lastSegment = withoutSlash.slice(withoutSlash.lastIndexOf("/") + 1);
    const dot = lastSegment.lastIndexOf(".");
    if (dot > 0 && !policy.allowedExtensions.includes(lastSegment.slice(dot).toLowerCase())) {
      // Extensions are policy (spec §24/§26): new sites reject `.html`
      // outright; legacy sites allow exactly the extensions they declare.
      throw new RoutingError("ROUTE_PATH_INVALID", `path extension is not allowed by policy`, {
        details: { path, extension: lastSegment.slice(dot) },
      });
    }
    if (hasAllowedExtension) {
      // Legacy extension form is canonical WITHOUT the trailing slash.
      path = withoutSlash;
    } else if (policy.trailingSlash && !path.endsWith("/")) {
      path = `${path}/`;
    }
  }
  return path;
}

/**
 * Decides how to serve a request path under the site policy (spec §25/§45):
 * the canonical form is the normalized stored form; any alternate
 * representation (`/foo`, uppercase, `/foo.html/`) is a permanent redirect
 * to the canonical form, never a silent alias — one URL, one canonical path.
 * Purely syntactic: existence of the route is checked by the caller.
 */
export type RequestPathDecision =
  | { readonly kind: "canonical"; readonly path: string }
  | { readonly kind: "redirect"; readonly statusCode: 301; readonly location: string }
  | { readonly kind: "invalid"; readonly code: "ROUTE_INVALID_ENCODING" | "ROUTE_PATH_INVALID" };

export function decideRequestPath(rawPath: string, policy: RoutePathPolicy): RequestPathDecision {
  try {
    const canonical = normalizeStoredPath(rawPath, policy);
    if (canonical === rawPath) return { kind: "canonical", path: canonical };
    return { kind: "redirect", statusCode: 301, location: canonical };
  } catch (err) {
    const code = err instanceof RoutingError ? err.code : "ROUTE_PATH_INVALID";
    return {
      kind: "invalid",
      code: code === "ROUTE_INVALID_ENCODING" ? "ROUTE_INVALID_ENCODING" : "ROUTE_PATH_INVALID",
    };
  }
}
