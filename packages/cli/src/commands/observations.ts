// Agent observations CLI (owner 2026-10-06): the update-report contract
// (REGISTRY-INSTANCES-V2 §4) ships agent-observations.md from the state root
// verbatim — but the file NEVER had a CLI/API write surface. When the owner
// restricted site agents to "CLI only" (no OS filesystem commands), the
// pre-update observations requirement became undeliverable. This command is
// the sanctioned channel; the apply path (registry route + installer) reads
// the same file.
//
//   cms observations show    [--config <path>]
//   cms observations append  --text <t> [--config <path>]
//   cms observations clear   [--config <path>]
//
// The file lives at dirname(dirname(themes.renderDir))/agent-observations.md
// (the state root — NOT the themes dir itself, per the 2026-10-01 contract).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "@pcms/core";
import { type CliCommandResult, failureResult, type GlobalOptions } from "../framework.js";

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const USAGE = `usage: cms observations <subcommand> [--config <path>]
  show                     print the current observations (empty = none)
  append --text <text>     append one observation line (pre-update requirement)
  [--file <path>]          explicit file override (dev; server installs derive
                           it from the config themes.renderDir state root)
  clear                    remove the file after it shipped with a report
`;

function observationsFile(
  argvConfig: string | undefined,
  env: NodeJS.ProcessEnv,
  fileOverride: string | undefined,
): string {
  if (fileOverride !== undefined && fileOverride !== "") return fileOverride;
  const config = loadConfig(argvConfig === undefined ? { env } : { file: argvConfig, env });
  const renderDir = config.themes?.renderDir;
  if (renderDir === undefined || renderDir === "") {
    throw new Error(
      "config has no themes.renderDir — cannot derive the observations path (the file lives in the state root, two levels above the theme dir); pass --file explicitly for development runs",
    );
  }
  return join(dirname(dirname(renderDir)), "agent-observations.md");
}

export async function observationsCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const subcommand = args[0];
  try {
    // --config is a GLOBAL flag (parseGlobalOptions strips it into
    // options.config before the command sees the args).
    const file = observationsFile(options.config, env, optionValue(args, "--file"));

    if (subcommand === "show") {
      try {
        const text = readFileSync(file, "utf8");
        return options.json === true
          ? { exitCode: 0, stdout: JSON.stringify({ file, content: text }), stderr: "" }
          : { exitCode: 0, stdout: text === "" ? "(no observations)\n" : text, stderr: "" };
      } catch {
        return { exitCode: 0, stdout: "(no observations)\n", stderr: "" };
      }
    }

    if (subcommand === "append") {
      const textIndex = args.indexOf("--text");
      const text = textIndex >= 0 ? args[textIndex + 1] : undefined;
      if (text === undefined || text.trim() === "") {
        return { exitCode: 3, stdout: "", stderr: "--text <observation> is required\n" };
      }
      const line = `- ${new Date().toISOString()} — ${text.trim()}\n`;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, readFileSyncSafe(file) + line, { flag: "a" });
      return options.json === true
        ? { exitCode: 0, stdout: JSON.stringify({ appended: true, file }), stderr: "" }
        : { exitCode: 0, stdout: `appended to ${file}\n`, stderr: "" };
    }

    if (subcommand === "clear") {
      rmSync(file, { force: true });
      return { exitCode: 0, stdout: "cleared\n", stderr: "" };
    }

    return { exitCode: 2, stdout: "", stderr: USAGE };
  } catch (error) {
    return failureResult(error, options);
  }
}

function readFileSyncSafe(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
