// Password policy (PCMS-AUTH-T005; Auth spec §12–§14).
//
// Length-based, composition-free: minimum 15 Unicode code points, generous
// maximum, spaces and any printable Unicode allowed, no character-class
// rules, no forced rotation. Strength comes from length + common-password
// rejection + rate limiting — never from "must contain a digit" folklore.
// No silent truncation: too-long input is an explicit rejection.
//
// The common-password blocklist is a local corpus (spec §14 preference);
// deployments may extend it through the `extraBlocklist` hook. Plaintext
// passwords are never sent anywhere by this module.
import { AuthError } from "./errors.js";

/** Spec §12: minimum 15 Unicode code points. */
export const PASSWORD_MIN_CODE_POINTS = 15;
/** Spec §12 requires accepting at least 128; 512 bounds hashing cost abuse. */
export const PASSWORD_MAX_CODE_POINTS = 512;

export type PasswordIssueCode = "TOO_SHORT" | "TOO_LONG" | "BLOCKLISTED";

export interface PasswordIssue {
  readonly code: PasswordIssueCode;
  /** Operator/UI-safe explanation; never echoes the password. */
  readonly message: string;
}

/**
 * Returns true when the candidate must be rejected. Receives the raw
 * plaintext in-process only; implementations must not transmit it.
 */
export type PasswordBlocklistHook = (password: string) => boolean | Promise<boolean>;

/**
 * Curated local corpus of breached/common passwords (top-of-list entries
 * from public breach analyses) plus product-specific guesses. Comparison is
 * case-insensitive after NFKC, so "Password123!" and "password123!" both hit.
 */
const COMMON_PASSWORD_CORPUS = [
  "1234",
  "12345",
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "111111",
  "000000",
  "121212",
  "123123",
  "696969",
  "666666",
  "159753",
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "password1!",
  "password123!",
  "passw0rd",
  "passw0rd!",
  "passwd",
  "p@ssw0rd",
  "p@ssword",
  "secret",
  "letmein",
  "letmein1",
  "welcome",
  "welcome1",
  "welcome1!",
  "welcometotheclub",
  "iloveyou",
  "princess",
  "sunshine",
  "dragon",
  "monkey",
  "shadow",
  "master",
  "superman",
  "batman",
  "starwars",
  "trustno1",
  "freedom",
  "whatever",
  "qwerty",
  "qwerty123",
  "qwerty123!",
  "qwertyuiop",
  "azerty",
  "qazwsx",
  "1q2w3e4r",
  "1qaz2wsx",
  "zaq12wsx",
  "abc123",
  "abcd1234",
  "admin",
  "admin1",
  "admin123",
  "admin123!",
  "administrator",
  "root",
  "toor",
  "login",
  "guest",
  "test",
  "test123",
  "oracle",
  "changeme",
  "changeme1",
  "default",
  "computer",
  "internet",
  "samsung",
  "google",
  "facebook",
  "november",
  "summer",
  "winter",
  "spring",
  "autumn",
  "ashley",
  "michael",
  "jordan",
  "jennifer",
  "charlie",
  "hunter",
  "thomas",
  "harley",
  "ranger",
  "buster",
  "soccer",
  "hockey",
  "killer",
  "george",
  "sexy",
  "andrew",
  "charlie1",
  "matthew",
  "michelle",
  "daniel",
  "tigger",
  "purple",
  "cookie",
  "naruto",
  "solo",
  "loveyou",
  "zaq1zaq1",
  "football",
  "baseball",
  "liverpool",
  "chelsea",
  "arsenal",
  "realmadrid",
  "barcelona",
  "pcms",
  "pcms123",
  "progressivecms",
  "cmsadmin",
] as const;

const NORMALIZED_CORPUS: ReadonlySet<string> = new Set(
  COMMON_PASSWORD_CORPUS.map((entry) => entry.normalize("NFKC").toLowerCase()),
);

export interface PasswordPolicy {
  /** Throws AUTH_PASSWORD_POLICY_VIOLATION / AUTH_PASSWORD_BLOCKLISTED. */
  validate(plain: string): Promise<void>;
  /** Non-throwing variant for UI affordances; returns all issues found. */
  issues(plain: string): Promise<PasswordIssue[]>;
}

export function createPasswordPolicy(
  options: {
    /** Additional blocked entries or a custom predicate (deployment corpus). */
    extraBlocklist?: Iterable<string> | PasswordBlocklistHook;
  } = {},
): PasswordPolicy {
  const extraSet =
    typeof options.extraBlocklist === "function"
      ? null
      : new Set([...(options.extraBlocklist ?? [])].map(normalizeForComparison));
  const extraHook = typeof options.extraBlocklist === "function" ? options.extraBlocklist : null;

  async function issues(plain: string): Promise<PasswordIssue[]> {
    const found: PasswordIssue[] = [];
    const codePoints = [...plain];
    if (codePoints.length < PASSWORD_MIN_CODE_POINTS) {
      found.push({
        code: "TOO_SHORT",
        message: `password must be at least ${PASSWORD_MIN_CODE_POINTS} characters`,
      });
    }
    if (codePoints.length > PASSWORD_MAX_CODE_POINTS) {
      found.push({
        code: "TOO_LONG",
        message: `password must be at most ${PASSWORD_MAX_CODE_POINTS} characters`,
      });
    }
    // Always evaluated, independent of length issues: a short common
    // password must still be recognizable as a breached credential.
    if (await isBlocklisted(plain)) {
      found.push({
        code: "BLOCKLISTED",
        message: "this password appears in common-password corpora and cannot be used",
      });
    }
    return found;
  }

  async function isBlocklisted(plain: string): Promise<boolean> {
    const normalized = normalizeForComparison(plain);
    if (NORMALIZED_CORPUS.has(normalized)) return true;
    if (extraSet?.has(normalized)) return true;
    if (extraHook !== null && (await extraHook(plain))) return true;
    return false;
  }

  return {
    async validate(plain: string): Promise<void> {
      const found = await issues(plain);
      if (found.length === 0) return;
      // BLOCKLISTED is the more specific signal when both classes apply.
      const blocklisted = found.some((issue) => issue.code === "BLOCKLISTED");
      throw new AuthError(
        blocklisted ? "AUTH_PASSWORD_BLOCKLISTED" : "AUTH_PASSWORD_POLICY_VIOLATION",
        found.map((issue) => issue.message).join("; "),
      );
    },
    issues,
  };
}

function normalizeForComparison(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}
