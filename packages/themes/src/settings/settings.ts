// Theme Settings schema validation + token override bridge
// (PCMS-THEME-T014; Theme Contract spec §27–§29).
//
// Settings are typed (boolean/string/enum/number/color/media), validated
// against the manifest `settings_schema` — never a generic key/value store.
// Resolving values = provided values validated, then deterministic defaults
// for everything omitted. Settings that declare a `token` materialize into
// documented design token overrides (§29): validated Theme Setting →
// `--color-primary` etc. Source token defaults stay version-controlled.

import type { ThemeManifestSetting } from "../manifest/schema.js";
import { STABLE_ID_PATTERN } from "../navigation/patterns.js";
import { type ThemeToken, type TokenMap, tokenCssName, valueValid } from "../tokens/tokens.js";

export interface SettingIssue {
  readonly code:
    | "THEME_SETTING_UNKNOWN"
    | "THEME_SETTING_TYPE_INVALID"
    | "THEME_SETTING_VALUE_INVALID"
    | "THEME_SETTING_REQUIRED_TOKEN_MISSING";
  readonly path: string;
  readonly message: string;
}

const MEDIA_DEFAULT_RE = new RegExp(
  `^(${STABLE_ID_PATTERN.slice(1, -1)}|assets/[a-z0-9][a-z0-9._/-]*|)$`,
);
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export type SettingsValues = Readonly<Record<string, boolean | string | number | null>>;

function valueIssue(key: string, code: SettingIssue["code"], message: string): SettingIssue {
  return { code, path: `/settings/${key}`, message };
}

function checkValue(setting: ThemeManifestSetting, value: unknown): SettingIssue | null {
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean"
        ? null
        : valueIssue(
            setting.key,
            "THEME_SETTING_TYPE_INVALID",
            `"${setting.key}" expects a boolean`,
          );
    case "string":
      return typeof value === "string" && value.length <= 500
        ? null
        : valueIssue(
            setting.key,
            "THEME_SETTING_TYPE_INVALID",
            `"${setting.key}" expects a string (≤500 chars)`,
          );
    case "enum":
      if (typeof value !== "string" || !(setting.choices ?? []).includes(value)) {
        return valueIssue(
          setting.key,
          "THEME_SETTING_VALUE_INVALID",
          `"${setting.key}" must be one of: ${(setting.choices ?? []).join(", ")}`,
        );
      }
      return null;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return valueIssue(
          setting.key,
          "THEME_SETTING_TYPE_INVALID",
          `"${setting.key}" expects a number`,
        );
      }
      if (setting.min !== undefined && value < setting.min) {
        return valueIssue(
          setting.key,
          "THEME_SETTING_VALUE_INVALID",
          `"${setting.key}" must be ≥ ${setting.min}`,
        );
      }
      if (setting.max !== undefined && value > setting.max) {
        return valueIssue(
          setting.key,
          "THEME_SETTING_VALUE_INVALID",
          `"${setting.key}" must be ≤ ${setting.max}`,
        );
      }
      return null;
    }
    case "color":
      if (typeof value !== "string" || !COLOR_RE.test(value)) {
        return valueIssue(
          setting.key,
          "THEME_SETTING_VALUE_INVALID",
          `"${setting.key}" expects a #RRGGBB color`,
        );
      }
      return null;
    case "media":
      if (typeof value !== "string" || !MEDIA_DEFAULT_RE.test(value)) {
        return valueIssue(
          setting.key,
          "THEME_SETTING_VALUE_INVALID",
          `"${setting.key}" expects a stable media ID or theme asset path`,
        );
      }
      return null;
  }
}

/**
 * Validates raw (untrusted) settings values against the schema and merges
 * them over the schema defaults — deterministic: defaults come from the
 * manifest, provided values win.
 */
export function resolveSettingsValues(
  schema: readonly ThemeManifestSetting[],
  values: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly values: SettingsValues }
  | { readonly ok: false; readonly issues: readonly SettingIssue[] } {
  const issues: SettingIssue[] = [];
  const byKey = new Map(schema.map((s) => [s.key, s]));
  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) {
      issues.push(valueIssue(key, "THEME_SETTING_UNKNOWN", `unknown setting: ${key}`));
    }
  }
  const resolved: Record<string, boolean | string | number | null> = {};
  for (const setting of [...schema].sort((a, b) => a.key.localeCompare(b.key))) {
    const provided = values[setting.key];
    const effective = provided === undefined ? setting.default : provided;
    if (effective === undefined) {
      resolved[setting.key] = null;
      continue;
    }
    const issue = checkValue(setting, effective);
    if (issue !== null) {
      issues.push(issue);
      continue;
    }
    resolved[setting.key] = effective as boolean | string | number;
  }
  return issues.length === 0 ? { ok: true, values: resolved } : { ok: false, issues };
}

/**
 * Token override bridge (§29): resolved settings that declare a `token`
 * become `--token-name → value` entries. Only string/number settings carry
 * meaningful token values (color/media settings are strings already).
 * Settings values are untrusted (§27): the raw entries produced here are
 * admitted only by `applyTokenOverrides`, which validates each override
 * against the target token's declared type and drops invalid values
 * (fail-closed to the token default).
 */
export function tokenOverridesFromSettings(
  schema: readonly ThemeManifestSetting[],
  values: SettingsValues,
): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const setting of schema) {
    if (setting.token === undefined) continue;
    const value = values[setting.key];
    if (typeof value === "string" || typeof value === "number") {
      overrides[setting.token] = String(value);
    }
  }
  return overrides;
}

/**
 * Applies setting-derived overrides to the theme's token map (pure).
 * Overrides address tokens by their CSS custom property name
 * (`--color-primary`, as settings declare them); the token map is keyed by
 * dotted source keys (`color.primary`).
 */
/** A bare-number setting override on a length token keeps the token's unit
 * (setting 1160 onto `1200px` yields `1160px`, not the unitless `1160`,
 * which would invalidate every `var()` consumer). */
function overrideValue(existing: ThemeToken, override: string): string {
  if (
    existing.type === "length" &&
    /^\d+$/.test(override) &&
    /^\d+(\.\d+)?(px|rem|em|%|vh|vw|ch)$/.test(existing.value)
  ) {
    return `${override}px`;
  }
  return override;
}

export function applyTokenOverrides(
  tokens: TokenMap,
  overrides: Readonly<Record<string, string>>,
): TokenMap {
  const byCssName = new Map(Object.entries(overrides));
  const merged: Record<string, ThemeToken> = { ...tokens };
  for (const key of Object.keys(merged)) {
    const override = byCssName.get(tokenCssName(key));
    const existing = merged[key];
    if (override === undefined || existing === undefined) continue;
    // Overrides originate from untrusted settings values (§27): each one is
    // admitted only through the token source's own value validator, keeping
    // the §25/§26 invariant that a token value can never inject CSS rules.
    // Invalid values are dropped — the token keeps its source default;
    // overrides naming unknown tokens never match a key here at all.
    const candidate = overrideValue(existing, override);
    if (!valueValid(existing.type, candidate)) continue;
    merged[key] = { ...existing, value: candidate };
  }
  return merged;
}

/**
 * Validation helper for `cms theme validate`: settings referencing tokens
 * that the token layer does not declare can never take effect.
 */
export function unmatchedSettingTokens(
  schema: readonly ThemeManifestSetting[],
  tokens: TokenMap,
): readonly string[] {
  const cssNames = new Set(Object.keys(tokens).map(tokenCssName));
  return schema
    .filter((s) => s.token !== undefined && !cssNames.has(s.token))
    .map((s) => s.token as string)
    .sort();
}
