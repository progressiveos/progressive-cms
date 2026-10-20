// JS/CSP declaration validation (PCMS-THEME-T018; Theme Contract spec §33/§34,
// §72 security invariants).
//
// The controlled policy layer builds the public CSP from the theme's declared
// origins; a theme can never introduce `script-src *`, `unsafe-eval`,
// `unsafe-inline`, `data:`/`blob:` scripts or insecure `http://` origins.
// Public JS never carries privileged CMS material: secret-shaped tokens,
// service-account markers or dynamic code execution (eval/Function) fail
// validation — making privileged tokens impossible in generated config
// fixtures.
import type { ThemeManifest } from "../manifest/schema.js";

export interface CspIssue {
  readonly code:
    | "THEME_CSP_ORIGIN_FORBIDDEN"
    | "THEME_CSP_SCHEME_INSECURE"
    | "THEME_JS_PRIVILEGED_TOKEN"
    | "THEME_JS_DYNAMIC_EXECUTION";
  readonly path: string;
  readonly message: string;
}

const SAFE_ORIGIN_RE = /^'self'$|^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
const FORBIDDEN_ORIGINS = new Set([
  "*",
  "'unsafe-eval'",
  "'unsafe-inline'",
  "data:",
  "blob:",
  "'none'",
]);

const SECRET_TOKEN_RE =
  /(PCMS_SECRET_[A-Z0-9_]+|service[_-]?account|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY|api[_-]?key\s*[:=]|authorization\s*:)/i;
const DYNAMIC_EXEC_RE =
  /\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*["'`]|document\.write\s*\(/;

/** Validates the `assets.csp` declaration of a theme manifest. */
export function validateCspDeclaration(
  csp: Readonly<Partial<Record<string, readonly string[]>>> | undefined,
): readonly CspIssue[] {
  const issues: CspIssue[] = [];
  for (const [directive, origins] of Object.entries(csp ?? {})) {
    for (const [index, origin] of (origins ?? []).entries()) {
      const path = `/assets/csp/${directive}/${index}`;
      if (FORBIDDEN_ORIGINS.has(origin.toLowerCase())) {
        issues.push({
          code: "THEME_CSP_ORIGIN_FORBIDDEN",
          path,
          message: `"${origin}" is forbidden in theme CSP declarations (§34)`,
        });
        continue;
      }
      if (!SAFE_ORIGIN_RE.test(origin)) {
        issues.push({
          code: "THEME_CSP_SCHEME_INSECURE",
          path,
          message: `origin "${origin}" must be 'self' or an https:// host`,
        });
      }
    }
  }
  return issues;
}

/** Scans declared public JS sources for privileged material / dynamic execution. */
export function validatePublicJs(files: Readonly<Record<string, string>>): readonly CspIssue[] {
  const issues: CspIssue[] = [];
  for (const path of Object.keys(files).sort()) {
    const content = files[path] ?? "";
    const secret = SECRET_TOKEN_RE.exec(content);
    if (secret !== null) {
      issues.push({
        code: "THEME_JS_PRIVILEGED_TOKEN",
        path,
        message: `public JS must never contain privileged material (matched: ${secret[0]?.slice(0, 20)}…)`,
      });
    }
    const exec = DYNAMIC_EXEC_RE.exec(content);
    if (exec !== null) {
      issues.push({
        code: "THEME_JS_DYNAMIC_EXECUTION",
        path,
        message: `dynamic code execution is forbidden in public JS (matched: ${exec[0]?.slice(0, 24)})`,
      });
    }
  }
  return issues;
}

/**
 * The controlled policy layer: builds a deterministic CSP header from the
 * validated declaration. `default-src 'self'` is always the base; declared
 * origins extend their directive. Unvalidated declarations must not reach
 * this function (theme validation gates it).
 *
 * `style_src_attr` (style-src-attr) is emitted ONLY when declared — it is a
 * system analytics contribution (provider-gated counter-check/preview
 * allowances), never a theme surface: theme validation rejects the keyword
 * sources it would carry (§34), and an always-on `style-src-attr 'self'`
 * would needlessly diverge every site's header from the baseline.
 */
export function buildCspPolicy(csp: Readonly<Partial<Record<string, readonly string[]>>>): string {
  const directives: string[] = ["default-src 'self'"];
  const aliases: Readonly<Record<string, string>> = {
    script_src: "script-src",
    style_src: "style-src",
    style_src_attr: "style-src-attr",
    img_src: "img-src",
    font_src: "font-src",
    connect_src: "connect-src",
    frame_src: "frame-src",
    media_src: "media-src",
  };
  for (const [key, alias] of Object.entries(aliases)) {
    const origins = csp[key];
    if (key === "style_src_attr" && (origins === undefined || origins.length === 0)) continue;
    const all = new Set(["'self'", ...(origins ?? [])]);
    directives.push(`${alias} ${[...all].join(" ")}`);
  }
  directives.push("object-src 'none'", "base-uri 'self'", "frame-ancestors 'self'");
  return directives.join("; ");
}
