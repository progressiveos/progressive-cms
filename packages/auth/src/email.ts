// Email normalization baseline (PCMS-AUTH-T002; Auth spec §6).
//
// Do NOT perform unsafe provider-specific normalization: dots and plus-tags
// in the local part are significant for many providers and are never removed.
// Baseline only: trim, canonical (lowercase) domain case, syntax validation,
// length caps. The normalized form is the unique login identifier; the
// display form preserves the address exactly as provided.

export class InvalidEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEmailError";
  }
}

const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/; // printable, no spaces
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Returns the normalized representation (trim + lowercase domain + lowercase
 * local part) or throws InvalidEmailError. Local-part lowercasing is the
 * chosen product policy (Auth spec §6 "chosen library/policy"): RFC 5321
 * permits case-sensitive local parts, but no mainstream provider treats them
 * that way and case-differentiated duplicates would break login lookups.
 * Total length ≤ 254, local part ≤ 64, domain ≤ 253 — the RFC 5321
 * operational limits.
 */
export function normalizeEmail(input: string): string {
  const trimmed = input.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    throw new InvalidEmailError("email must contain a local part and a domain");
  }
  const local = trimmed.slice(0, at).toLowerCase();
  const domain = trimmed.slice(at + 1).toLowerCase();

  if (trimmed.length > 254) throw new InvalidEmailError("email exceeds 254 characters");
  if (local.length > 64) throw new InvalidEmailError("email local part exceeds 64 characters");
  if (domain.length > 253) throw new InvalidEmailError("email domain exceeds 253 characters");
  if (local.length > 64 || !LOCAL_RE.test(local)) {
    throw new InvalidEmailError("email local part contains unsupported characters");
  }
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    throw new InvalidEmailError("email local part has invalid dot placement");
  }

  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !LABEL_RE.test(label) || label.length > 63)) {
    throw new InvalidEmailError("email domain is not a sequence of valid DNS labels");
  }
  return `${local}@${domain}`;
}
