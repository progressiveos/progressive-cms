// CLI framework (PCMS-API-T022; API spec §56–§59).
//
// Global conventions for the M09 command generation:
//   --json            deterministic machine output on stdout, no ANSI noise
//   --profile <name>  selects config `pcms.<name>.json` (dev/stage/prod…);
//                     the active profile is echoed in machine output
//   --environment     explicit environment for dangerous operations (fail
//                     -secure: absent = refuse)
//   --yes             confirms a dangerous operation in automation mode
//   --config <path>   explicit config file (wins over --profile)
//
// Exit codes (spec §57 — documented and tested):
//   0 success           3 validation       6 not found
//   1 unexpected        4 conflict          7 transient dependency
//   2 usage/input       5 authorization
// The M08 recovery families keep their pinned 0/1/2 behavior (compatibility,
// owner instruction #91); the mapping below covers the framework commands.
import { isStableId } from "@pcms/core";

export interface GlobalOptions {
  readonly json: boolean;
  readonly profile?: string;
  readonly config?: string;
  readonly environment?: string;
  readonly site?: string;
  readonly yes: boolean;
}

export interface CliCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Splits recognized global flags off the argument list. */
export function parseGlobalOptions(
  args: readonly string[],
): { options: GlobalOptions; rest: string[] } | undefined {
  const options: {
    json: boolean;
    profile?: string;
    config?: string;
    environment?: string;
    site?: string;
    yes: boolean;
  } = {
    json: false,
    yes: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (
      arg === "--profile" ||
      arg === "--config" ||
      arg === "--environment" ||
      arg === "--site"
    ) {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      if (arg === "--profile") options.profile = value;
      if (arg === "--config") options.config = value;
      if (arg === "--environment") options.environment = value;
      if (arg === "--site") options.site = value;
      i += 1;
    } else {
      rest.push(arg);
    }
  }
  return { options, rest };
}

/** Stable error class → exit code (spec §57 mapping). */
/** Config file resolution: explicit --config wins, else pcms.<profile>.json. */
export function configLoadOptions(
  options: GlobalOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
): { env: NodeJS.ProcessEnv; cwd: string } | { file: string; env: NodeJS.ProcessEnv; cwd: string } {
  if (options.config !== undefined) return { file: options.config, env, cwd };
  if (options.profile !== undefined) return { file: `pcms.${options.profile}.json`, env, cwd };
  return { env, cwd };
}

export function exitCodeForError(error: unknown): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const code =
    error instanceof Error && typeof (error as { code?: unknown }).code === "string"
      ? (error as unknown as { code: string } as { code: string }).code
      : null;
  if (code === null) return 1;
  if (code === "CLI_USAGE_INVALID") return 2;
  if (/_CONFLICT$|_COLLISION$|_STALE$|_TAKEN$|_ALREADY_|_IN_USE$/.test(code)) return 4;
  if (/_DENIED$/.test(code)) return 5;
  // Operator setup (no config file / config does not parse) is usage-level:
  // the fix is an operator flag, not a server-side investigation.
  if (/^CONFIG_NOT_FOUND$|^CONFIG_INVALID$/.test(code)) return 2;
  if (/_NOT_FOUND$|_TARGET_MISSING$/.test(code)) return 6;
  if (/_THROTTLED$|_RATE_LIMITED$|_PERSISTENCE_FAILED$|_UNAVAILABLE$/.test(code)) return 7;
  if (
    /_INVALID$|_REQUIRED$|_VALIDATION_FAILED$|_UNSUPPORTED$|_MISSING$|_EMPTY$|_TOO_LARGE$/.test(
      code,
    )
  ) {
    return 3;
  }
  if (/_UNCONFIGURED$/.test(code)) return 2; // operator setup, not a crash
  return 1;
}

/** JSON machine output: one stable envelope, no ANSI, trailing newline. */
export function jsonPayload(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function errorPayload(error: unknown): Record<string, unknown> {
  const code =
    error instanceof Error && typeof (error as { code?: unknown }).code === "string"
      ? (error as unknown as { code: string } as { code: string }).code
      : "INTERNAL_ERROR";
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/** Framework-standard failure result from a thrown error. */
export function failureResult(error: unknown, options: GlobalOptions): CliCommandResult {
  const exitCode = exitCodeForError(error);
  if (options.json) {
    return { exitCode, stdout: jsonPayload(errorPayload(error)), stderr: "" };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { exitCode, stdout: "", stderr: `error: ${message}\n` };
}

/** Dangerous operations require an explicit target (spec §58): refuse otherwise. */
export function requireTargetSafety(
  options: GlobalOptions,
  command: string,
): CliCommandResult | null {
  if (options.environment !== undefined && options.yes) return null;
  const problem =
    options.environment === undefined
      ? `refusing to run "${command}" without an explicit --environment target`
      : `refusing to run "${command}" against environment "${options.environment}" without --yes`;
  if (options.json) {
    return {
      exitCode: 2,
      stdout: jsonPayload({ ok: false, error: { code: "TARGET_UNCONFIRMED", message: problem } }),
      stderr: "",
    };
  }
  return { exitCode: 2, stdout: "", stderr: `${problem}\n` };
}

export { isStableId };
