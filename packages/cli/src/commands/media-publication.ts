// Media + publication CLI commands (PCMS-API-T023/T024).
//   cms media list|get              — read-only, composed over @pcms/media (DB)
//   cms publication calendar|...    — read/mutate via the CMS API transport
//                                     (one application layer, spec §17/§58)
// Dangerous publication operations require an explicit target
// (--environment + --yes) and refuse otherwise (fail-secure, spec §58).

import { readFileSync } from "node:fs";
import { buildDbConnectionInfo, createDbPool, loadConfig, loadSecrets } from "@pcms/core";
import { createMediaDiscoveryService } from "@pcms/media";
import {
  apiCall,
  collectPages,
  humanResult,
  machineResult,
  partialPageResult,
  resolveApiClient,
} from "../api-client.js";
import {
  type CliCommandResult,
  configLoadOptions,
  failureResult,
  type GlobalOptions,
  requireTargetSafety,
} from "../framework.js";

export interface MediaInvocation {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv) {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

export async function mediaCommand(invocation: MediaInvocation): Promise<CliCommandResult> {
  const { args, options, env, cwd } = invocation;
  const [subcommand, operand, ...rest] = args;

  if (subcommand === "usage" || subcommand === "archive") {
    if (!operand || operand.startsWith("--") || rest.length > 0) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `usage: cms media ${subcommand} <media-id> [--yes] [--json]\n`,
      };
    }
    try {
      const client = clientOrThrow(options, env);
      const path = `/media/${encodeURIComponent(operand)}`;
      const usage = await apiCall(client, "GET", `${path}/usage`);
      if (!usage.ok) return usage.result;
      if (subcommand === "usage") return machineResult(usage.body);
      if (!options.yes) {
        return {
          exitCode: 2,
          stdout:
            JSON.stringify(
              {
                ok: false,
                usage: usage.body,
                error: {
                  code: "TARGET_UNCONFIRMED",
                  message: "Review usage, then pass --yes to archive this asset",
                },
              },
              null,
              2,
            ) + "\n",
          stderr: "Archive not performed; review usage and confirm with --yes.\n",
        };
      }
      if ((usage.body as { inboundCount: number }).inboundCount > 0) {
        return {
          exitCode: 4,
          stdout:
            JSON.stringify(
              {
                ok: false,
                usage: usage.body,
                error: {
                  code: "MEDIA_IN_USE",
                  message: "Cleanup refuses to archive referenced media",
                },
              },
              null,
              2,
            ) + "\n",
          stderr: "MEDIA_IN_USE: cleanup refuses to archive referenced media\n",
        };
      }
      const archived = await apiCall(client, "POST", `${path}/archive`);
      if (!archived.ok) return archived.result;
      return machineResult({
        ok: true,
        media_id: operand,
        usage: usage.body,
        archived: archived.body,
      });
    } catch (error) {
      return failureResult(error, options);
    }
  }

  // Write path goes through the REST transport (one application layer,
  // spec §17/§58): the server validates the focal range and re-crops the
  // core derivatives in the same operation.
  if (subcommand === "update") {
    if (operand === undefined || operand === "") {
      return {
        exitCode: 2,
        stdout: "",
        stderr:
          "usage: cms media update <media-id> [--focal-x <0..1>] [--focal-y <0..1>] [--json]\n",
      };
    }
    const flagValue = (name: string): string | null => {
      const at = rest.indexOf(name);
      return at >= 0 ? (rest[at + 1] ?? null) : null;
    };
    const parseFocal = (raw: string | null, flag: string): number | undefined => {
      if (raw === null) return undefined;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw Object.assign(new Error(`${flag} must be a number in 0..1`), {
          code: "API_REQUEST_INVALID",
        });
      }
      return parsed;
    };
    const focalX = parseFocal(flagValue("--focal-x"), "--focal-x");
    const focalY = parseFocal(flagValue("--focal-y"), "--focal-y");
    if (focalX === undefined && focalY === undefined) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: "media update: nothing to change — pass --focal-x and/or --focal-y\n",
      };
    }
    try {
      const response = await apiCall(clientOrThrow(options, env), "PATCH", `/media/${operand}`, {
        ...(focalX === undefined ? {} : { focal_x: focalX }),
        ...(focalY === undefined ? {} : { focal_y: focalY }),
      });
      if (!response.ok) return response.result;
      const body = response.body as { media_id: string };
      if (options.json) return machineResult({ ok: true, ...body });
      return humanResult([
        `media:    ${body.media_id}`,
        `focal:    x=${focalX === undefined ? "unchanged" : focalX} y=${focalY === undefined ? "unchanged" : focalY}`,
        "og-v1/favicon-v1 derivatives re-cropped to the new focal point.",
      ]);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "MEDIA_UPDATE_FAILED";
      return { exitCode: 4, stdout: "", stderr: `${code}: ${(error as Error).message}\n` };
    }
  }

  if (subcommand !== "list" && subcommand !== "get") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        "usage: cms media list [--limit <n> | --all] [--cursor <cursor>] [--json]",
        "       cms media usage|archive <media-id> [--yes] [--json]",
        "       cms media get <media-id> [--json]",
        "       cms media update <media-id> [--focal-x <0..1>] [--focal-y <0..1>] [--json]",
        "",
      ].join("\n"),
    };
  }
  let pool: ReturnType<typeof createDbPool> | null = null;
  try {
    let limit = args.includes("--all") ? Infinity : 20;
    let cursor: string | null = null;
    if (subcommand === "list") {
      const flags = args.slice(1);
      for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        if (flag === "--all") continue;
        if (flag !== "--limit" && flag !== "--cursor")
          throw Object.assign(new Error(`unknown argument: ${flag}`), {
            code: "CLI_USAGE_INVALID",
          });
        const value = flags[++i];
        if (!value || value.startsWith("--"))
          throw Object.assign(new Error(`${flag} requires a value`), { code: "CLI_USAGE_INVALID" });
        if (flag === "--cursor") cursor = value;
        else {
          if (
            args.includes("--all") ||
            !/^[1-9][0-9]*$/.test(value) ||
            !Number.isSafeInteger(Number(value))
          )
            throw Object.assign(new Error("use a positive integer --limit or --all"), {
              code: "CLI_USAGE_INVALID",
            });
          limit = Number(value);
        }
      }
    }
    const remote = env["PCMS_API_URL"] !== undefined || env["PCMS_API_TOKEN"] !== undefined;
    if (remote) {
      const client = clientOrThrow(options, env);
      if (subcommand === "get") {
        if (!operand || rest.length)
          throw Object.assign(new Error("media get requires one id"), {
            code: "CLI_USAGE_INVALID",
          });
        const response = await apiCall(client, "GET", `/media/${encodeURIComponent(operand)}`);
        return response.ok
          ? machineResult({ ok: true, ...(response.body as object) })
          : response.result;
      }
      const page = await collectPages(
        (size, after) => {
          const query = new URLSearchParams({ limit: String(size) });
          if (after !== null) query.set("cursor", after);
          return apiCall(client, "GET", `/media?${query}`);
        },
        limit,
        cursor,
      );
      if (!page.ok) return partialPageResult(page);
      const { ok: _, ...body } = page;
      if (options.json) return machineResult({ ok: true, ...body });
      return humanResult([
        `media assets (${page.count}; complete=${page.complete}; next_cursor=${page.next_cursor ?? "none"}):`,
        ...page.items.map(
          (asset) => `  ${asset["id"]}  ${asset["kind"]}  ${asset["filenameOriginal"]}`,
        ),
      ]);
    }
    const config = loadConfig(configLoadOptions(options, env, cwd));
    const secrets = loadSecrets(config.secrets, env);
    pool = createDbPool({
      connectionInfo: buildDbConnectionInfo(config.db, secrets),
      max: 2,
      connectionTimeoutMilliseconds: config.db.pool.connectionTimeoutMilliseconds,
    });
    const discovery = createMediaDiscoveryService(pool);
    if (subcommand === "list") {
      const page = await collectPages(
        async (size, after) => {
          const offset = after === null ? 0 : Number(Buffer.from(after, "base64url").toString());
          if (!Number.isSafeInteger(offset) || offset < 0)
            throw Object.assign(new Error("invalid cursor"), { code: "CLI_USAGE_INVALID" });
          const found = await discovery.searchAssets({ limit: size, offset });
          const hasMore = offset + found.items.length < found.total;
          return {
            ok: true,
            status: 200,
            body: {
              ...found,
              has_more: hasMore,
              next_cursor: hasMore
                ? Buffer.from(String(offset + found.items.length)).toString("base64url")
                : null,
            },
          };
        },
        limit,
        cursor,
      );
      if (!page.ok) return partialPageResult(page);
      if (options.json) return machineResult(page);
      return humanResult([
        `media assets (${page.count} of ${page.total}; complete=${page.complete}; next_cursor=${page.next_cursor ?? "none"}):`,
        ...page.items.map(
          (asset) => `  ${asset["id"]}  ${asset["kind"]}  ${asset["filenameOriginal"]}`,
        ),
      ]);
    }
    if (!/^[0-9a-f-]{36}$/i.test(operand ?? "")) {
      return { exitCode: 2, stdout: "", stderr: "usage: cms media get <media-id>\n" };
    }
    const inspected = await discovery.inspectAsset(operand!);
    if (options.json) return machineResult({ ok: true, ...inspected });
    return humanResult([
      `${inspected.asset.id} (${inspected.asset.kind})`,
      `  file: ${inspected.asset.filenameOriginal}`,
      `  size: ${inspected.asset.sizeBytes} bytes`,
      `  versions: ${inspected.versions.length}`,
      `  variants: ${inspected.variants.length}`,
    ]);
  } catch (error) {
    return failureResult(error, options);
  } finally {
    if (pool !== null) void pool.end();
  }
}

