// Content CLI (PCMS-API-T023; API spec §40).
//   cms content schema list|show             — effective content types
//   cms content schema validate|apply <file> — additive schema changes via API
//   cms content validate <file>              — publish-level payload validation
//   cms content import <file>                — Publication Bundle apply
//   cms content create|draft|patch|seal|preview — the content golden path
//
// list/show/validate run against the CMS API when PCMS_API_URL/PCMS_API_TOKEN
// are set (schema overrides included) and fall back to the local config file
// otherwise; apply/draft/patch/seal/preview are API commands — one application
// layer, no second implementation.
import { readFileSync } from "node:fs";
import {
  createBlockRegistry,
  registerFirstPartyBlocksV1,
  validateBlockDocument,
} from "@pcms/blocks";
import { createContentTypeRegistry, validateContentPayload } from "@pcms/content";
import { loadConfig } from "@pcms/core";
import { apiCall, humanResult, machineResult, resolveApiClient } from "../api-client.js";
import {
  type CliCommandResult,
  failureResult,
  type GlobalOptions,
  requireTargetSafety,
} from "../framework.js";

export interface ContentInvocation {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

function loadRegistries(env: NodeJS.ProcessEnv, cwd: string, options: GlobalOptions) {
  const config = loadConfig(
    options.config === undefined ? { env, cwd } : { file: options.config, env, cwd },
  );
  const typesFile = config.content?.typesFile;
  if (typesFile === undefined) {
    throw Object.assign(
      new Error("no content.typesFile configured — nothing to list or validate against"),
      { code: "CONTENT_TYPES_MISSING" },
    );
  }
  const contentTypes = createContentTypeRegistry();
  const parsed = JSON.parse(readFileSync(typesFile, "utf8")) as unknown[];
  for (const definition of parsed) {
    contentTypes.registerContentType(definition as never);
  }
  const blocks = createBlockRegistry();
  registerFirstPartyBlocksV1(blocks);
  return { config, contentTypes, blocks };
}

export async function contentCommand(invocation: ContentInvocation): Promise<CliCommandResult> {
  const { args, options, env, cwd } = invocation;
  const [subcommand, operand, ...rest] = args;
  try {
    if (subcommand === "revision" && (operand === "show" || operand === "current")) {
      const id = rest[0];
      if (id === undefined || id.startsWith("--") || rest.length !== 1) {
        return usage(
          `cms content revision ${operand} <${operand === "show" ? "revisionId" : "entryId"}> [--json]`,
        );
      }
      const client = requireApi(options, env);
      if (typeof client === "string") return apiUnconfigured(client);
      let revisionId = id;
      let publication: unknown;
      if (operand === "current") {
        const result = await apiCall(
          client,
          "GET",
          `/publications/entry/${encodeURIComponent(id)}`,
        );
        if (!result.ok) return result.result;
        const pointer = result.body as { state?: string; current_revision_id?: string | null };
        if (pointer.state !== "PUBLISHED" || typeof pointer.current_revision_id !== "string") {
          return failureResult(
            Object.assign(new Error("entry is not published"), { code: "PUBLICATION_NOT_FOUND" }),
            options,
          );
        }
        revisionId = pointer.current_revision_id;
        publication = result.body;
      }
      const response = await apiCall(client, "GET", `/revisions/${encodeURIComponent(revisionId)}`);
      if (!response.ok) return response.result;
      if (operand === "current") {
        const revision = response.body as { entity_id?: string; entity_type?: string };
        if (revision.entity_id !== id || revision.entity_type !== "entry") {
          return failureResult(
            Object.assign(new Error("publication points to a different entity"), {
              code: "PUBLICATION_REVISION_MISMATCH",
            }),
            options,
          );
        }
      }
      return machineResult(
        operand === "current" ? { publication, revision: response.body } : response.body,
      );
    }
    if (subcommand === "schema" && (operand === "list" || operand === undefined)) {
      const render = (
        items: readonly { key: string; version: number; title: string; bodyPolicy: string }[],
      ) => {
        if (options.json) return machineResult({ ok: true, items });
        return humanResult([
          `content types (${items.length}):`,
          ...items.map(
            (item) => `  ${item.key} v${item.version} — ${item.title} [${item.bodyPolicy}]`,
          ),
        ]);
      };
      // API-first: the API serves the EFFECTIVE set (typesFile + persisted
      // schema overrides); the local file knows nothing about applies.
      const client = resolveApiClient(options, env);
      if (typeof client !== "string") {
        const response = await apiCall(client, "GET", "/discovery/content/types");
        if (!response.ok) return response.result;
        return render(
          (
            response.body as {
              items: { key: string; version: number; title: string; bodyPolicy: string }[];
            }
          ).items,
        );
      }
      const { contentTypes } = loadRegistries(env, cwd, options);
      const items = [...contentTypes.listContentTypes()]
        .sort((a, b) => (a.key === b.key ? a.version - b.version : a.key < b.key ? -1 : 1))
        .map((schema) => ({
          key: schema.key,
          version: schema.version,
          title: schema.title,
          bodyPolicy: schema.bodyPolicy,
        }));
      if (options.json) return machineResult({ ok: true, items });
      return humanResult([
        `content types (${items.length}):`,
        ...items.map(
          (item) => `  ${item.key} v${item.version} — ${item.title} [${item.bodyPolicy}]`,
        ),
      ]);
    }
    if (subcommand === "schema" && operand === "show") {
      const key = rest[0];
      if (key === undefined) {
        return { exitCode: 2, stdout: "", stderr: "usage: cms content schema show <key>\n" };
      }
      const render = (descriptor: {
        key: string;
        version: number;
        title: string;
        bodyPolicy: string;
        fields: Record<string, unknown>;
        fieldSchema?: unknown;
      }) => {
        if (options.json) return machineResult(descriptor);
        return humanResult([
          `${descriptor.key} v${descriptor.version} (${descriptor.bodyPolicy})`,
          ...Object.keys(descriptor.fields).map((field) => `  field: ${field}`),
        ]);
      };
      // API-first (see list): overrides included.
      const client = resolveApiClient(options, env);
      if (typeof client !== "string") {
        const response = await apiCall(client, "GET", `/discovery/content/types/${key}`);
        if (!response.ok) return response.result;
        const descriptor = response.body as {
          key: string;
          version: number;
          title: string;
          bodyPolicy: string;
          fields: Record<string, unknown>;
        };
        return render(descriptor);
      }
      const { contentTypes } = loadRegistries(env, cwd, options);
      const schema = contentTypes.getLatestContentType(key);
      if (schema === null) {
        throw Object.assign(new Error(`content type "${key}" is not registered`), {
          code: "CONTENT_TYPE_UNKNOWN",
        });
      }
      const descriptor = {
        key: schema.key,
        version: schema.version,
        title: schema.title,
        bodyPolicy: schema.bodyPolicy,
        fields: schema.fieldSchema.fields,
      };
      if (options.json) return machineResult(descriptor);
      return humanResult([
        `${descriptor.key} v${descriptor.version} (${descriptor.bodyPolicy})`,
        ...Object.keys(descriptor.fields).map((field) => `  field: ${field}`),
      ]);
    }
    if (subcommand === "validate" && operand !== undefined) {
      const { contentTypes, blocks } = loadRegistries(env, cwd, options);
      const document = JSON.parse(readFileSync(operand, "utf8")) as {
        content_type?: string;
        payload?: { fields?: unknown; blocks?: unknown };
      };
      if (typeof document.content_type !== "string" || typeof document.payload !== "object") {
        throw Object.assign(
          new Error(
            'payload file must hold { "content_type": string, "payload": { fields, blocks } }',
          ),
          { code: "PAYLOAD_INVALID" },
        );
      }
      const loaded = contentTypes.getLatestContentType(document.content_type);
      if (loaded === null) {
        throw Object.assign(
          new Error(`content type "${document.content_type}" is not registered`),
          { code: "CONTENT_TYPE_UNKNOWN" },
        );
      }
      const issues: unknown[] = validateContentPayload(
        loaded,
        document.payload.fields ?? {},
        "publish",
      ).errors.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message }));
      if (loaded.bodyPolicy === "block_document") {
        const blockResult = validateBlockDocument(document.payload.blocks ?? null, blocks);
        if (!blockResult.ok && "issues" in blockResult) issues.push(...blockResult.issues);
      }
      const ok = issues.length === 0;
      if (options.json) return machineResult({ ok, issues }, ok ? 0 : 3);
      if (!ok) {
        return {
          exitCode: 3,
          stdout: "",
          stderr: `${issues.length} validation issue(s):\n${issues
            .map((issue) => `  - ${JSON.stringify(issue)}`)
            .join("\n")}\n`,
        };
      }
      return humanResult([`result: VALID`, `${operand} satisfies "${document.content_type}"`]);
    }
    if (subcommand === "import" && operand !== undefined) {
      const client = resolveApiClient(options, env);
      if (typeof client === "string") {
        throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
      }
      const bundle = JSON.parse(readFileSync(operand, "utf8")) as Record<string, unknown>;
      const response = await apiCall(client, "POST", "/bundles", {
        ...bundle,
        mode: "apply",
      });
      if (!response.ok) return response.result;
      if (options.json) return machineResult(response.body);
      const body = response.body as { changeset_id?: string; published?: boolean };
      return humanResult([
        "result: IMPORTED",
        `changeset: ${body.changeset_id ?? "?"}`,
        `published: ${body.published === true ? "yes" : "no"}`,
      ]);
    }
    if (subcommand === "schema" && (operand === "validate" || operand === "apply")) {
      const file = flagValue(rest, "--file");
      if (file === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `usage: cms content schema ${operand} --file <definitions.json> [--json]\n`,
        };
      }
      const client = resolveApiClient(options, env);
      if (typeof client === "string") {
        throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
      }
      if (operand === "apply") {
        const unconfirmed = requireTargetSafety(options, "content schema apply");
        if (unconfirmed !== null) return unconfirmed;
      }
      const definitions = parseDefinitionsFile(file);
      const response = await apiCall(client, "POST", `/content/schema/${operand}`, { definitions });
      if (!response.ok) return response.result;
      const body = response.body as {
        ok: boolean;
        issues: { code: string; message: string }[];
        diff: {
          added_types: string[];
          added_fields: Record<string, string[]>;
          violations: { code: string; message: string }[];
        };
        affected_entries?: Record<string, number>;
        restart_required: boolean;
      };
      const ok = body.ok === true;
      if (options.json) return machineResult(body, ok ? 0 : 3);
      const lines = [
        `result: ${ok ? (operand === "apply" ? "APPLIED" : "VALID") : "REJECTED"}`,
        ...body.diff.added_types.map((key) => `  new type: ${key}`),
        ...Object.entries(body.diff.added_fields).map(
          ([key, fields]) => `  new fields: ${key}: ${fields.join(", ")}`,
        ),
        ...body.diff.violations.map((violation) => `  violation: ${violation.message}`),
        ...body.issues.map((issue) => `  issue: [${issue.code}] ${issue.message}`),
        ...(Object.keys(body.affected_entries ?? {}).length > 0
          ? [
              `  affected entries: ${Object.entries(body.affected_entries ?? {})
                .map(([key, count]) => `${key}=${count}`)
                .join(", ")}`,
            ]
          : []),
        ...(body.restart_required === true
          ? ["  restart required: yes (schema registries are built at boot)"]
          : []),
      ];
      return { exitCode: ok ? 0 : 3, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    if (subcommand === "create") {
      const client = requireApi(options, env);
      if (typeof client === "string") return apiUnconfigured(client);
      const parsed = contentFlags(args, "cms content create --file payload.json [--json]");
      if ("usage" in parsed) return parsed.usage;
      const flags = parsed.flags;
      if (flags.file === undefined) {
        return usage("cms content create --file payload.json [--json]");
      }
      const document = readPayloadFile(flags.file);
      const response = await apiCall(client, "POST", "/entries", document);
      if (!response.ok) return response.result;
      if (options.json) return machineResult(response.body);
      const body = response.body as {
        entry_id: string;
        revision_id: string;
        base_revision_id: string | null;
      };
      return humanResult([
        "result: CREATED",
        `entry: ${body.entry_id}`,
        `revision: ${body.revision_id}${body.base_revision_id === null ? "" : ` (base ${body.base_revision_id})`}`,
      ]);
    }
    if (subcommand === "draft") {
      const client = requireApi(options, env);
      if (typeof client === "string") return apiUnconfigured(client);
      const parsed = contentFlags(
        args,
        "cms content draft --entry <entryId> [--from-revision <revisionId>] [--json]",
      );
      if ("usage" in parsed) return parsed.usage;
      const flags = parsed.flags;
      if (flags.entry === undefined) {
        return usage("cms content draft --entry <entryId> [--from-revision <revisionId>] [--json]");
      }
      const response = await apiCall(client, "POST", `/entries/${flags.entry}/draft`, {
        ...(flags.fromRevision === undefined ? {} : { from_revision_id: flags.fromRevision }),
      });
      if (!response.ok) return response.result;
      if (options.json) return machineResult(response.body);
      const body = response.body as {
        revision_id: string;
        created: boolean;
        base_revision_id: string | null;
      };
      return humanResult([
        `result: ${body.created ? "OPENED" : "EXISTING"}`,
        `revision: ${body.revision_id}${body.base_revision_id === null ? "" : ` (base ${body.base_revision_id})`}`,
      ]);
    }
    if (subcommand === "patch") {
      const client = requireApi(options, env);
      if (typeof client === "string") return apiUnconfigured(client);
      const parsed = contentFlags(
        args,
        "cms content patch --revision <revisionId> --file payload.json --expected-generation <N> [--json]",
      );
      if ("usage" in parsed) return parsed.usage;
      const flags = parsed.flags;
      if (
        flags.revision === undefined ||
        flags.file === undefined ||
        flags.generation === undefined
      ) {
        return usage(
          "cms content patch --revision <revisionId> --file payload.json --expected-generation <N> [--json]",
        );
      }
      const document = readPayloadFile(flags.file);
      const response = await apiCall(client, "PATCH", `/revisions/${flags.revision}`, {
        payload: document.payload ?? document,
        expected_edit_generation: Number(flags.generation),
      });
      if (!response.ok) return response.result;
      if (options.json) return machineResult(response.body);
      const body = response.body as { revision_id: string; edit_generation: number };
      return humanResult([
        "result: PATCHED",
        `revision: ${body.revision_id}`,
        `edit generation: ${body.edit_generation}`,
      ]);
    }
    if (subcommand === "seal") {
      const client = requireApi(options, env);
      if (typeof client === "string") return apiUnconfigured(client);
      const unconfirmed = requireTargetSafety(options, "content seal");
      if (unconfirmed !== null) return unconfirmed;
      const parsed = contentFlags(
        args,
        "cms content seal --revision <revisionId> [--expected-generation <N>] --environment <env> --yes [--json]",
      );
      if ("usage" in parsed) return parsed.usage;
      const flags = parsed.flags;
      if (flags.revision === undefined) {
        return usage(
          "cms content seal --revision <revisionId> [--expected-generation <N>] [--json]",
        );
      }
      const response = await apiCall(client, "POST", `/revisions/${flags.revision}/seal`, {
        ...(flags.generation === undefined
          ? {}
          : { expected_edit_generation: Number(flags.generation) }),
      });
      if (!response.ok) return response.result;
      if (options.json) return machineResult(response.body);
      const body = response.body as { revision_id: string; payload_hash: string };
      return humanResult([
        "result: SEALED",
        `revision: ${body.revision_id}`,
        `payload hash: ${body.payload_hash}`,
      ]);
    }
    if (subcommand === "revision" && operand === "delete") {
      const client = requireApi(options, env);
      if (typeof client === "string") return apiUnconfigured(client);
      const unconfirmed = requireTargetSafety(options, "content revision delete");
      if (unconfirmed !== null) return unconfirmed;
      const revisionId = rest[0];
      if (revisionId === undefined || revisionId.startsWith("--")) {
        return usage("cms content revision delete <revisionId> --environment <env> --yes [--json]");
      }
      const response = await apiCall(
        client,
        "DELETE",
        `/revisions/${encodeURIComponent(revisionId)}`,
      );
      if (!response.ok) return response.result;
      if (options.json) return machineResult(response.body);
      const body = response.body as { revision_id: string };
      return humanResult(["result: DELETED", `revision: ${body.revision_id}`]);
    }
    if (subcommand === "preview") {
      const client = requireApi(options, env);
      if (typeof client === "string") return apiUnconfigured(client);
      const parsed = contentFlags(
        args,
        "cms content preview --entity-id <entryId> --revision <revisionId> [--allow-draft] [--json]",
      );
      if ("usage" in parsed) return parsed.usage;
      const flags = parsed.flags;
      if (flags.entityId === undefined || flags.revision === undefined) {
        return usage(
          "cms content preview --entity-id <entryId> --revision <revisionId> [--allow-draft] [--json]",
        );
      }
      const response = await apiCall(client, "POST", "/previews", {
        scope: {
          kind: "revision",
          entity_type: flags.entityType ?? "entry",
          entity_id: flags.entityId,
          revision_id: flags.revision,
          ...(flags.allowDraft === true ? { allow_draft: true } : {}),
        },
      });
      if (!response.ok) return response.result;
      if (options.json) return machineResult(response.body);
      const body = response.body as { preview_path: string };
      return humanResult([`preview: ${body.preview_path}`]);
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        "usage: cms content schema list [--json]",
        "       cms content schema show <key> [--json]",
        "       cms content schema validate --file <definitions.json> [--json]",
        "       cms content schema apply --file <definitions.json> --environment <env> --yes [--json]",
        "       cms content validate <file> [--json]",
        "       cms content import <bundle-file> [--json]   (uses PCMS_API_URL/PCMS_API_TOKEN)",
        "       cms content create --file payload.json [--json]",
        "       cms content draft --entry <entryId> [--from-revision <revisionId>] [--json]",
        "       cms content patch --revision <revisionId> --file payload.json --expected-generation <N> [--json]",
        "       cms content seal --revision <revisionId> [--expected-generation <N>] --environment <env> --yes [--json]",
        "       cms content preview --entity-id <entryId> --revision <revisionId> [--allow-draft] [--json]",
        "       cms content revision show <revisionId> [--json]",
        "       cms content revision current <entryId> [--json]",
        "       cms content revision delete <revisionId> --environment <env> --yes [--json]",
        "",
      ].join("\n"),
    };
  } catch (error) {
    return failureResult(error, options);
  }
}

