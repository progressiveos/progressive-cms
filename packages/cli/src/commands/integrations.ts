// Integrations CLI commands (PCMS-INT-T016; Integrations spec §43).
//   cms integrations connectors             connector catalog
//   cms integrations instances              configured connections
//   cms integrations instance-test <id>     safe connection probe
//   cms integrations bindings               event→action bindings
//   cms integrations deliveries [status]    delivery history (reliability)
//   cms integrations delivery <id>          one delivery + attempt history
//   cms integrations retry <deliveryId>     manual retry (audited)
//   cms integrations inbound                inbound events (metadata only)
//   cms integrations secrets init           LOCAL runtime secret store setup
// API operations run against the CMS API (PCMS_API_URL + PCMS_API_TOKEN);
// `secrets init` works directly on the local config + secret files.

import { apiCall, machineResult, resolveApiClient } from "../api-client.js";
import { type CliCommandResult, failureResult, type GlobalOptions } from "../framework.js";
import { integrationsSecretsInit } from "./secrets-init.js";

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv) {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

const USAGE = `usage: cms integrations <subcommand> [--json]
  connectors | instances | bindings | inbound | deliveries [status] | delivery <id> | instance-test <id> | retry <id>
  secrets init [--config <path>] [--secret-dir <dir>]   (local, no API token)
`;

export async function integrationsCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const [subcommand, operand] = args;
  try {
    // Local operator provisioning (owner task §34) — no API client needed.
    if (subcommand === "secrets") {
      const [operation, ...rest] = args.slice(1);
      if (operation !== "init") return { exitCode: 2, stdout: "", stderr: USAGE };
      return await integrationsSecretsInit({ args: rest, options, env });
    }
    const client = clientOrThrow(options, env);
    const get = async (path: string) => {
      const response = await apiCall(client, "GET", path);
      if (!response.ok) return response.result;
      return machineResult(response.body);
    };
    switch (subcommand) {
      case "connectors":
        return await get("/integrations/connectors");
      case "instances":
        return await get("/integrations/instances");
      case "bindings":
        return await get("/integrations/bindings");
      case "inbound":
        return await get("/integrations/inbound-events");
      case "deliveries":
        return await get(
          operand === undefined || operand === ""
            ? "/integrations/deliveries"
            : `/integrations/deliveries?status=${encodeURIComponent(operand)}`,
        );
      case "delivery":
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        return await get(`/integrations/deliveries/${operand}`);
      case "instance-test": {
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        const response = await apiCall(client, "POST", `/integrations/instances/${operand}/test`);
        if (!response.ok) return response.result;
        return machineResult(response.body);
      }
      case "retry": {
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        const response = await apiCall(client, "POST", `/integrations/deliveries/${operand}/retry`);
        if (!response.ok) return response.result;
        return machineResult(response.body);
      }
      default:
        return { exitCode: 2, stdout: "", stderr: USAGE };
    }
  } catch (error) {
    return failureResult(error, options);
  }
}
