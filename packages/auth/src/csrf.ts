// CSRF protection for cookie-authenticated mutations (PCMS-AUTH-T009;
// Auth spec §30).
//
// Synchronizer-token strategy, bound to the server-side session: each
// session carries a hashed CSRF token in the database; state-changing
// requests must present the raw token (header/body from the Admin client)
// and only its hash comparison against the owning session authorizes the
// write. SameSite cookies are defense in depth, never the sole control
// (spec §30). All GET endpoints must stay non-state-changing so this scheme
// is complete. Transports additionally reject cross-site Origin headers
// (assertSameOrigin) when an expected origin is configured.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AuthError } from "./errors.js";

/** Fresh synchronizer token (returned to the client once per session). */
export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashCsrfToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Verifies a provided token against the session's stored hash. Missing
 * tokens on state-changing requests are a hard error (AUTH_CSRF_TOKEN_MISSING).
 */
export function assertCsrfToken(
  sessionCsrfHash: string | null,
  provided: string | undefined,
): void {
  if (provided === undefined || provided === "") {
    throw new AuthError("AUTH_CSRF_TOKEN_MISSING", "CSRF token required for this request", 403);
  }
  if (sessionCsrfHash === null) {
    throw new AuthError("AUTH_CSRF_TOKEN_INVALID", "session has no CSRF context", 403);
  }
  const providedHash = Buffer.from(hashCsrfToken(provided), "utf8");
  const storedHash = Buffer.from(sessionCsrfHash, "utf8");
  const ok = providedHash.length === storedHash.length && timingSafeEqual(providedHash, storedHash);
  if (!ok) {
    throw new AuthError("AUTH_CSRF_TOKEN_INVALID", "CSRF token does not match the session", 403);
  }
}

/**
 * Origin check for browser transports: when the client sends an Origin
 * header and the deployment declared an expected origin, a mismatch is a
 * rejected cross-site request. Absent Origin (non-browser clients) passes —
 * the synchronizer token remains mandatory for those requests.
 */
export function assertSameOrigin(
  originHeader: string | undefined,
  expectedOrigin: string | undefined,
): void {
  if (originHeader === undefined || expectedOrigin === undefined) return;
  const normalize = (value: string) => value.replace(/\/+$/, "").toLowerCase();
  if (normalize(originHeader) !== normalize(expectedOrigin)) {
    throw new AuthError("AUTH_CSRF_TOKEN_INVALID", "cross-site origin rejected", 403);
  }
}
