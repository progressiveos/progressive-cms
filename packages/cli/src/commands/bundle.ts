// Publication bundle CLI (PCMS-PCPUB E7; ADR-0014, API spec §81.3).
//   cms bundle validate <workspace|.pcpub> — offline structure/PCMD/refs
//       (+ semantic against the deployment typesFile when configured)
//   cms bundle pack <workspace> --out <file.pcpub>  — deterministic pack
//   cms bundle inspect <file.pcpub>        — offline manifest summary
//   cms bundle submit <file.pcpub> [--wait] — raw upload to /bundles/pcpub
//   cms bundle status <ingest-id>          — ingest stage/outcome
//
// Packing/inspecting never touch the network; submit/status ride the same
// public REST contract as Admin (one application layer, no local DB).
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBlockRegistry,
  registerFirstPartyBlocksV1,
  validateBlockDocument,
} from "@pcms/blocks";
import {
  createContentTypeRegistry,
  markdownToRichText,
  validateContentPayload,
} from "@pcms/content";
import { ConfigError, loadConfig } from "@pcms/core";
import { registerInteractionBlocks } from "@pcms/forms";
import {
  inspectPcpub,
  type PcpubDiagnostic,
  type PcpubTargetContracts,
  packWorkspace,
  type RichTextPropsResolver,
  validatePcpub,
  verifyPcpub,
} from "@pcms/publication";
import { humanResult, machineResult, resolveApiClient } from "../api-client.js";
import {
  type CliCommandResult,
  failureResult,
  type GlobalOptions,
  jsonPayload,
} from "../framework.js";

export interface BundleInvocation {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/** True when the raw argv carried --wait (submit polls to a terminal outcome). */
function wantsWait(invocation: BundleInvocation): boolean {
  return invocation.args.includes("--wait");
}

const OFFLINE_NOTE =
  "Offline validation only; external entry existence has not been checked on the server.";

const PCPUB_MIME = "application/vnd.progressive-cms.pcpub+zip";

/** Per-type rich-text prop names for the PCMD markdown bridge. */
function richTextPropsFor(blocks: ReturnType<typeof createBlockRegistry>): RichTextPropsResolver {
  return (typeId, schemaVersion) => {
    const registered = blocks.getBlockType(typeId, schemaVersion);
    return registered === null ? undefined : new Set(registered.richTextProps);
  };
}

/** Local L2 adapter: real registries → structural target contracts. */
function buildContracts(
  contentTypes: ReturnType<typeof createContentTypeRegistry>,
  blocks: ReturnType<typeof createBlockRegistry>,
): PcpubTargetContracts {
  return {
    getContentType(key) {
      const loaded = contentTypes.getLatestContentType(key);
      if (loaded === null) return null;
      return {
        validateFields(fields) {
          return validateContentPayload(loaded, fields, "publish").errors;
        },
      };
    },
    blockVersions() {
      return blocks.listBlockTypeVersions();
    },
    validateEntryBlocks(documentPath, canonical) {
      const issues: PcpubDiagnostic[] = [];
      const migrated: {
        id: string;
        type: string;
        schema_version: number;
        props: Record<string, unknown>;
      }[] = [];
      for (const node of canonical.blocks) {
        const registered = blocks.getBlockType(node.type, node.schema_version);
        if (registered === null) {
          const known = blocks
            .listBlockTypeVersions()
            .find((entry) => entry.typeId === node.type)?.versions;
          issues.push({
            code: "PCPUB_COMPAT_UNSUPPORTED_BLOCK_VERSION",
            path: documentPath,
            message:
              known === undefined
                ? `block "${node.type}" is unknown on the target`
                : `block "${node.type}@${node.schema_version}" unsupported (target knows ${known.join(", ")})`,
          });
          continue;
        }
        let props = node.props;
        let version = node.schema_version;
        if (registered.schemaVersion !== node.schema_version) {
          try {
            const result = blocks.migrateBlockProps(
              node.type,
              node.schema_version,
              node.props,
              registered.schemaVersion,
            );
            props = result.props;
            version = result.toVersion;
          } catch {
            issues.push({
              code: "PCPUB_COMPAT_UNSUPPORTED_BLOCK_VERSION",
              path: documentPath,
              message: `block "${node.type}@${node.schema_version}" has no migration path to the target version`,
            });
            continue;
          }
        }
        migrated.push({ id: node.id, type: node.type, schema_version: version, props });
      }
      const result = validateBlockDocument({ schema_version: 1, blocks: migrated }, blocks);
      if (!result.ok) {
        for (const issue of result.issues) {
          issues.push({
            code: "PCPUB_DOCUMENT_INVALID",
            path: `${documentPath}/blocks${issue.path}`,
            message: issue.message,
          });
        }
      }
      return issues;
    },
  };
}

function loadRegistries(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: GlobalOptions,
): {
  contentTypes: ReturnType<typeof createContentTypeRegistry>;
  blocks: ReturnType<typeof createBlockRegistry>;
} | null {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(
      options.config === undefined ? { env, cwd } : { file: options.config, env, cwd },
    );
  } catch (error) {
    if (
      error instanceof ConfigError &&
      error.code === "CONFIG_NOT_FOUND" &&
      options.config === undefined &&
      env["PCMS_CONFIG_FILE"] === undefined
    ) {
      return null;
    }
    throw error;
  }
  const typesFile = config.content?.typesFile;
  if (typesFile === undefined) return null;
  const contentTypes = createContentTypeRegistry();
  const parsed = JSON.parse(readFileSync(typesFile, "utf8")) as unknown[];
  for (const definition of parsed) contentTypes.registerContentType(definition as never);
  const blocks = createBlockRegistry();
  registerFirstPartyBlocksV1(blocks);
  // The server ingest validates form/quiz blocks against the same registry —
  // without them offline validate rejects bundles the target would accept.
  registerInteractionBlocks(blocks);
  return { contentTypes, blocks };
}

