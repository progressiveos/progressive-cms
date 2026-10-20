// Trusted HTML fragment type (PCMS-THEME-T004/T010; Theme Contract spec §20).
//
// The ONLY way raw HTML reaches template output: a value explicitly produced
// by trusted application-layer renderers (e.g. the RichText bridge). Template
// authors cannot construct it — autoescape bypasses values that carry the
// runtime brand, and the TypeScript type cannot be satisfied from outside
// this module.

import { escapeHtmlString } from "@pcms/core";
import { ThemeError } from "../errors.js";

// Single canonical escaping implementation (packages/core/src/html.ts);
// re-exported below for the theme engine's existing import surface.

const SAFE_HTML_BRAND = Symbol("pcms.safe-html");

export interface SafeHtml {
  readonly [SAFE_HTML_BRAND]: true;
  readonly html: string;
}

/** Wraps pre-rendered, already-safe HTML as trusted output. */
export function safeHtml(html: string): SafeHtml {
  if (typeof html !== "string") {
    throw new ThemeError("THEME_SAFEHTML_INVALID", "safeHtml expects a string");
  }
  return { [SAFE_HTML_BRAND]: true, html };
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return (
    typeof value === "object" &&
    value !== null &&
    SAFE_HTML_BRAND in value &&
    (value as SafeHtml)[SAFE_HTML_BRAND] === true &&
    typeof (value as SafeHtml).html === "string"
  );
}

export { escapeHtmlString };

/**
 * Stringifies an arbitrary template value the way autoescape output does:
 * null/undefined render empty, scalars via String(), structures via JSON.
 * SafeHtml values pass through untouched.
 */
export function stringifyOutput(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return escapeHtmlString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return escapeHtmlString(String(value));
  }
  if (isSafeHtml(value)) return value.html;
  try {
    return escapeHtmlString(JSON.stringify(value) ?? "");
  } catch {
    return "";
  }
}