function apiUnconfigured(message: string): CliCommandResult {
  return { exitCode: 2, stdout: "", stderr: `error: ${message}\n` };
}

function usage(line: string): CliCommandResult {
  return { exitCode: 2, stdout: "", stderr: `usage: ${line}\n` };
}

/** The golden-path branches take no positional operand: everything after the
 * subcommand is named flags. The old `const [sub, operand, ...rest]`
 * destructure ate the first flag as "operand", so `draft --entry <id>` died
 * with INTERNAL_ERROR on the id (2026-10-02 site report). Parse errors are
 * usage/input errors, never INTERNAL_ERROR. */
function contentFlags(
  args: readonly string[],
  usageLine: string,
): { flags: ContentFlags } | { usage: CliCommandResult } {
  try {
    return { flags: parseContentFlags(args.slice(1)) };
  } catch (error) {
    return {
      usage: {
        exitCode: 2,
        stdout: "",
        stderr: `error: ${(error as Error).message}\nusage: ${usageLine}\n`,
      },
    };
  }
}

function requireApi(options: GlobalOptions, env: NodeJS.ProcessEnv) {
  return resolveApiClient(options, env);
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

interface ContentFlags {
  file?: string;
  entry?: string;
  fromRevision?: string;
  revision?: string;
  generation?: string;
  entityId?: string;
  entityType?: string;
  allowDraft?: boolean;
}

function parseContentFlags(args: readonly string[]): ContentFlags {
  const flags: {
    file?: string;
    entry?: string;
    fromRevision?: string;
    revision?: string;
    generation?: string;
    entityId?: string;
    entityType?: string;
    allowDraft?: boolean;
  } = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) break;
    const value = (): string => {
      const v = args[i + 1];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return v;
    };
    if (arg === "--file") flags.file = value();
    else if (arg === "--entry") flags.entry = value();
    else if (arg === "--from-revision") flags.fromRevision = value();
    else if (arg === "--revision") flags.revision = value();
    else if (arg === "--expected-generation") flags.generation = value();
    else if (arg === "--entity-id") flags.entityId = value();
    else if (arg === "--entity-type") flags.entityType = value();
    else if (arg === "--allow-draft") flags.allowDraft = true;
    else throw new Error(`unexpected argument "${arg}"`);
  }
  return flags;
}

/** Definitions file: bare array (typesFile shape) or {contentTypes:[…]} —
 * the API accepts both; the CLI no longer bounce-picks a format. */
function parseDefinitionsFile(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function readPayloadFile(file: string): {
  content_type?: string;
  payload?: { fields?: unknown; blocks?: unknown };
} {
  return JSON.parse(readFileSync(file, "utf8")) as {
    content_type?: string;
    payload?: { fields?: unknown; blocks?: unknown };
  };
}
