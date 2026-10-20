// Session cookie contract (PCMS-AUTH-T008; Auth spec §29).
//
// Preferred shape: `__Host-pcms_session` — the __Host- prefix forces Secure,
// Path=/ and the absence of a Domain attribute at the browser level. The
// serializer here is transport-agnostic (Fastify adapters consume it in the
// composition root); validation is fail-secure: a __Host--prefixed name with
// secure=false is a configuration error, never silently downgraded.
// SameSite is defense in depth — CSRF protection (spec §30) never relies on
// it alone.

export interface SessionCookieConfig {
  name: string;
  secure: boolean;
  sameSite: "Lax" | "Strict";
}

export const DEFAULT_SESSION_COOKIE: SessionCookieConfig = {
  name: "__Host-pcms_session",
  secure: true,
  sameSite: "Lax",
};

export class CookieConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieConfigError";
  }
}

export function assertValidCookieConfig(config: SessionCookieConfig): void {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(config.name)) {
    throw new CookieConfigError(`invalid cookie name "${config.name}"`);
  }
  if (config.name.startsWith("__Host-")) {
    if (!config.secure) {
      throw new CookieConfigError(
        `"__Host-" cookies require Secure; use a non-prefixed name for plain-HTTP development`,
      );
    }
  }
}

const TOKEN_SAFE_RE = /^[\w-]{1,512}$/;

/** Serializes the Set-Cookie header value. */
export function serializeSessionCookie(
  config: SessionCookieConfig,
  rawToken: string,
  maxAgeSeconds: number,
): string {
  assertValidCookieConfig(config);
  if (!TOKEN_SAFE_RE.test(rawToken)) {
    throw new CookieConfigError("session token contains characters a cookie cannot carry");
  }
  const parts = [
    `${config.name}=${rawToken}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${config.sameSite}`,
  ];
  if (config.secure) parts.push("Secure");
  // No Domain attribute: host-only cookies, required for __Host-.
  return parts.join("; ");
}

/** Cleared cookie for logout responses. */
export function serializeClearedSessionCookie(config: SessionCookieConfig): string {
  return serializeSessionCookie(config, "cleared", 0);
}

/** Extracts the raw session token from a Cookie header, if present. */
export function parseSessionCookie(
  header: string | undefined | null,
  config: SessionCookieConfig,
): string | null {
  if (header === undefined || header === null || header === "") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== config.name) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_SAFE_RE.test(value) ? value : null;
  }
  return null;
}
