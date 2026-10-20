// Navigation item type validation (PCMS-NAV-T003; Navigation spec §5–§11).
//
// Payload shape rules per item type, mirroring the theme-side contract
// (Theme Contract §22–§24) so malformed data never reaches a renderer.
// External URL safety (spec §7): schemes http/https only, `javascript:` and
// friends are rejected, `_blank` gets a safe rel policy applied on write.
import { isStableId } from "@pcms/core";
import { NavigationError } from "./errors.js";
import {
  type ActionTarget,
  type ActionUiIntent,
  type AnchorTarget,
  EXTERNAL_REL_TOKENS,
  type ExternalLinkTarget,
  type ExternalRelToken,
  type ExternalUrlTarget,
  type InternalEntryTarget,
  MAX_ANCHOR_LENGTH,
  type NavigationItemTarget,
  type NavigationItemType,
} from "./model.js";

export const NAVIGATION_ACTION_KINDS = [
  "internal_entry",
  "external_url",
  "anchor",
  "form",
  "phone",
  "email",
  "media_download",
  "none",
] as const;
export type NavigationActionKind = (typeof NAVIGATION_ACTION_KINDS)[number];

const ANCHOR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LABEL_MAX = 200;
const PHONE_PATTERN = /^(\+[0-9][0-9 ()-]{0,19}|0[0-9 ()-]{1,19})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_REL: readonly ExternalRelToken[] = ["noopener", "noreferrer"];

/** True when the URL scheme is an allowed navigation scheme (http/https). */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // `javascript:alert(1)` and other pseudo-schemes fail the allowlist; a URL
  // with no host (e.g. `http://`) is likewise not a navigable external link.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.hostname.length > 0 && url.length <= 2048;
}

function externalTargetIssues(target: ExternalUrlTarget, path: string): string[] {
  const issues: string[] = [];
  if (!isAllowedExternalUrl(target.url)) {
    issues.push(`${path}/url`);
  }
  for (const token of target.rel) {
    if (!EXTERNAL_REL_TOKENS.includes(token)) issues.push(`${path}/rel`);
  }
  return issues;
}

/** One human-readable diagnostic path per invalid field (e.g. "target/url"). */
export function itemPayloadIssues(
  type: NavigationItemType,
  target: NavigationItemTarget,
  label: string | null,
  uiIntent: ActionUiIntent | null,
): string[] {
  const issues: string[] = [];
  if (label !== null && (label.length === 0 || label.length > LABEL_MAX)) {
    issues.push("label");
  }
  switch (type) {
    case "internal_entry": {
      const t = target as InternalEntryTarget | null;
      if (t === null || typeof t.entry_id !== "string" || !isStableId(t.entry_id)) {
        issues.push("target");
      }
      break;
    }
    case "external_url": {
      const t = target as ExternalUrlTarget | null;
      if (
        t === null ||
        typeof t.url !== "string" ||
        (t.target !== "_self" && t.target !== "_blank") ||
        !Array.isArray(t.rel)
      ) {
        issues.push("target");
        break;
      }
      issues.push(...externalTargetIssues(t, "target"));
      break;
    }
    case "anchor": {
      const t = target as AnchorTarget | null;
      if (
        t === null ||
        typeof t.anchor !== "string" ||
        !ANCHOR_PATTERN.test(t.anchor) ||
        t.anchor.length > MAX_ANCHOR_LENGTH ||
        (t.entry_id !== null && (typeof t.entry_id !== "string" || !isStableId(t.entry_id)))
      ) {
        issues.push("target");
      }
      break;
    }
    case "group":
    case "separator": {
      if (target !== null) issues.push("target");
      if (type === "separator" && label !== null) issues.push("label");
      if (type === "group" && (label === null || label.length === 0)) issues.push("label");
      break;
    }
    case "action": {
      const t = target as ActionTarget | null;
      if (t === null || !NAVIGATION_ACTION_KINDS.includes(t.kind)) {
        issues.push("target");
        break;
      }
      switch (t.kind) {
        case "internal_entry":
          if (!isStableId(t.entry_id)) issues.push("target/entry_id");
          break;
        case "external_url":
          issues.push(...externalTargetIssues(t, "target"));
          break;
        case "anchor":
          if (!ANCHOR_PATTERN.test(t.anchor)) issues.push("target/anchor");
          if (t.entry_id !== null && !isStableId(t.entry_id)) issues.push("target/entry_id");
          break;
        case "form":
          if (
            typeof t.form_definition_id !== "string" ||
            t.form_definition_id.length === 0 ||
            t.form_definition_id.length > 128
          ) {
            issues.push("target/form_definition_id");
          }
          break;
        case "phone":
          if (typeof t.phone !== "string" || !PHONE_PATTERN.test(t.phone)) {
            issues.push("target/phone");
          }
          break;
        case "email":
          if (typeof t.email !== "string" || !EMAIL_PATTERN.test(t.email) || t.email.length > 254) {
            issues.push("target/email");
          }
          break;
        case "media_download":
          if (!isStableId(t.media_asset_id)) issues.push("target/media_asset_id");
          break;
        case "none":
          break;
      }
      if (uiIntent !== null && !["cta", "button", "plain"].includes(uiIntent)) {
        issues.push("ui_intent");
      }
      break;
    }
  }
  return issues;
}

/**
 * Safe-by-default normalization applied before persisting: `_blank` links
 * always gain `noopener noreferrer` (spec §7); unknown rel tokens are
 * rejected, not silently dropped.
 */
export function normalizeExternalRel(
  target: ExternalLinkTarget,
  rel: readonly ExternalRelToken[],
): ExternalRelToken[] {
  for (const token of rel) {
    if (!EXTERNAL_REL_TOKENS.includes(token)) {
      throw new NavigationError("NAV_ITEM_REL_TOKEN_INVALID", `unknown rel token`, {
        details: { rel: token as string },
      });
    }
  }
  if (target !== "_blank") return [...rel];
  return [...new Set([...rel, ...SAFE_REL])];
}

export type ValidatedItemInput = {
  readonly type: NavigationItemType;
  readonly label: string | null;
  readonly target: NavigationItemTarget;
  readonly uiIntent: ActionUiIntent | null;
};

/**
 * Validates and normalizes one item's payload, throwing a stable
 * NavigationError when the shape does not match its declared type.
 */
export function validateItemInput(input: {
  type: NavigationItemType;
  label?: string | null;
  target?: NavigationItemTarget;
  uiIntent?: ActionUiIntent | null;
}): ValidatedItemInput {
  const label = input.label ?? null;
  const target = input.target ?? null;
  const uiIntent = input.uiIntent ?? null;
  // Rel tokens get their own precise code before the generic payload check.
  if (input.type === "external_url" && target !== null) {
    const t = target as ExternalUrlTarget;
    normalizeExternalRel(t.target, t.rel);
  }
  const issues = itemPayloadIssues(input.type, target, label, uiIntent);
  if (issues.length > 0) {
    throw new NavigationError("NAV_ITEM_PAYLOAD_INVALID", `item payload does not match its type`, {
      details: { item_type: input.type, issues },
    });
  }
  const normalized =
    input.type === "external_url" && target !== null
      ? {
          ...target,
          rel: normalizeExternalRel(
            (target as ExternalUrlTarget).target,
            (target as ExternalUrlTarget).rel,
          ),
        }
      : target;
  return { type: input.type, label, target: normalized, uiIntent };
}
