// Core-protected head boundary + theme head extension slot
// (PCMS-THEME-T016; Theme Contract spec §38/§39).
//
// Ownership: the CMS core produces the head model (title semantics, canonical,
// robots, core meta, JSON-LD — from M06 the SEO subsystem owns those
// semantics). Themes extend the page head ONLY through `theme_slots`
// (stylesheet, theme meta, preloads, public scripts). A theme can never
// suppress, duplicate or override canonical/robots/social/core metadata:
// such slots are dropped and reported as violations.
import { escapeHtmlString } from "../engine/safe-html.js";
import type { HeadViewModel } from "../view-models.js";

/** Core-protected head keys — theme slots may never touch these (§38).
 * Ownership-verification meta names are protected too (2026-10-18): themes
 * must never fabricate site-ownership proofs — Core emits them from the
 * typed site-identity store. */
const PROTECTED_META_NAMES = new Set([
  "robots",
  "description",
  "viewport",
  "charset",
  "google-site-verification",
  "yandex-verification",
]);
const PROTECTED_META_PREFIXES = ["og:", "twitter:", "article:", "product:"];

export interface HeadSlotViolation {
  readonly code: "THEME_HEAD_PROTECTED_METADATA" | "THEME_HEAD_SLOT_INVALID";
  readonly path: string;
  readonly message: string;
}

const SLOT_KINDS = new Set(["stylesheet", "meta", "link", "script"]);
const SLOT_ATTR_ALLOWLIST = new Set([
  "rel",
  "href",
  "src",
  "name",
  "content",
  "property",
  "media",
  "as",
  "type",
  "crossorigin",
  "integrity",
  "defer",
  "async",
  "referrerpolicy",
]);

function isProtectedMeta(attributes: Readonly<Record<string, string>>): boolean {
  const name = attributes.name ?? attributes.property ?? "";
  if (PROTECTED_META_NAMES.has(name.toLowerCase())) return true;
  return PROTECTED_META_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix));
}

/**
 * Slot URL admission (§39): strict parsing, never substring heuristics.
 * Valid forms are an absolute URL with an explicit http(s) scheme or a
 * site-rooted path (`/…`); a protocol-relative `//host` is an implicit
 * host change and rejected. The URL-parser canonicalization is the second
 * gate: whatever the surface form (`HTTPS:/\…`, leading whitespace, case),
 * the resolved protocol must be http(s) — `javascript:` in any spelling
 * fails the explicit-prefix requirement or this parse.
 */
