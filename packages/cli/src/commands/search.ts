// Search CLI commands (PCMS-SEARCH-T015/T016; Search spec §19/§26).
//   cms search query <q>   — public search via the CMS API transport
//   cms search status      — index health + reindex progress (diagnostics)
//   cms search reindex     — full shadow-epoch rebuild (dangerous: heavy op)
// All operations run through the same application layer as REST/MCP; the
// transport is the CMS API (PCMS_API_URL + PCMS_API_TOKEN, spec §58) and
// reindex requires an explicit target like other mutations.

import { apiCall, humanResult, machineResult, resolveApiClient } from "../api-client.js";
import {
  type CliCommandResult,
  failureResult,
  type GlobalOptions,
  requireTargetSafety,
} from "../framework.js";

export interface SearchInvocation {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv) {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

export async function searchCommand(invocation: SearchInvocation): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const [subcommand, operand, ...rest] = args;

  try {
    if (subcommand === "query") {
      if (operand === undefined || operand === "") {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "usage: cms search query <query> [--locale <l>] [--limit <n>] [--json]\n",
        };
      }
      const query = new URLSearchParams({ q: operand });
      for (let index = 0; index < rest.length; index += 1) {
        const flag = rest[index];
        const value = rest[index + 1];
        if ((flag !== "--locale" && flag !== "--limit") || value === undefined || value === "") {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "usage: cms search query <query> [--locale <l>] [--limit <n>] [--json]\n",
          };
        }
        if (value.startsWith("--")) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "usage: cms search query <query> [--locale <l>] [--limit <n>] [--json]\n",
          };
        }
        if (flag === "--limit" && (!/^\d+$/.test(value) || Number(value) < 1)) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "--limit must be a positive integer\n",
          };
        }
        query.set(flag === "--locale" ? "locale" : "limit", value);
        index += 1;
      }
      const response = await apiCall(
        clientOrThrow(options, env),
        "GET",
        `/search?${query.toString()}`,
      );
      if (!response.ok) return response.result;
      return renderQuery(response.body, options);
    }

    if (subcommand === "status") {
      const response = await apiCall(clientOrThrow(options, env), "GET", "/search/status");
      if (!response.ok) return response.result;
      return renderStatus(response.body, options);
    }

    if (subcommand === "reindex") {
      const refusal = requireTargetSafety(options, "cms search reindex");
      if (refusal !== null) return refusal;
      const resume = args.slice(1).includes("--resume");
      const response = await apiCall(
        clientOrThrow(options, env),
        "POST",
        "/search/reindex",
        resume ? { resume: true } : {},
      );
      if (!response.ok) return response.result;
      if (options.json) return machineResult({ ok: true, ...(response.body as object) });
      const body = response.body as Record<string, unknown>;
      return humanResult([
        `reindex run ${String(body.run_id)} started (epoch ${String(body.epoch)});`,
        `  ${String(body.total_documents)} documents in ${String(body.chunks_total)} chunks`,
        `  progress: cms search status`,
      ]);
    }
  } catch (error) {
    return failureResult(error, options);
  }

  return {
    exitCode: 2,
    stdout: "",
    stderr: [
      "usage: cms search query <query> [--locale <l>] [--limit <n>] [--json]",
      "       cms search status [--json]",
      "       cms search reindex [--resume] --environment <env> --yes [--json]",
      "",
    ].join("\n"),
  };
}

interface QueryBody {
  readonly total: number;
  readonly items: readonly {
    readonly title: string;
    readonly path: string | null;
    readonly score: number;
    readonly entity_id: string;
  }[];
}

function renderQuery(body: unknown, options: GlobalOptions): CliCommandResult {
  const query = body as QueryBody;
  if (options.json) return machineResult({ ok: true, ...(query as object) });
  return humanResult([
    `results (${query.total}):`,
    ...query.items.map(
      (item) => `  ${item.title}  ${item.path ?? ""}  score=${item.score.toFixed(4)}`,
    ),
  ]);
}

function renderStatus(body: unknown, options: GlobalOptions): CliCommandResult {
  if (options.json) return machineResult({ ok: true, ...(body as object) });
  const status = body as {
    health: Record<string, unknown>;
    reindex_runs: readonly Record<string, unknown>[];
  };
  const health = status.health;
  return humanResult([
    `search index: ${health.available === true ? "available" : "unavailable"}`,
    `  documents: ${String(health.document_count ?? "?")}`,
    `  index version: ${String(health.index_version ?? "?")} (expected ${String(
      health.expected_index_version ?? "?",
    )})`,
    `  reindex required: ${String(health.reindex_required ?? "?")}`,
    `  active epoch: ${String(health.active_epoch ?? "?")}${
      health.building_epoch !== null && health.building_epoch !== undefined
        ? ` (building ${String(health.building_epoch)})`
        : ""
    }`,
    `  last event: ${String(health.last_event_at ?? "never")}`,
    `  last reindex: ${String(health.last_reindex_at ?? "never")}`,
    ...status.reindex_runs.map(
      (run) =>
        `  run ${String(run.state)} ${String(run.run_id)} documents ${String(
          run.documents_indexed,
        )}/${String(run.total_documents)}`,
    ),
  ]);
}
