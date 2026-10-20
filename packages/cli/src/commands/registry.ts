// Registry CLI family (owner 2026-10-06, after the p-cms.ru site agent got
// stuck: the canonical update path is POST /registry/apply-update with the
// service token, but the CLI had no wrapper — the agent could not see the
// registry at all and went browser-diving). REST remains canonical; these
// commands are thin clients over the SAME instance endpoints the Admin uses.
//
//   cms registry status                     binding + current policy state
//   cms registry releases [--json]          releases the registry serves
//   cms registry apply --version <v> [--environment <e>] [--yes]
//                                           apply a release through the
//                                           standard update orchestrator
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

const USAGE = `usage: cms registry <subcommand> [--json]
  status                              instance binding + registry policy state
  releases [--json]                   releases the registry serves (latest first)
  apply --version <v> [--environment <env>] [--yes]
                                      apply a release through the standard
                                      orchestrator (backup → install → migrate
                                      → restart → doctor). If the connection
                                      drops mid-apply the server-side run
                                      CONTINUES — re-check with 'cms agent
                                      bootstrap --json' after a minute.
`;

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function registryCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const subcommand = args[0];
  try {
    if (subcommand !== "status" && subcommand !== "releases" && subcommand !== "apply") {
      return { exitCode: 2, stdout: "", stderr: USAGE };
    }
    const client = clientOrThrow(options, env);

    if (subcommand === "status") {
      const instance = await apiCall(client, "GET", "/registry/instance");
      if (!instance.ok) return instance.result;
      const binding = await apiCall(
        client,
        "GET",
        `/registry/instance/status?instance_code=${encodeURIComponent(
          String((instance.body as { instance_code?: unknown }).instance_code ?? ""),
        )}`,
      );
      const catalog = await apiCall(client, "GET", "/registry/index");
      return machineResult({
        instance: instance.body,
        binding: binding.ok ? binding.body : { status: "unknown" },
        registry_configured: catalog.ok
          ? (catalog.body as { configured?: boolean }).configured
          : null,
      });
    }

    if (subcommand === "releases") {
      const response = await apiCall(client, "GET", "/registry/index");
      if (!response.ok) return response.result;
      return machineResult(response.body);
    }

    // apply: operator safety contract (mirrors maintenance/publication
    // mutations — an accidental update must not succeed silently).
    const safety = requireTargetSafety(options, "registry apply");
    if (safety !== null) return safety;
    const version = optionValue(args, "--version");
    if (version === undefined || version.trim() === "") {
      return { exitCode: 3, stdout: "", stderr: "--version <X.Y.Z> is required\n" };
    }
    const response = await apiCall(client, "POST", "/registry/apply-update", {
      version: version.trim(),
    });
    if (!response.ok) return response.result;
    return machineResult({
      ...(response.body as Record<string, unknown>),
      note: "if the connection dropped mid-apply, the server-side run continues — re-check with 'cms agent bootstrap --json' after a minute",
    });
  } catch (error) {
    return failureResult(error, options);
  }
}
