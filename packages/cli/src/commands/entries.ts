// Entries CLI family (owner 2026-10-06): the identity-locale repair op has a
// REST surface only — site agents on "CLI-only" deployments had no way to run
// the sanctioned identity repair (the /privacy/ locale case).
//
//   cms entries identity-locale <entryId> --locale <tag>
//        [--environment <env>] [--yes]
import { type ApiClientOptions, apiCall, machineResult, resolveApiClient } from "../api-client.js";
import {
  type CliCommandResult,
  failureResult,
  type GlobalOptions,
  requireTargetSafety,
} from "../framework.js";

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv): ApiClientOptions {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

const USAGE = `usage: cms entries <subcommand> [--json]
  route change <entryId> --to-path <path> [--reason <text>] [--yes]
  identity-locale <entryId> --locale <tag> [--environment <env>] [--yes]
                                      identity repair: move the entry and its
                                      working revisions to the locale (one
                                      transaction; entry id, routes, publication
                                      pointers, payloads, edit generations
                                      untouched; sealed history immutable).
                                      Refuses locales outside the site policy
                                      and translation-group members.
`;

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function entriesCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const subcommand = args[0];
  try {
    if (subcommand === "route" && args[1] === "change") {
      const id = args[2];
      const flags = args.slice(3);
      const values: Record<string, string> = {};
      for (let i = 0; i < flags.length; i++) {
        const flag = flags[i]!;
        const value = flags[++i];
        if (!["--to-path", "--reason"].includes(flag) || !value || value.startsWith("--"))
          return { exitCode: 2, stdout: "", stderr: USAGE };
        values[flag] = value;
      }
      const path = values["--to-path"];
      if (!id || id.startsWith("--") || !path) return { exitCode: 2, stdout: "", stderr: USAGE };
      const client = clientOrThrow(options, env);
      const endpoint = `/entries/${encodeURIComponent(id)}/route`;
      if (!options.yes) {
        const current = await apiCall(client, "GET", endpoint);
        if (!current.ok) return current.result;
        return {
          exitCode: 2,
          stdout:
            JSON.stringify(
              {
                ok: false,
                current: current.body,
                to_path: path,
                error: {
                  code: "TARGET_UNCONFIRMED",
                  message: "Review canonical route and 301 impact, then confirm with --yes",
                },
              },
              null,
              2,
            ) + "\n",
          stderr: "Route unchanged; confirm canonical move and 301 with --yes.\n",
        };
      }
      const response = await apiCall(client, "POST", `${endpoint}/change`, {
        to_path: path,
        ...(values["--reason"] === undefined ? {} : { reason: values["--reason"] }),
      });
      return response.ok ? machineResult(response.body) : response.result;
    }
    if (subcommand !== "identity-locale") {
      return { exitCode: 2, stdout: "", stderr: USAGE };
    }
    // Operator safety contract (mirrors publication/maintenance mutations).
    const safety = requireTargetSafety(options, "entries identity-locale");
    if (safety !== null) return safety;

    const entryId = args[1];
    const locale = optionValue(args, "--locale");
    if (entryId === undefined || entryId === "" || locale === undefined || locale === "") {
      return { exitCode: 3, stdout: "", stderr: "entry id and --locale <tag> are required\n" };
    }
    const response = await apiCall(
      clientOrThrow(options, env),
      "POST",
      `/entries/${encodeURIComponent(entryId)}/identity-locale`,
      { locale },
    );
    if (!response.ok) return response.result;
    return machineResult(response.body);
  } catch (error) {
    return failureResult(error, options);
  }
}
