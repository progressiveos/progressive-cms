// Extensions CLI commands (PCMS-EXT-T019; Extensions spec §48).
//   cms extensions list                        deployed extensions + state
//   cms extensions compatibility <id>          machine-readable issues
//   cms extensions install <id> [--check]      trusted artifact activation
//   cms extensions enable <id> [--check]       preflight gate + enable
//   cms extensions disable <id> [--check]      impact preflight + disable
//   cms extensions uninstall <id> [--check]    data-policy gated removal
// All operations run against the CMS API (PCMS_API_URL + PCMS_API_TOKEN).

import { type ApiClientOptions, apiCall, machineResult, resolveApiClient } from "../api-client.js";
import { type CliCommandResult, failureResult, type GlobalOptions } from "../framework.js";

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv): ApiClientOptions {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

const USAGE = `usage: cms extensions <subcommand> [--json]
  list | compatibility <extensionId>
  install <extensionId> [--check] [--extension-config <json>]
  enable <extensionId> [--check]
  disable <extensionId> [--check]
  uninstall <extensionId> [--check] [--confirmation <id>]
`;

async function get(client: ApiClientOptions, path: string): Promise<CliCommandResult> {
  const response = await apiCall(client, "GET", path);
  if (!response.ok) return response.result;
  return machineResult(response.body);
}

async function post(
  client: ApiClientOptions,
  path: string,
  body: Record<string, unknown> | undefined,
): Promise<CliCommandResult> {
  const response = await apiCall(client, "POST", path, body === undefined ? {} : body);
  if (!response.ok) return response.result;
  return machineResult(response.body);
}

export async function extensionsCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const [subcommand, operand, ...rest] = args;
  const checkOnly = rest.includes("--check");
  const configFlag = rest.indexOf("--extension-config");
  const confirmationFlag = rest.indexOf("--confirmation");
  try {
    const client = clientOrThrow(options, env);
    switch (subcommand) {
      case "list":
        return await get(client, "/extensions");
      case "compatibility":
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        return await get(client, `/extensions/${encodeURIComponent(operand)}/compatibility`);
      case "install":
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        if (checkOnly) {
          return await get(client, `/extensions/${encodeURIComponent(operand)}/compatibility`);
        }
        {
          // Legacy JSON --config remains accepted; file-valued --config stays global.
          const rawConfig =
            configFlag >= 0
              ? rest[configFlag + 1]
              : options.config?.trimStart().startsWith("{")
                ? options.config
                : undefined;
          let config: unknown;
          try {
            if (configFlag >= 0 && rawConfig === undefined) throw new Error("missing JSON");
            config = rawConfig === undefined ? undefined : JSON.parse(rawConfig);
            if (
              config !== undefined &&
              (config === null || Array.isArray(config) || typeof config !== "object")
            ) {
              throw new Error("config must be a JSON object");
            }
          } catch {
            throw Object.assign(new Error("--extension-config must be a JSON object"), {
              code: "CLI_USAGE_INVALID",
            });
          }
          return await post(client, `/extensions/${encodeURIComponent(operand)}/install`, {
            ...(config === undefined ? {} : { config }),
          });
        }
      case "enable":
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        if (checkOnly) {
          return await get(client, `/extensions/${encodeURIComponent(operand)}/compatibility`);
        }
        return await post(client, `/extensions/${encodeURIComponent(operand)}/enable`, {});
      case "disable":
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        if (checkOnly) {
          return await get(client, "/extensions");
        }
        return await post(client, `/extensions/${encodeURIComponent(operand)}/disable`, {});
      case "uninstall":
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        if (checkOnly) {
          return await get(client, `/extensions/${encodeURIComponent(operand)}/compatibility`);
        }
        return await post(client, `/extensions/${encodeURIComponent(operand)}/uninstall`, {
          ...(confirmationFlag >= 0 && rest[confirmationFlag + 1] !== undefined
            ? { confirmation: rest[confirmationFlag + 1] }
            : {}),
        });
      default:
        return { exitCode: 2, stdout: "", stderr: USAGE };
    }
  } catch (error) {
    return failureResult(error, options);
  }
}

/** `cms contracts versions` — independent contract version discovery. */
export async function contractsCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { options, env } = invocation;
  try {
    const client = clientOrThrow(options, env);
    return await get(client, "/extensions/contracts");
  } catch (error) {
    return failureResult(error, options);
  }
}

/** `cms deprecations list` — machine-readable deprecation records. */
export async function deprecationsCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { options, env } = invocation;
  try {
    const client = clientOrThrow(options, env);
    return await get(client, "/extensions/deprecations");
  } catch (error) {
    return failureResult(error, options);
  }
}
