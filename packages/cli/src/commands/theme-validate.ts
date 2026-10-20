// cms theme validate <dir> (PCMS-THEME-T019; Theme Contract spec §50).
// Machine-readable validation report; follows the minimal M01 dispatcher
// conventions (--json output, positional theme directory).
import { readdirSync } from "node:fs";
import { type ThemeValidationReport, validateThemeDir } from "@pcms/themes";
import { localCmsVersion } from "../cms-version.js";
import type { CliResult } from "../main.js";

interface ThemeValidateOptions {
  readonly args: readonly string[];
}

function parseArgs(args: readonly string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--cms-version") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("missing value for --cms-version");
      parsed.cmsVersion = value;
      index += 1;
    } else if (!arg.startsWith("-") && parsed.positional === undefined) {
      parsed.positional = arg;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return parsed;
}

export function themeValidate(options: ThemeValidateOptions): CliResult {
  let parsed: Record<string, string | boolean>;
  try {
    parsed = parseArgs(options.args);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  const themeDir =
    typeof parsed.positional === "string" ? parsed.positional : "themes/reference-theme-v1";
  const cmsVersion = typeof parsed.cmsVersion === "string" ? parsed.cmsVersion : localCmsVersion();
  const baseReport: ThemeValidationReport = validateThemeDir(themeDir, {
    ...(cmsVersion === undefined ? {} : { cmsVersion }),
  });
  // Rec 10 (152fz recommendations): local validation must match packer
  // acceptance — a stray file/dir in the package root passes validateThemeDir
  // but fails install-package's allow-list. Report as a blocking issue.
  const rootIssues: { check: string; code: string; path: string; message: string }[] = [];
  const allowed = new Set([
    "theme.json",
    "THEME.md",
    "README.md",
    "CHANGELOG.md",
    "blocks/",
    "templates/",
    "components/",
    "tokens/",
    "fixtures/",
    "assets/",
    "scripts/",
    "styles/",
    "locales/",
    "tests/",
    "content-types.json",
  ]);
  for (const name of readdirSync(themeDir)) {
    const entry = name.includes(".") ? name : `${name}/`;
    if (!allowed.has(entry)) {
      rootIssues.push({
        check: "package-root",
        code: "THEME_PACKAGE_ROOT_UNKNOWN",
        message: `unknown package root entry "${name}" — install-package would reject the archive`,
        path: name,
      });
    }
  }
  const report: ThemeValidationReport = {
    theme: baseReport.theme,
    ok: baseReport.ok && rootIssues.length === 0,
    issues: [...baseReport.issues, ...rootIssues],
  };
  if (parsed.json === true) {
    return {
      exitCode: report.ok ? 0 : 1,
      stdout: `${JSON.stringify(report, null, 2)}\n`,
      stderr: "",
    };
  }
  const lines = [`theme: ${report.theme ?? "(unknown)"}`, `ok: ${report.ok ? "yes" : "no"}`];
  for (const issue of report.issues) {
    lines.push(`  [${issue.check}] ${issue.code}: ${issue.message} (${issue.path})`);
  }
  return {
    exitCode: report.ok ? 0 : 1,
    stdout: `${lines.join("\n")}\n`,
    stderr: "",
  };
}
