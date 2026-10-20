// Agent CLI commands (M16; task brief §20/§74).
//   cms agent bootstrap — the machine discovery entry point (REST mirror of
//   GET /agent/bootstrap): site, environment, actor/scopes, contracts,
//   capabilities, installed skills, preview/domain readiness. Secret-free.

import { apiCall, humanResult, machineResult, resolveApiClient } from "../api-client.js";
import type { CliCommandResult, GlobalOptions } from "../framework.js";

export interface AgentInvocation {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}

interface BootstrapBody {
  site?: { key: string; title: string } | null;
  environment?: { classification?: string; actor_binding?: string | null };
  actor?: { type?: string; permissions?: readonly string[] };
  server?: { cms_version?: string | null; release_id?: string | null };
  skills?: {
    installed?: readonly {
      id: string;
      version: string;
      compatibility?: { result?: string };
    }[];
    problems?: readonly unknown[];
  };
  publication?: { preview?: { available?: boolean; reason_code?: string } };
  routing?: { primary_domain?: string | null };
}

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv) {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

export async function agentCommand(invocation: AgentInvocation): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const [subcommand] = args;

  if (subcommand !== "bootstrap") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "usage: cms agent bootstrap [--json]\n",
    };
  }

  try {
    const response = await apiCall(clientOrThrow(options, env), "GET", "/agent/bootstrap");
    if (!response.ok) return response.result;
    const body = response.body as BootstrapBody;
    if (options.json === true) return machineResult(body);
    const skills = (body.skills?.installed ?? [])
      .map((skill) => `${skill.id}@${skill.version} (${skill.compatibility?.result ?? "unknown"})`)
      .join(", ");
    return humanResult([
      `site:            ${body.site?.key ?? "(unknown)"} — ${body.site?.title ?? ""}`,
      `environment:     ${body.environment?.classification ?? "(unknown)"} (binding: ${body.environment?.actor_binding ?? "unbound"})`,
      `actor:           ${body.actor?.type ?? "(unknown)"} with ${(body.actor?.permissions ?? []).length} effective scopes`,
      `cms:             ${body.server?.cms_version ?? "(unknown)"}${body.server?.release_id ? ` (${body.server.release_id})` : ""}`,
      `preview:         ${body.publication?.preview?.available === true ? "available" : `unavailable (${body.publication?.preview?.reason_code ?? "?"})`}`,
      `primary domain:  ${body.routing?.primary_domain ?? "(none)"}`,
      `skills:          ${skills === "" ? "(none installed)" : skills}`,
      "Run with --json for the full machine-readable bootstrap document.",
    ]);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "AGENT_BOOTSTRAP_FAILED";
    return {
      exitCode: 4,
      stdout: "",
      stderr: `${code}: ${(error as Error).message}\n`,
    };
  }
}