async function validateWorkspace(
  workspacePath: string,
  invocation: BundleInvocation,
): Promise<CliCommandResult> {
  const { env, cwd, options } = invocation;
  const registries = loadRegistries(env, cwd, options);
  const temp = await mkdtemp(join(tmpdir(), "pcms-bundle-validate-"));
  try {
    const packed = await packWorkspace(workspacePath, { out: join(temp, "validate.pcpub") });
    const issues = await validatePcpub(packed.path, {
      // Same markdown bridge the server ingest applies (api pcpub-contracts):
      // rich-text props arrive as Markdown in PCMD, never as AST.
      richTextBridge: { markdownToRichText },
      ...(registries === null
        ? {}
        : {
            contracts: buildContracts(registries.contentTypes, registries.blocks),
            richTextPropsFor: richTextPropsFor(registries.blocks),
          }),
    });
    const payload = {
      external_entries_validation: "not_checked_on_server",
      external_entries: packed.manifest.external_entries ?? {},
      ok: issues.length === 0,
      bundle_id: packed.bundleId,
      issues,
      ...(registries === null
        ? { note: "no content.typesFile configured — semantic checks skipped" }
        : {}),
    };
    if (options.json)
      return { ...machineResult({ ...payload, issues }), exitCode: issues.length === 0 ? 0 : 2 };
    if (issues.length === 0) {
      return humanResult([
        `bundle OK (would pack as ${packed.bundleId})`,
        OFFLINE_NOTE,
        ...issues.map((issue) => `  warning [${issue.code}] ${issue.path}: ${issue.message}`),
      ]);
    }
    return {
      exitCode: 2,
      stdout: options.json ? jsonPayload(payload) : "",
      stderr: options.json
        ? ""
        : issues.map((issue) => `error [${issue.code}] ${issue.path}: ${issue.message}\n`).join(""),
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function validateBundleFile(
  bundlePath: string,
  invocation: BundleInvocation,
): Promise<CliCommandResult> {
  const registries = loadRegistries(invocation.env, invocation.cwd, invocation.options);
  const issues = await validatePcpub(bundlePath, {
    richTextBridge: { markdownToRichText },
    ...(registries === null
      ? {}
      : {
          contracts: buildContracts(registries.contentTypes, registries.blocks),
          richTextPropsFor: richTextPropsFor(registries.blocks),
        }),
  });
  const payload = {
    ok: issues.length === 0,
    issues,
    external_entries_validation: "not_checked_on_server",
  };
  if (invocation.options.json)
    return { ...machineResult(payload), exitCode: issues.length === 0 ? 0 : 2 };
  if (issues.length === 0) return humanResult(["bundle OK", OFFLINE_NOTE]);
  return {
    exitCode: 2,
    stdout: "",
    stderr: issues
      .map((issue) => `error [${issue.code}] ${issue.path}: ${issue.message}\n`)
      .join(""),
  };
}

/** Raw submit that returns the outcome exit semantics of the platform CLI. */
async function submitBundleFile(
  bundlePath: string,
  invocation: BundleInvocation,
): Promise<CliCommandResult> {
  const { options, env } = invocation;
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    return { exitCode: 2, stdout: "", stderr: `error: ${client}\n` };
  }
  const bytes = readFileSync(bundlePath);
  const bundleId = (await inspectPcpub(bundlePath)).bundle_id;
  let response: Response;
  try {
    response = await fetch(`${client.baseUrl}/api/v1/bundles/pcpub`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${client.token}`,
        "content-type": PCPUB_MIME,
        "idempotency-key": `pcpub:${bundleId}`,
        ...(client.siteKey === undefined ? {} : { "x-pcms-site": client.siteKey }),
        ...(client.environment === undefined ? {} : { "x-pcms-environment": client.environment }),
      },
      body: new Uint8Array(bytes),
    });
  } catch (error) {
    return {
      exitCode: 7,
      stdout: "",
      stderr: `error: API unreachable: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!response.ok && response.status !== 202) {
    const error = body["error"] as { code?: string; message?: string } | undefined;
    const code = error?.code ?? "API_ERROR";
    const message = error?.message ?? `HTTP ${response.status}`;
    const exitCode =
      code === "PCPUB_IDEMPOTENCY_BUNDLE_ID_REUSED" || code === "PCPUB_CONFLICT_STALE_BASE"
        ? 6
        : code.includes("AUTH")
          ? 3
          : 5;
    return {
      exitCode,
      stdout: options.json ? jsonPayload({ ok: false, error: { code, message } }) : "",
      stderr: options.json ? "" : `error: [${code}] ${message}\n`,
    };
  }
  const ingestId = body["ingest_id"] as string;
  if (!wantsWait(invocation)) {
    if (options.json) return machineResult({ ok: true, ...body });
    return humanResult([
      `accepted: bundle ${body["bundle_id"] as string} (${body["stage"] as string})`,
      `status: cms bundle status ${ingestId}`,
    ]);
  }
  // --wait: bounded polling until a terminal outcome.
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    const poll = await fetch(`${client.baseUrl}/api/v1/bundles/pcpub/ingests/${ingestId}`, {
      headers: {
        authorization: `Bearer ${client.token}`,
        ...(client.siteKey === undefined ? {} : { "x-pcms-site": client.siteKey }),
        ...(client.environment === undefined ? {} : { "x-pcms-environment": client.environment }),
      },
    });
    if (!poll.ok) {
      return {
        exitCode: 7,
        stdout: "",
        stderr: `error: status poll failed with HTTP ${poll.status}\n`,
      };
    }
    const status = (await poll.json()) as {
      stage: string;
      outcome: string | null;
      error_code: string | null;
      safe_error_detail?: { diagnostics?: readonly unknown[] } | null;
    };
    if (status.outcome !== null) {
      const payload = {
        ok: status.outcome === "sealed" || status.outcome === "published",
        ...status,
      };
      if (options.json)
        return machineResult(
          payload,
          status.outcome === "sealed" || status.outcome === "published" ? 0 : 6,
        );
      if (status.outcome === "sealed" || status.outcome === "published") {
        return humanResult([`outcome: ${status.outcome} (stage ${status.stage})`]);
      }
      // Rec 4 (152fz recommendations): surface the ingest diagnostics that
      // used to be visible only via a manual status call — the rejection
      // reasons (PCPUB_* codes, media-ref violations) are the whole point.
      const diagnostics =
        status.safe_error_detail?.diagnostics === undefined
          ? []
          : status.safe_error_detail.diagnostics.map((entry) => `  - ${JSON.stringify(entry)}`);
      return {
        exitCode: 6,
        stdout: "",
        stderr: `error: outcome ${status.outcome}${status.error_code === null ? "" : ` [${status.error_code}]`}\n${
          diagnostics.length > 0 ? `diagnostics:\n${diagnostics.join("\n")}\n` : ""
        }`,
      };
    }
    if (Date.now() > deadline) {
      return {
        exitCode: 7,
        stdout: "",
        stderr: "error: ingest did not finish within the wait window\n",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function bundleCommand(invocation: BundleInvocation): Promise<CliCommandResult> {
  const { args, options, env, cwd } = invocation;
  const [subcommand, operand, ...rest] = args;
  const usage = "usage: cms bundle <validate|pack|inspect|submit|status> ...\n";
  try {
    if (subcommand === "validate" && operand !== undefined) {
      const isDir = statSync(operand).isDirectory();
      return isDir
        ? await validateWorkspace(operand, invocation)
        : await validateBundleFile(operand, invocation);
    }
    if (subcommand === "pack" && operand !== undefined) {
      const outFlag = rest.indexOf("--out");
      const out = outFlag !== -1 ? rest[outFlag + 1] : undefined;
      if (out === undefined) {
        return { exitCode: 2, stdout: "", stderr: "error: pack requires --out <file.pcpub>\n" };
      }
      const packed = await packWorkspace(operand, { out });
      if (options.json) {
        return machineResult({
          ok: true,
          bundle_id: packed.bundleId,
          path: packed.path,
          archive_sha256: packed.archiveSha256,
          pcpub_version: packed.manifest.pcpub_version,
          external_entries: packed.manifest.external_entries ?? {},
          external_entries_validation: "not_checked_on_server",
          entries: packed.manifest.documents.length,
          assets: packed.manifest.assets.length,
        });
      }
      return humanResult([
        `packed ${packed.path}`,
        OFFLINE_NOTE,
        `bundle_id: ${packed.bundleId}`,
        `entries: ${packed.manifest.documents.length}, assets: ${packed.manifest.assets.length}`,
      ]);
    }
    if (subcommand === "inspect" && operand !== undefined) {
      const manifest = await inspectPcpub(operand);
      const payload = {
        external_entries: manifest.external_entries ?? {},
        external_entries_validation: "not_checked_on_server",
        bundle_id: manifest.bundle_id,
        pcpub_version: manifest.pcpub_version,
        pcmd_version: manifest.authoring.pcmd_version,
        producer: manifest.producer,
        created_at: manifest.created_at,
        entries: manifest.documents.length,
        assets: manifest.assets.length,
        artifacts: manifest.artifacts.length,
        requires: manifest.requires,
        intent: manifest.intent,
      };
      if (options.json) return machineResult(payload);
      return humanResult([
        `${manifest.bundle_id} (pcpub v${manifest.pcpub_version}, pcmd v${manifest.authoring.pcmd_version})`,
        OFFLINE_NOTE,
        `producer: ${manifest.producer.name} ${manifest.producer.version} at ${manifest.created_at}`,
        `entries: ${manifest.documents.length}, assets: ${manifest.assets.length}, artifacts: ${manifest.artifacts.length}`,
        `intent: ${manifest.intent.publication.mode} — ${manifest.intent.changeset_title}`,
      ]);
    }
    if (subcommand === "submit" && operand !== undefined) {
      return await submitBundleFile(operand, invocation);
    }
    if (subcommand === "status" && operand !== undefined) {
      const client = resolveApiClient(options, env);
      if (typeof client === "string") {
        return { exitCode: 2, stdout: "", stderr: `error: ${client}\n` };
      }
      const response = await fetch(
        `${client.baseUrl}/api/v1/bundles/pcpub/ingests/${encodeURIComponent(operand)}`,
        { headers: { authorization: `Bearer ${client.token}` } },
      );
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const error = body["error"] as { code?: string; message?: string } | undefined;
        return {
          exitCode: response.status === 404 ? 6 : 5,
          stdout: "",
          stderr: `error: [${error?.code ?? "API_ERROR"}] ${error?.message ?? `HTTP ${response.status}`}\n`,
        };
      }
      if (options.json) return machineResult(body);
      return humanResult([
        `ingest ${operand}: stage=${body["stage"] as string} outcome=${(body["outcome"] as string) ?? "pending"}`,
      ]);
    }
    return { exitCode: 2, stdout: "", stderr: usage };
  } catch (error) {
    return failureResult(error, options);
  }
}