export interface PublicationInvocation {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}

const DANGEROUS = new Set(["apply", "publish-now", "cancel"]);

export async function publicationCommand(
  invocation: PublicationInvocation,
): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const [subcommand, operand, operand2] = args;
  try {
    // Target safety BEFORE any network activity (fail-secure, spec §58).
    if (subcommand !== undefined && DANGEROUS.has(subcommand)) {
      const refusal = requireTargetSafety(options, `cms publication ${subcommand}`);
      if (refusal !== null) return refusal;
    }
    if (subcommand === "plan" && args[1] === "schedule") {
      const refusal = requireTargetSafety(options, "cms publication plan schedule");
      if (refusal !== null) return refusal;
    }
    const client = resolveApiClient(options, env);
    if (typeof client === "string") {
      throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
    }

    if (subcommand === "calendar") {
      const response = await apiCall(client, "GET", "/publication/calendar");
      if (!response.ok) return response.result;
      const body = response.body as {
        items: { entity_type: string; entity_id: string; kind: string; instant: string | null }[];
      };
      if (options.json) return machineResult({ ok: true, ...body });
      return humanResult([
        `publication calendar (${body.items.length}):`,
        ...body.items.map(
          (entry) =>
            `  ${entry.instant ?? "?"}  ${entry.kind}  ${entry.entity_type}/${entry.entity_id}`,
        ),
      ]);
    }
    if (subcommand === "plan") {
      const [action, planId, ...flags] = args.slice(1);
      if ((action !== "preview" && action !== "schedule") || planId === undefined) {
        throw Object.assign(
          new Error("use plan preview|schedule <plan-id> --request <json-file>"),
          {
            code: "CLI_USAGE_INVALID",
          },
        );
      }
      const requestIndex = flags.indexOf("--request");
      const requestPath = requestIndex < 0 ? undefined : flags[requestIndex + 1];
      if (
        requestIndex < 0 ||
        requestPath === undefined ||
        requestPath.startsWith("--") ||
        flags.length !== 2
      ) {
        throw Object.assign(new Error("plan preview|schedule requires --request <json-file>"), {
          code: "CLI_USAGE_INVALID",
        });
      }
      let request: unknown;
      try {
        request = JSON.parse(readFileSync(requestPath, "utf8"));
      } catch (error) {
        throw Object.assign(
          new Error(`cannot read plan request JSON: ${(error as Error).message}`),
          {
            code: "API_REQUEST_INVALID",
          },
        );
      }
      if (typeof request !== "object" || request === null || Array.isArray(request)) {
        throw Object.assign(new Error("plan request must be a JSON object"), {
          code: "API_REQUEST_INVALID",
        });
      }
      const response = await apiCall(
        client,
        "POST",
        `/plans/${encodeURIComponent(planId)}/${action}`,
        request,
      );
      if (!response.ok) return response.result;
      if (options.json) return machineResult({ ok: true, ...(response.body as object) });
      return humanResult([`plan ${action}: ${planId}`, JSON.stringify(response.body, null, 2)]);
    }
    if (subcommand === "changesets" || subcommand === undefined) {
      const response = await apiCall(client, "GET", "/changesets");
      if (!response.ok) return response.result;
      const body = response.body as { items: { id: string; title: string; state: string }[] };
      if (options.json) return machineResult({ ok: true, ...body });
      return humanResult([
        `changesets (${body.items.length}):`,
        ...body.items.map((item) => `  ${item.id}  ${item.state}  ${item.title}`),
      ]);
    }
    if (subcommand === "changeset" && operand !== undefined) {
      const response = await apiCall(client, "GET", `/changesets/${operand}`);
      if (!response.ok) return response.result;
      if (options.json) return machineResult({ ok: true, ...(response.body as object) });
      const body = response.body as { changeset: { id: string; state: string; title: string } };
      return humanResult([
        `${body.changeset.id}  ${body.changeset.state}`,
        `  ${body.changeset.title}`,
      ]);
    }
    if (subcommand === "preflight" && operand !== undefined) {
      const response = await apiCall(client, "POST", `/changesets/${operand}/preflight`);
      if (!response.ok) return response.result;
      if (options.json) return machineResult({ ok: true, ...(response.body as object) });
      const body = response.body as { ok: boolean; issues: { code: string; message: string }[] };
      return humanResult([
        `preflight: ${body.ok ? "READY" : "NOT READY"}`,
        ...body.issues.map((issue) => `  - [${issue.code}] ${issue.message}`),
      ]);
    }
    if (subcommand === "apply" && operand !== undefined) {
      const response = await apiCall(client, "POST", `/changesets/${operand}/apply`, {});
      if (!response.ok) return response.result;
      if (options.json) return machineResult({ ok: true, applied: true, changeset_id: operand });
      return humanResult([`result: APPLIED`, `changeset: ${operand}`]);
    }
    if (subcommand === "publish-now" && operand !== undefined && operand2 !== undefined) {
      const response = await apiCall(
        client,
        "POST",
        `/plans/${operand}/items/${operand2}/publish-now`,
        {},
      );
      if (!response.ok) return response.result;
      if (options.json) return machineResult({ ok: true, published: true });
      return humanResult([`result: PUBLISHED`, `plan item: ${operand2}`]);
    }
    if (subcommand === "cancel" && operand !== undefined) {
      const response = await apiCall(client, "POST", `/changesets/${operand}/cancel`, {});
      if (!response.ok) return response.result;
      if (options.json) return machineResult({ ok: true, cancelled: operand });
      return humanResult([`result: CANCELLED`, `changeset: ${operand}`]);
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        "usage: cms publication calendar [--json]",
        "       cms publication changesets [--json]",
        "       cms publication changeset <id> [--json]",
        "       cms publication preflight <changeset-id> [--json]",
        "       cms publication plan preview|schedule <plan-id> --request <json-file>",
        "       cms publication apply <changeset-id> --environment <env> --yes",
        "       cms publication publish-now <plan-id> <item-id> --environment <env> --yes",
        "       cms publication cancel <changeset-id> --environment <env> --yes",
        "",
        "Mutating commands run against the CMS API (PCMS_API_URL + PCMS_API_TOKEN)",
        "and require an explicit --environment and --yes (fail-secure, spec §58).",
        "",
      ].join("\n"),
    };
  } catch (error) {
    return failureResult(error, options);
  }
}
