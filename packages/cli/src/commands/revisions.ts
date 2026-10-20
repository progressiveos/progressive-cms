// Revisions CLI (owner 2026-10-06, iterative-editing case): bulk cleanup of
// near-identical sealed revisions — everything except the currently
// published one. The working revision is always kept.
//
//   cms revisions cleanup --entry <entryId> [--environment <env>] [--yes]
import { type ApiClientOptions, apiCall, machineResult, resolveApiClient } from "../api-client.js";
import {
  type CliCommandResult,
  failureResult,
  type GlobalOptions,
  requireTargetSafety,
} from "../framework.js";

const USAGE = `usage: cms revisions <subcommand> [--json]
  cleanup --entry <entryId> [--environment <env>] [--yes]
                                      delete all SEALED revisions of the entry
                                      except the currently published one; the
                                      working revision is always kept; refuses
                                      entries without a published revision
`;

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv): ApiClientOptions {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function revisionsCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const subcommand = args[0];
  try {
    if (subcommand !== "cleanup") {
      return { exitCode: 2, stdout: "", stderr: USAGE };
    }
    const safety = requireTargetSafety(options, "revisions cleanup");
    if (safety !== null) return safety;

    const entry = optionValue(args, "--entry");
    if (entry === undefined || entry === "") {
      return { exitCode: 3, stdout: "", stderr: "--entry <entryId> is required\n" };
    }
    const response = await apiCall(
      clientOrThrow(options, env),
      "POST",
      `/entries/${encodeURIComponent(entry)}/revisions/cleanup`,
      {},
    );
    if (!response.ok) return response.result;
    return machineResult(response.body);
  } catch (error) {
    return failureResult(error, options);
  }
}
