// Update CLI commands (PCMS-EXT-T013/T014; Extensions spec §23–§25).
//   cms update check --manifest <file> [--json]
//       Read-only preflight: sends the operator-supplied target manifest to
//       the server for evaluation against a live compatibility snapshot. The
//       server performs NO writes; the command never runs migrations.
//   cms update apply --manifest <file> [--environment <env>] [--yes]
//       Orchestration contract entry point. Fails closed with
//       UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE until the M15 Operations
//       deployment adapter is connected — never fakes a successful update.
import { readFileSync } from "node:fs";
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

const USAGE = `usage: cms update <subcommand> [--json]
  check --manifest <file>            read-only target release preflight
  apply --manifest <file> --environment <env> --yes
                                     orchestration contract (fails closed
                                     without the M15 deployment adapter)
`;

export async function updateCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const manifestFlag = args.indexOf("--manifest");
  const manifestPath = manifestFlag >= 0 ? args[manifestFlag + 1] : undefined;
  try {
    if (args[0] !== "check" && args[0] !== "apply") {
      return { exitCode: 2, stdout: "", stderr: USAGE };
    }
    if (manifestPath === undefined || manifestPath === "") {
      return {
        exitCode: 3,
        stdout: "",
        stderr: "update check requires --manifest <file> (operator-supplied target release)\n",
      };
    }
    let manifestDocument: unknown;
    try {
      manifestDocument = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      return {
        exitCode: 3,
        stdout: "",
        stderr: `cannot read manifest "${manifestPath}": ${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
    const client = clientOrThrow(options, env);
    if (args[0] === "check") {
      const response = await apiCall(client, "POST", "/update/preflight", {
        manifest: manifestDocument,
      });
      if (!response.ok) return response.result;
      return machineResult(response.body);
    }
    // update apply: requires the operator safety contract; the server-side
    // orchestration still fails closed without M15 adapters.
    const safety = requireTargetSafety(options, "update apply");
    if (safety !== null) return safety;
    const response = await apiCall(client, "POST", "/update/apply", {
      manifest: manifestDocument,
      // Backup acknowledgment: the orchestrator compares this against the
      // target version when backup_required is set (Extensions §25).
      backup_confirmation: JSON.parse(readFileSync(manifestPath, "utf8")).version,
    });
    if (!response.ok) return response.result;
    return machineResult(response.body);
  } catch (error) {
    return failureResult(error, options);
  }
}
