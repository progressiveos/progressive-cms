// Slug normalization policies (PCMS-NAV-T010; Navigation spec §27/§28).
// A slug comes in as a hint (from Content); Routing normalizes it according
// to the site Routing Policy. Cyrillic supports both site policies —
// transliteration to ASCII or Unicode slugs; neither is hard-coded into the
// domain model (spec §28). Once published, the slug is stable — title edits
// never rewrite it (§27); this function is used at route-proposal time.
import type { SlugPolicy } from "./policy.js";

const MAX_SLUG_LENGTH = 128;

// Baseline Cyrillic transliteration (ISO 9-style) plus common
// Ukrainian/Belarusian letters; unmappable characters drop out.
const TRANSLIT: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  і: "i",
  ї: "yi",
  є: "ie",
  ґ: "g",
  ў: "u",
};

/** Letters (any script) and digits survive in unicode-slug mode. */
const UNICODE_SAFE = /^[\p{L}\p{N}]$/u;
const ASCII_SAFE = /^[a-z0-9]$/;

/**
 * Normalizes a slug hint: Unicode NFKD, lowercase, spaces/underscores to
 * hyphens, separators collapsed and trimmed, path-unsafe characters removed
 * (spec §28 baseline). Empty results throw SLUG_INVALID — callers pick the
 * next candidate, the domain never invents one silently.
 */
export function normalizeSlug(hint: string, policy: SlugPolicy): string {
  if (typeof hint !== "string" || hint.length === 0 || hint.length > 512) {
    throw new SlugInvalidError(hint);
  }
  // Transliterate precomposed Cyrillic BEFORE NFKD — decomposing first would
  // split ё/й into base letter + combining mark and lose the mapping.
  let working = hint.toLowerCase();
  if (policy.cyrillic === "transliterate") {
    working = [...working].map((ch) => TRANSLIT[ch] ?? ch).join("");
  }
  // NFKD + mark-stripping folds compatibility forms and accents.
  const withoutMarks = working.normalize("NFKD").replace(/\p{M}/gu, "");
  const safe = policy.cyrillic === "transliterate" ? ASCII_SAFE : UNICODE_SAFE;
  let out = "";
  for (const char of withoutMarks) {
    if (char === " " || char === "_" || char === "-") {
      out += "-";
      continue;
    }
    if (safe.test(char)) {
      out += char;
    }
    // Every other character (punctuation, path-unsafe, emoji, …) is dropped.
  }
  out = out
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  out = out.replace(/-+$/g, "");
  if (out.length === 0) throw new SlugInvalidError(hint);
  return out;
}

export class SlugInvalidError extends Error {
  readonly code = "SLUG_INVALID";
  readonly hint: string;
  constructor(hint: string) {
    super(`slug hint produced an empty slug`);
    this.name = "SlugInvalidError";
    this.hint = hint;
  }
}

/**
 * Builds a canonical content path from slug segments:
 * `normalizeSlug` per segment + a trailing slash. Reserved-path and
 * collision checks are separate concerns (registry / availability service).
 */
export function slugSegmentsToPath(segments: readonly string[], policy: SlugPolicy): string {
  if (segments.length === 0) throw new SlugInvalidError("");
  const parts = segments.map((segment) => normalizeSlug(segment, policy));
  return `/${parts.join("/")}/`;
}
