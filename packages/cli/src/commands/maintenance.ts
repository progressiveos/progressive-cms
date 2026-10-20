// Maintenance CLI commands (PCMS-OPS-T118; task brief §34).
//   cms maintenance status  [--json]                 show current state
//   cms maintenance enable  [--environment <e>] [--yes]
//   cms maintenance disable [--environment <e>] [--yes]
//       Toggle the public maintenance mode (or edit copy with
//       `enable --title/--message/--promo-url/...`). Operations go through
//       the same REST surface as the Admin screen — the CLI is the operator
//       path for when the Admin UI cannot be reached but the app/API still
//       runs. Server-side permission: site.maintenance; mutations audited.

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

const USAGE = `usage: cms maintenance <subcommand> [--json]
  status                              show the current maintenance state
  enable [--environment <env>] [--yes] [--title <t>] [--message <m>]
         [--promo-label <l>] [--promo-url <u>] [--retry-after <seconds>]
                                      enable maintenance (audited)
  disable [--environment <env>] [--yes]
                                      disable maintenance (audited)
`;

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function maintenanceCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const subcommand = args[0];
  try {
    if (subcommand !== "status" && subcommand !== "enable" && subcommand !== "disable") {
      return { exitCode: 2, stdout: "", stderr: USAGE };
    }
    const client = clientOrThrow(options, env);

    if (subcommand === "status") {
      const response = await apiCall(client, "GET", "/maintenance");
      if (!response.ok) return response.result;
      return machineResult(response.body);
    }

    // enable/disable: operator safety contract (mirrors publication/update
    // mutations — an accidental toggle must not succeed silently).
    const safety = requireTargetSafety(options, `maintenance ${subcommand}`);
    if (safety !== null) return safety;

    if (subcommand === "disable") {
      const response = await apiCall(client, "PUT", "/maintenance", { enabled: false });
      if (!response.ok) return response.result;
      return machineResult(response.body);
    }

    const body: Record<string, unknown> = { enabled: true };
    const title = optionValue(args, "--title");
    const message = optionValue(args, "--message");
    const promoLabel = optionValue(args, "--promo-label");
    const promoUrl = optionValue(args, "--promo-url");
    const retryAfter = optionValue(args, "--retry-after");
    if (title !== undefined) body.title = title;
    if (message !== undefined) body.message = message;
    if (promoLabel !== undefined) body.promoLabel = promoLabel;
    if (promoUrl !== undefined) body.promoUrl = promoUrl;
    if (retryAfter !== undefined) {
      const seconds = Number(retryAfter);
      if (!Number.isInteger(seconds)) {
        return { exitCode: 3, stdout: "", stderr: "--retry-after expects integer seconds\n" };
      }
      body.retryAfterSeconds = seconds;
    }
    const response = await apiCall(client, "PUT", "/maintenance", body);
    if (!response.ok) return response.result;
    return machineResult(response.body);
  } catch (error) {
    return failureResult(error, options);
  }
}
