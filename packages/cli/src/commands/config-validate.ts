// `cms config validate` (PCMS-OPS-T002, Operations spec §8/§10).
// Exit codes: 0 valid, 1 invalid, 2 usage. JSON output is deterministic;
// it contains no secret values by construction — the config document holds
// only named secret references (ADR-0004).
import { type AppConfig, ConfigError, loadConfig, resolveConfigFile } from "@pcms/core";

export interface ConfigValidateInvocation {
  readonly args: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
}

export interface ConfigValidateResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export function configValidate(invocation: ConfigValidateInvocation): ConfigValidateResult {
  const parsed = parseArgs(invocation.args);
  if (!parsed) {
    return usage();
  }
  const { file, json } = parsed;
  const env = invocation.env ?? process.env;
  const cwd = invocation.cwd ?? process.cwd();
  const options = file === undefined ? { env, cwd } : { file, env, cwd };
  const resolvedFile = resolveConfigFile(options);

  let config: AppConfig;
  try {
    config = loadConfig(options);
  } catch (error) {
    const issues =
      error instanceof ConfigError ? error.issues : [{ path: "(error)", message: String(error) }];
    if (json) {
      return {
        exitCode: 1,
        stdout: `${JSON.stringify({ ok: false, file: resolvedFile, issues }, null, 2)}\n`,
        stderr: "",
      };
    }
    const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
    return {
      exitCode: 1,
      stdout: [
        `file: ${resolvedFile}`,
        `result: INVALID (${issues.length} issue(s))`,
        ...lines,
        "",
      ].join("\n"),
      stderr: "",
    };
  }

  if (json) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true, file: resolvedFile, config }, null, 2)}\n`,
      stderr: "",
    };
  }
  const summary = [
    `nodeEnv=${config.nodeEnv}`,
    `db=${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`,
    `sslMode=${config.db.sslMode}`,
    `log=${config.log.level}`,
  ].join(", ");
  return {
    exitCode: 0,
    stdout: [`file: ${resolvedFile}`, `result: VALID`, `summary: ${summary}`, ""].join("\n"),
    stderr: "",
  };
}

function parseArgs(
  args: readonly string[],
): { file: string | undefined; json: true | undefined } | undefined {
  let file: string | undefined;
  let json: true | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--config") {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      file = value;
      i += 1;
    } else {
      return undefined;
    }
  }
  return { file, json };
}

function usage(): ConfigValidateResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: [
      "usage: cms config validate [--json] [--config <path>]",
      "",
      "Validates the Progressive CMS configuration file (default: ./config/pcms.json,",
      "overridable via --config or PCMS_CONFIG_FILE). Exit code 0 = valid, 1 = invalid,",
      "2 = usage error.",
      "",
    ].join("\n"),
  };
}
