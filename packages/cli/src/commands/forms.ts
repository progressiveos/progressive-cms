import { interactionPrivacyCommand } from "./interaction-privacy.js";
// Forms/Quizzes/Interactions CLI commands (PCMS-FORM-T021; Forms spec §36).
//   cms forms list | get <id>            — definition discovery
//   cms quizzes list | get <id>          — quiz definition discovery
//   cms interactions submissions         — submission history (interactions.read)
//   cms interactions runs                — quiz run history (interactions.read)
//   cms interactions leads               — lead list (leads.read; PII)
//   cms interactions lead-status <id> <s>— lead lifecycle (leads.manage)
//   cms interactions export <entity>     — audited CSV/JSON export (§29)
// Transport is the CMS HTTP API (PCMS_API_URL + PCMS_API_TOKEN); the CLI never
// bypasses application/auth semantics (API spec §57).

import { apiCall, humanResult, machineResult, resolveApiClient } from "../api-client.js";
import { type CliCommandResult, failureResult, type GlobalOptions } from "../framework.js";

export interface FormsInvocation {
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

const USAGE = [
  "usage: cms forms list [--status ACTIVE|ARCHIVED] [--json]",
  "       cms forms get <form_id> [--json]",
  "       cms quizzes list [--status ACTIVE|ARCHIVED] [--json]",
  "       cms quizzes get <quiz_id> [--json]",
  "       cms interactions submissions|runs|leads [--limit <n>] [--json]",
  "       cms interactions lead-status <lead_id> <NEW|VIEWED|PROCESSED|ARCHIVED|SPAM> [--json]",
  "       cms interactions privacy-preview|privacy-apply <request.json> [--environment <env> --yes]",
  "       cms interactions privacy-get <case_id> | privacy-ack <case_id> <delivery_id> <decision.json>",
  "       cms interactions export <submissions|quiz_runs|leads> [--format csv|json] [--json]",
  "",
].join("\n");

export async function formsCommand(invocation: FormsInvocation): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const [family, subcommand, operand, ...rest] = args;

  try {
    if (family === "forms" || family === "quizzes") {
      if (subcommand === "list") {
        const status = optionValue(args.slice(2), "--status");
        if (
          (args.includes("--status") && status === undefined) ||
          (status !== undefined && status !== "ACTIVE" && status !== "ARCHIVED")
        ) {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        const response = await apiCall(
          clientOrThrow(options, env),
          "GET",
          `${family === "forms" ? "/forms" : "/quizzes"}${status === undefined ? "" : `?status=${encodeURIComponent(status)}`}`,
        );
        if (!response.ok) return response.result;
        const body = response.body as {
          items: readonly {
            id: string;
            key: string;
            title: string;
            schema_version: number;
            status: string;
          }[];
        };
        if (options.json)
          return machineResult({ ok: true, total: body.items.length, items: body.items });
        return humanResult([
          `${family} definitions (${body.items.length}):`,
          ...body.items.map(
            (item) =>
              `  ${item.key}  ${item.id}  v${item.schema_version}  ${item.status}  ${item.title}`,
          ),
        ]);
      }
      if (subcommand === "get") {
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: `usage: cms ${family} get <id>\n` };
        }
        const response = await apiCall(
          clientOrThrow(options, env),
          "GET",
          family === "forms" ? `/forms/${operand}` : `/quizzes/${operand}`,
        );
        if (!response.ok) return response.result;
        return options.json
          ? machineResult({ ok: true, ...(response.body as object) })
          : humanResult([JSON.stringify(response.body, null, 2)]);
      }
    }

    if (family === "interactions" && subcommand?.startsWith("privacy-")) {
      return interactionPrivacyCommand({ args: args.slice(1), options, env });
    }
    if (family === "interactions") {
      const limit = optionValue(args.slice(2), "--limit");
      if (
        (args.includes("--limit") && limit === undefined) ||
        (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1))
      ) {
        return { exitCode: 2, stdout: "", stderr: USAGE };
      }
      const query = limit === undefined ? "" : `?limit=${encodeURIComponent(limit)}`;
      if (subcommand === "submissions" || subcommand === "runs" || subcommand === "leads") {
        const path =
          subcommand === "submissions"
            ? "/interactions/submissions"
            : subcommand === "runs"
              ? "/interactions/quiz-runs"
              : "/interactions/leads";
        const response = await apiCall(clientOrThrow(options, env), "GET", `${path}${query}`);
        if (!response.ok) return response.result;
        return options.json
          ? machineResult({ ok: true, ...(response.body as object) })
          : humanResult([JSON.stringify(response.body, null, 2)]);
      }
      if (subcommand === "lead-status") {
        const [leadId, status] = [operand, rest[0]];
        if (leadId === undefined || status === undefined) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "usage: cms interactions lead-status <lead_id> <status>\n",
          };
        }
        const response = await apiCall(
          clientOrThrow(options, env),
          "PATCH",
          `/interactions/leads/${leadId}`,
          {
            status,
          },
        );
        if (!response.ok) return response.result;
        return options.json
          ? machineResult({ ok: true, ...(response.body as object) })
          : humanResult([`lead ${leadId} → ${status}`]);
      }
      if (subcommand === "export") {
        const entity = operand;
        if (entity !== "submissions" && entity !== "quiz_runs" && entity !== "leads") {
          return {
            exitCode: 2,
            stdout: "",
            stderr:
              "usage: cms interactions export <submissions|quiz_runs|leads> [--format csv|json]\n",
          };
        }
        const format = optionValue(rest, "--format") ?? "csv";
        const response = await apiCall(
          clientOrThrow(options, env),
          "POST",
          "/interactions/export",
          {
            entity,
            format,
          },
        );
        if (!response.ok) return response.result;
        const content =
          typeof response.body === "string"
            ? response.body
            : JSON.stringify(response.body, null, 2);
        return options.json
          ? machineResult({ ok: true, entity, format, content })
          : humanResult([content]);
      }
    }
  } catch (error) {
    return failureResult(error, options);
  }

  return { exitCode: 2, stdout: "", stderr: USAGE };
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
