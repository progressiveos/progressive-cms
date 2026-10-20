// cms theme list (owner directive 2026-09-29: themes join
// the artifact/registry lifecycle; the renderDir theme is the active one and
// is never overwritten or deleted through this surface). Offline transport:
// reads themes.renderDir from the config and operates on the themes root
// (its parent directory) directly — the operator runs this ON the host.
//   cms theme list [--json]
// Package mutations use the authenticated API in theme-update.ts.

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { loadConfig } from "@pcms/core";
import { listInstalledThemes, ThemeInstallError } from "@pcms/themes";
import type { CliResult } from "../main.js";

interface ThemeManageOptions {
  readonly args: readonly string[];
}

function parseArgs(args: readonly string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--json") {
      parsed.json = true;
    } else if (!arg.startsWith("-") && parsed.positional === undefined) {
      parsed.positional = arg;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return parsed;
}

function fail(error: unknown): CliResult {
  const code = error instanceof ThemeInstallError ? error.code : "THEME_COMMAND_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: code === "THEME_NOT_INSTALLED" ? 6 : 3,
    stdout: "",
    stderr: `${code}: ${message}\n`,
  };
}

function themesRootOf(): { root: string; renderDirId: string } {
  const config = loadConfig({ env: process.env, cwd: process.cwd() });
  const renderDir = (config.themes as { renderDir?: string } | undefined)?.renderDir;
  if (renderDir === undefined || renderDir.length === 0) {
    throw new ThemeInstallError(
      "THEME_NO_RENDER_DIR",
      "themes.renderDir is not configured — nothing to manage",
    );
  }
  let renderDirId = basename(renderDir);
  try {
    const manifest = JSON.parse(readFileSync(renderDir, "utf8")) as { id?: unknown };
    if (typeof manifest.id === "string") renderDirId = manifest.id;
  } catch {
    // renderDir without a readable manifest: basename is the best identity we have.
  }
  return { root: dirname(renderDir), renderDirId };
}

export function themeManage(options: ThemeManageOptions): Promise<CliResult> {
  return run(options);
}

async function run(options: ThemeManageOptions): Promise<CliResult> {
  let parsed: Record<string, string | boolean>;
  try {
    parsed = parseArgs(options.args.slice(1));
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  const subcommand = options.args[0];
  try {
    const { root, renderDirId } = themesRootOf();
    if (subcommand === "list" || subcommand === undefined) {
      const themes = listInstalledThemes(root, renderDirId).map((theme) => ({
        ...theme,
        active: theme.isRenderTarget,
      }));
      if (parsed.json === true) {
        return { exitCode: 0, stdout: `${JSON.stringify({ themes }, null, 2)}\n`, stderr: "" };
      }
      const lines = themes.map(
        (theme) =>
          `${theme.active ? "*" : " "} ${theme.id} ${theme.version} ${theme.name}` +
          (theme.broken === null ? "" : `  [broken: ${theme.broken}]`),
      );
      return {
        exitCode: 0,
        stdout: `${["themes (* = rendered by themes.renderDir):", ...lines].join("\n")}\n`,
        stderr: "",
      };
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: `unknown theme subcommand: ${subcommand ?? "(none)"} (use list)\n`,
    };
  } catch (error) {
    if (error instanceof ThemeInstallError) return fail(error);
    // Config errors and the like surface verbatim (typed CONFIG_* contracts).
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}
