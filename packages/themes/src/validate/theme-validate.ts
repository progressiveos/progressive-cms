// Theme validation service (PCMS-THEME-T019; Theme Contract spec §47/§50).
//
// Machine-readable validation of a theme directory against the Theme
// Contract: manifest, contract/capability compatibility, declared file
// references, settings→token bridge, media presets, asset build (incl. CSP
// and public JS policy) and fixtures presence. Every check reports stable
// issue codes; `ok` is false when any check fails. Site-level checks (entry
// content compatibility, render smoke against real content) live in
// `cms site validate` (PCMS-THEME-T020).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { planAssetBuild } from "../assets/assets.js";
import { validateCspDeclaration, validatePublicJs } from "../assets/csp.js";
import { createThemeRegistry } from "../manifest/registry.js";
import { type ManifestIssue, parseThemeManifest, type ThemeManifest } from "../manifest/schema.js";
import { parseTokensSource, tokenCssName } from "../tokens/tokens.js";

export interface ValidationIssue {
  readonly check: string;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ThemeValidationReport {
  /** Theme id when the manifest parsed, null otherwise. */
  readonly theme: string | null;
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

export function validateThemeDir(
  themeDir: string,
  options?: { capabilities?: Readonly<Record<string, string>>; cmsVersion?: string },
): ThemeValidationReport {
  const issues: ValidationIssue[] = [];

  // 1. manifest
  const manifestPath = join(themeDir, "theme.json");
  if (!existsSync(manifestPath)) {
    return {
      theme: null,
      ok: false,
      issues: [
        {
          check: "manifest",
          code: "THEME_MANIFEST_MISSING",
          path: "/theme.json",
          message: "theme.json not found",
        },
      ],
    };
  }
  let parsed: ReturnType<typeof parseThemeManifest>;
  try {
    parsed = parseThemeManifest(readFileSync(manifestPath, "utf8"));
  } catch {
    return {
      theme: null,
      ok: false,
      issues: [
        {
          check: "manifest",
          code: "THEME_MANIFEST_INVALID",
          path: "/theme.json",
          message: "theme.json is not valid JSON",
        },
      ],
    };
  }
  if (!parsed.ok) {
    for (const issue of parsed.issues as readonly ManifestIssue[]) {
      issues.push({
        check: "manifest",
        code: issue.code,
        path: issue.path,
        message: issue.message,
      });
    }
    return { theme: null, ok: false, issues };
  }
  const manifest: ThemeManifest = parsed.value;

  // 2. contract/capability compatibility
  const registry = createThemeRegistry();
  const compat = registry.checkCompatibility(manifest, {
    ...(options?.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options?.cmsVersion === undefined ? {} : { cmsVersion: options.cmsVersion }),
  });
  if (!compat.compatible) {
    for (const issue of compat.issues) {
      issues.push({
        check: "compatibility",
        code: issue.code,
        path: "/theme_contract",
        message: issue.message,
      });
    }
  }

  // 3. declared file references exist
  const declaredFiles = [
    ...manifest.templates.map((t) => t.file),
    ...manifest.components.map((c) => c.file),
    ...manifest.block_renderers.map((r) => r.file),
  ];
  for (const file of declaredFiles) {
    if (!existsSync(join(themeDir, file))) {
      issues.push({
        check: "file_references",
        code: "THEME_FILE_MISSING",
        path: `/${file}`,
        message: `declared file not found: ${file}`,
      });
    }
  }

  // 4. design tokens + settings→token bridge
  const tokensDir = join(themeDir, "tokens");
  const declaredCssTokens = new Set<string>();
  if (existsSync(tokensDir)) {
    for (const file of readdirSync(tokensDir)
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      try {
        const result = parseTokensSource(readFileSync(join(tokensDir, file), "utf8"));
        if (result.ok) {
          for (const key of Object.keys(result.tokens)) declaredCssTokens.add(tokenCssName(key));
        } else {
          for (const issue of result.issues) {
            issues.push({
              check: "tokens",
              code: issue.code,
              path: `/tokens/${file}${issue.path}`,
              message: issue.message,
            });
          }
        }
      } catch (error) {
        issues.push({
          check: "tokens",
          code: "TOKEN_SOURCE_INVALID",
          path: `/tokens/${file}`,
          message: (error as Error).message,
        });
      }
    }
  }
  for (const setting of manifest.settings_schema) {
    if (setting.token !== undefined && !declaredCssTokens.has(setting.token)) {
      issues.push({
        check: "settings",
        code: "THEME_SETTING_TOKEN_UNKNOWN",
        path: `/settings_schema/${setting.key}`,
        message: `setting "${setting.key}" targets undeclared token ${setting.token}`,
      });
    }
  }

  // 5. media presets — structural validation happened in the manifest
  //    (uniqueness/shape); discovery ingestion is the Media module's (M05).

  // 6. assets: build plan + CSP + public JS policy
  if (manifest.assets !== undefined) {
    const plan = planAssetBuild(themeDir, manifest.assets);
    for (const issue of plan.issues) {
      issues.push({
        check: "assets",
        code: issue.code,
        path: `/${issue.path}`,
        message: issue.message,
      });
    }
    for (const issue of validateCspDeclaration(manifest.assets.csp ?? {})) {
      issues.push({ check: "assets", code: issue.code, path: issue.path, message: issue.message });
    }
    const jsFiles: Record<string, string> = {};
    for (const js of manifest.assets.js ?? []) {
      try {
        jsFiles[js] = readFileSync(join(themeDir, js), "utf8");
      } catch {
        // already reported as missing above
      }
    }
    for (const issue of validatePublicJs(jsFiles)) {
      issues.push({
        check: "assets",
        code: issue.code,
        path: `/${issue.path}`,
        message: issue.message,
      });
    }
  }

  // 6.5 analytics duplicate scan (ADR-0016; Analytics spec §12): themes
  // must not embed a second instance of the platform-managed counters.
  // Known direct duplicates only — no heuristic ban on arbitrary external JS.
  const duplicateSignatures: readonly [string, RegExp][] = [
    ["mc.yandex.ru", /mc\.yandex\.ru/],
    ["googletagmanager.com/gtm", /googletagmanager\.com\/(gtm|ns\.html)/],
    ["googletagmanager.com/gtag", /googletagmanager\.com\/gtag/],
    ["gtag(", /\bgtag\s*\(/],
    ["ym(", /\bym\s*\(/],
  ];
  const scanTargets: readonly [string, string][] = [
    ...manifest.templates.map((t): [string, string] => [
      `templates/${t.file}`,
      join(themeDir, t.file),
    ]),
    ...(manifest.assets?.js ?? []).map((js): [string, string] => [
      `assets/${js}`,
      join(themeDir, js),
    ]),
  ];
  for (const [relative, absolute] of scanTargets) {
    let content: string;
    try {
      content = readFileSync(absolute, "utf8");
    } catch {
      continue; // missing files are reported by their own checks
    }
    for (const [signature, pattern] of duplicateSignatures) {
      if (pattern.test(content)) {
        issues.push({
          check: "analytics",
          code: "THEME_ANALYTICS_MANAGED_BY_PLATFORM",
          path: `/${relative}`,
          message: `analytics is managed by the platform (Настройки → Аналитика и теги): "${signature}" must not be embedded by the theme`,
        });
      }
    }
  }

  // 7. fixtures presence (render smoke with real content = site validate)
  const fixturesDir = join(themeDir, "fixtures");
  if (!existsSync(fixturesDir) || readdirSync(fixturesDir).length === 0) {
    issues.push({
      check: "fixtures",
      code: "THEME_FIXTURES_MISSING",
      path: "/fixtures",
      message: "theme fixtures directory must contain at least one fixture",
    });
  }

  return { theme: manifest.id, ok: issues.length === 0, issues };
}