function slotUrlValid(url: string): boolean {
  const value = url.trim();
  if (value.startsWith("//")) return false;
  if (!/^https?:\/\//i.test(value) && !value.startsWith("/")) return false;
  try {
    const parsed = new URL(value, "https://slot.invalid");
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Validates theme slots; returns the accepted ones plus violations for the rest. */
export function filterThemeHeadSlots(slots: HeadViewModel["theme_slots"]): {
  readonly accepted: HeadViewModel["theme_slots"];
  readonly violations: readonly HeadSlotViolation[];
} {
  const accepted: {
    kind: "stylesheet" | "meta" | "link" | "script";
    attributes: Record<string, string>;
  }[] = [];
  const violations: HeadSlotViolation[] = [];
  for (const [index, slot] of slots.entries()) {
    const path = `/head/theme_slots/${index}`;
    if (!SLOT_KINDS.has(slot.kind)) {
      violations.push({
        code: "THEME_HEAD_SLOT_INVALID",
        path,
        message: `unknown slot kind: ${slot.kind}`,
      });
      continue;
    }
    const attrs = Object.fromEntries(
      Object.entries(slot.attributes).filter(([k]) => SLOT_ATTR_ALLOWLIST.has(k)),
    );
    if (Object.keys(attrs).length !== Object.keys(slot.attributes).length) {
      violations.push({
        code: "THEME_HEAD_SLOT_INVALID",
        path,
        message: "slot attributes outside the allowlist were dropped",
      });
    }
    if (slot.kind === "stylesheet") {
      attrs.rel = attrs.rel ?? "stylesheet";
    }
    if (slot.kind === "script") {
      if (attrs.src === undefined) {
        violations.push({
          code: "THEME_HEAD_SLOT_INVALID",
          path,
          message: "public scripts must declare a src (no inline script)",
        });
        continue;
      }
      attrs.defer = attrs.defer ?? "";
    }
    const url = attrs.href ?? attrs.src;
    if (url !== undefined && !slotUrlValid(url)) {
      violations.push({
        code: "THEME_HEAD_SLOT_INVALID",
        path,
        message: `slot URL is not allowed: ${url}`,
      });
      continue;
    }
    if (slot.kind === "meta" && isProtectedMeta(attrs)) {
      violations.push({
        code: "THEME_HEAD_PROTECTED_METADATA",
        path,
        message: `theme cannot set protected metadata: ${attrs.name ?? attrs.property}`,
      });
      continue;
    }
    if (
      slot.kind === "link" &&
      // Favicon icons are Site Identity media rendered by the core (M06);
      // canonical/alternate are routing-owned. All are theme-protected.
      (attrs.rel === "canonical" ||
        attrs.rel === "icon" ||
        attrs.rel === "shortcut icon" ||
        attrs.rel === "apple-touch-icon" ||
        attrs.rel === "alternate")
    ) {
      violations.push({
        code: "THEME_HEAD_PROTECTED_METADATA",
        path,
        message: `theme cannot set rel="${attrs.rel}"`,
      });
      continue;
    }
    accepted.push({ kind: slot.kind, attributes: attrs });
  }
  return { accepted, violations };
}

function renderSlot(slot: {
  readonly kind: string;
  readonly attributes: Readonly<Record<string, string>>;
}): string {
  const attrs = Object.entries(slot.attributes)
    .map(([k, v]) => (v === "" ? k : `${k}="${escapeHtmlString(v)}"`))
    .join(" ");
  switch (slot.kind) {
    case "stylesheet":
      return `<link ${attrs}>`;
    case "meta":
      return `<meta ${attrs}>`;
    case "link":
      return `<link ${attrs}>`;
    case "script":
      return `<script ${attrs}></script>`;
    default:
      return "";
  }
}

/** Serializes JSON-LD safely: a literal `</script>` inside JSON must not close the tag. */
function jsonLdSafe(json: string): string {
  return json.replace(/<\//g, "<\\/");
}

/**
 * Deterministic head composition: core section first (title, core meta,
 * canonical, robots, JSON-LD), then the theme extension slot. Order is fixed
 * by the contract; themes cannot reorder or remove the core section.
 */
export function assembleHeadHtml(core: HeadViewModel): string {
  const parts: string[] = [];
  if (core.title !== null) parts.push(`<title>${escapeHtmlString(core.title)}</title>`);
  for (const meta of core.core_meta) {
    // Open Graph uses `property=`; everything else uses `name=` (M06).
    const property = meta.property;
    const name = meta.name ?? "";
    parts.push(
      property !== undefined
        ? `<meta property="${escapeHtmlString(property)}" content="${escapeHtmlString(meta.content)}">`
        : `<meta name="${escapeHtmlString(name)}" content="${escapeHtmlString(meta.content)}">`,
    );
  }
  if (core.canonical !== null)
    parts.push(`<link rel="canonical" href="${escapeHtmlString(core.canonical)}">`);
  for (const alternate of core.alternates ?? []) {
    // Reciprocal hreflang links are routing-owned like canonical (§38): the
    // head fragment must carry them so wholesale adoption loses nothing.
    parts.push(
      `<link rel="alternate" hreflang="${escapeHtmlString(alternate.hreflang)}" href="${escapeHtmlString(alternate.href)}">`,
    );
  }
  if (core.robots !== null)
    parts.push(`<meta name="robots" content="${escapeHtmlString(core.robots)}">`);
  for (const icon of core.icons ?? []) {
    const attrs = [
      `rel="${escapeHtmlString(icon.rel)}"`,
      `href="${escapeHtmlString(icon.href)}"`,
      icon.type !== undefined ? `type="${escapeHtmlString(icon.type)}"` : "",
      icon.sizes !== undefined ? `sizes="${escapeHtmlString(icon.sizes)}"` : "",
    ]
      .filter((a) => a !== "")
      .join(" ");
    parts.push(`<link ${attrs}>`);
  }
  for (const json of core.json_ld) {
    parts.push(`<script type="application/ld+json">${jsonLdSafe(json)}</script>`);
  }
  const { accepted } = filterThemeHeadSlots(core.theme_slots);
  for (const slot of accepted) parts.push(renderSlot(slot));
  return parts.join("\n");
}

/** Collects violations without rendering (theme/site validation uses this). */
export function headViolations(core: HeadViewModel): readonly HeadSlotViolation[] {
  return filterThemeHeadSlots(core.theme_slots).violations;
}
