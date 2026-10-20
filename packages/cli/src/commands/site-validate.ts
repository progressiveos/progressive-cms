// cms site validate (PCMS-THEME-T020; Theme Contract spec §51).
// Theme/content compatibility: validates the reference site content
// (definitions + fixtures file, M02 corpus format) against a theme.
// The CLI is the composition layer — it maps content/blocks data into the
// plain-data shapes @pcms/themes expects.
import { existsSync, readFileSync } from "node:fs";
import {
  parseThemeManifest,
  type SiteBlockInfo,
  type SiteEntryInfo,
  validateSiteAgainstTheme,
} from "@pcms/themes";
import type { CliResult } from "../main.js";

interface SiteValidateOptions {
  readonly args: readonly string[];
}

interface DefinitionsFile {
  contentTypes: { key: string; version: number; fields: Record<string, unknown> }[];
  fixtures: {
    name: string;
    contentType: string;
    expect: string;
    level: string;
    fields: Record<string, unknown>;
  }[];
}

function parseArgs(args: readonly string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--theme" || arg === "--content") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`option ${arg} requires a value`);
      parsed[arg.slice(2)] = value;
      index += 1;
    } else if (!arg.startsWith("-") && parsed.positional === undefined) {
      parsed.positional = arg;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return parsed;
}

function toSiteBlocks(value: unknown): SiteBlockInfo[] {
  if (typeof value !== "object" || value === null) return [];
  const blocks = (value as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return [];
  return blocks.map((b) => {
    const node = b as Record<string, unknown>;
    return {
      id: String(node.id ?? ""),
      type: String(node.type ?? ""),
      schemaVersion: Number(node.schema_version ?? 1),
      variant: node.variant === null || node.variant === undefined ? null : String(node.variant),
      children: toSiteBlocks(node),
    };
  });
}

export async function siteValidate(options: SiteValidateOptions): Promise<CliResult> {
  let parsed: Record<string, string | boolean>;
  try {
    parsed = parseArgs(options.args);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  const themeDir = typeof parsed.theme === "string" ? parsed.theme : "themes/reference-theme-v1";
  const contentFile =
    typeof parsed.content === "string"
      ? parsed.content
      : "fixtures/content/reference-content-types.json";

  let manifest: ReturnType<typeof parseThemeManifest>;
  try {
    manifest = parseThemeManifest(readFileSync(`${themeDir}/theme.json`, "utf8"));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cannot read theme manifest: ${(error as Error).message}\n`,
    };
  }
  // Default corpus is release-shipped; a deployment without it (corpus not
  // explicitly passed) skips the content-compat pass with a hint instead of
  // a hard failure (theme developer report 0.1.119→0.123).
  if (parsed.content === undefined && !existsSync(contentFile)) {
    return {
      exitCode: 0,
      stdout:
        `site validate: skipped content-compatibility pass\n` +
        `(default corpus ${contentFile} is absent; pass --content <corpus.json> to run it)\n`,
      stderr: "",
    };
  }
  if (!manifest.ok) {
    return { exitCode: 1, stdout: "", stderr: `invalid theme manifest in "${themeDir}"\n` };
  }

  let definitions: DefinitionsFile;
  try {
    definitions = JSON.parse(readFileSync(contentFile, "utf8")) as DefinitionsFile;
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cannot read content file "${contentFile}": ${(error as Error).message}\n`,
    };
  }
  if (!Array.isArray(definitions.contentTypes) || !Array.isArray(definitions.fixtures)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `content file "${contentFile}" is not the M02 corpus format (expected {"contentTypes":[...],"fixtures":[...]}); the live site config (content-types.json) is validated by "cms config validate" and "cms schema validate" instead\n`,
    };
  }

  const contentTypes = definitions.contentTypes.map((ct) => ({
    key: ct.key,
    version: ct.version,
    fieldIds: Object.keys(ct.fields ?? {}),
  }));
  const entries: SiteEntryInfo[] = definitions.fixtures
    .filter((f) => f.expect === "valid")
    .map((f) => {
      const definition = definitions.contentTypes.find((ct) => ct.key === f.contentType);
      const blockField = Object.entries(f.fields).find(
        ([, v]) =>
          typeof v === "object" && v !== null && "blocks" in (v as Record<string, unknown>),
      );
      return {
        id: f.name,
        contentTypeKey: f.contentType,
        contentTypeVersion: definition?.version ?? 1,
        templateKey: `${f.contentType}-default`,
        fieldIds: Object.keys(f.fields),
        blocks: blockField === undefined ? [] : toSiteBlocks(blockField[1]),
      };
    });

  const report = validateSiteAgainstTheme(manifest.value, contentTypes, entries, {
    globals: ["contacts", "company"],
  });
  const json = {
    theme: report.theme,
    entries: report.entries,
    ok: report.ok,
    issues: report.issues,
  };
  if (parsed.json === true) {
    return {
      exitCode: report.ok ? 0 : 1,
      stdout: `${JSON.stringify(json, null, 2)}\n`,
      stderr: "",
    };
  }
  const lines = [
    `theme: ${report.theme}`,
    `entries: ${report.entries}`,
    `ok: ${report.ok ? "yes" : "no"}`,
  ];
  for (const issue of report.issues) {
    lines.push(`  ${issue.code} [${issue.entryId}] ${issue.message} (${issue.path})`);
  }
  return { exitCode: report.ok ? 0 : 1, stdout: `${lines.join("\n")}\n`, stderr: "" };
}
