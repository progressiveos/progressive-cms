// cms mail test (PCMS-OPS-T110; Operations spec §31). Safe connection probe
// against the configured transport; with --to <addr>, delivers one test
// message. Diagnostics never contain credentials (server-side contract).
import { apiCall, machineResult, resolveApiClient } from "../api-client.js";
import type { CliCommandResult, GlobalOptions } from "../framework.js";

const USAGE = `usage: cms mail test [--to <address>] [--json]
  Probe the configured mail transport (reach + authenticate, sends nothing).
  With --to, one test message is delivered to <address>.
  Requires PCMS_API_URL + PCMS_API_TOKEN and integrations.test scope.
`;

export async function mailCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const toIndex = args.indexOf("--to");
  const to = toIndex >= 0 ? args[toIndex + 1] : undefined;
  try {
    if (args[0] !== "test") {
      return { exitCode: 2, stdout: "", stderr: USAGE };
    }
    if (toIndex >= 0 && (to === undefined || to === "")) {
      return { exitCode: 2, stdout: "", stderr: "--to requires an address\n" };
    }
    const client = resolveApiClient(options, env);
    if (typeof client === "string") {
      return { exitCode: 3, stdout: "", stderr: `cms mail test: ${client}\n` };
    }
    const response = await apiCall(client, "POST", "/mail/test", to === undefined ? {} : { to });
    if (!response.ok) return response.result;
    return machineResult(response.body);
  } catch (error) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: `cms mail test: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}
