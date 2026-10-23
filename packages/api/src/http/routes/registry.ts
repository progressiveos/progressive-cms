// Registry REST surface (Community Registry v1 plan §4): catalog, package
// cards, install-from-registry, publish local skill, engine releases and
// one-click apply-update (stages the artifact into incoming/ then rides the
// EXISTING update orchestrator — no new deploy path).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PERMISSION_REGISTRY, recordSecurityEvent } from "@pcms/auth";
import { latestUpdateRecord, recordFailedUpdateAttempt } from "@pcms/extensions/internal";
import { installSkillPackage, loadCommunitySkills, SkillInstallError } from "@pcms/skills";
import { gt, valid } from "semver";
import yauzl from "yauzl";
import yazl from "yazl";
import { type ApplicationServices, auditBase, type OperationContext } from "../../context.js";
import { ApiError } from "../../errors.js";
import { applyUpdate } from "../../extensions-ops.js";
import {
  RELEASE_ARTIFACT_MAX_BYTES,
  RegistryError,
  type RegistryRelease,
} from "../../registry-client.js";
import type { ApiRoute } from "../registry.js";

function registryOf(app: ApplicationServices) {
  if (app.registryClient === null) {
    throw new ApiError(
      "REGISTRY_NOT_CONFIGURED",
      "registry is not configured: set registry.baseUrl and the registry.token secret slot",
      { status: 409 },
    );
  }
  return app.registryClient;
}

async function wrapRegistry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RegistryError) {
      throw new ApiError(error.code, error.message, { status: 502 });
    }
    throw error;
  }
}

/** Strict SemVer greater-than, including prerelease precedence.
 * Anything unparsable is never considered newer. Owner design 2026-10-06:
 * no downgrades, no same-version re-installs — the apply gate refuses
 * anything not strictly newer than the running release (the preflight
 * UPDATE_NOT_AN_UPGRADE warning alone let a stale button re-install the
 * running version — p-cms.com incident). Exported for tests.
 * @internal
 */
export const __isVersionNewer = (candidate: string, current: string): boolean => {
  return valid(candidate) !== null && valid(current) !== null && gt(candidate, current);
};

/** Full runtime version from composition, never parsed from the release id. */
const currentCmsVersion = (app: ApplicationServices): string => {
  const version = app.extensions.contractVersions.get("cms")?.version;
  if (version === undefined || valid(version) === null || version === "0.0.0") {
    throw new ApiError(
      "UPDATE_RUNTIME_VERSION_INVALID",
      "the running CMS version is unavailable or invalid",
      { status: 409 },
    );
  }
  return version;
};

/** Zip an installed community skill back into a publishable .pcskill. */
async function zipSkillDirectory(directory: string): Promise<Buffer> {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const zip = new yazl.ZipFile();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(directory, relative))) {
      if (entry === ".pcms-disabled") continue;
      const child = relative === "" ? entry : `${relative}/${entry}`;
      if (statSync(join(directory, child)).isDirectory()) walk(child);
      else zip.addBuffer(readFileSync(join(directory, child)), child);
    }
  };
  walk("");
  zip.end();
  const chunks: Buffer[] = [];
  return await new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

/** Agent observations file (owner decision 2026-10-01): the site agent
 * appends notes here; the update report ships them to the repository.
 * Contract location (REGISTRY-INSTANCES-V2 §4, mirrored by the site-builder
 * SKILL.md): the instance state root — two levels above the active theme
 * dir (…/themes/<site>) — NOT the themes dir itself. */
function observationsFileOf(app: ApplicationServices): string | null {
  if (app.themeDir === undefined) return null;
  return join(
    dirname(dirname(app.themeRuntime?.configuredDir ?? app.themeDir)),
    "agent-observations.md",
  );
}

/** Exported for tests (contract path).
 * @internal
 */
export const __observationsFileOf = (app: { readonly themeDir?: string }): string | null =>
  observationsFileOf(app as ApplicationServices);

/**
 * Report-ready observations: the file ships verbatim except for heading
 * lines — agents who keep their own "# Agent observations" title would
 * otherwise double the report header (seen live on 0.1.134's report).
 * Exported for tests.
 * @internal
 */
export function __normalizeObservations(raw: string): string {
  return raw
    .replace(/^#{1,3}\s+agent observations[^\n]*$\n?/gim, "")
    .slice(0, 32 * 1024)
    .trim();
}

/** Stages an artifact into incoming/ (module-level: shared by the registry
 * apply-update and the manual release-upload paths). Staging failures get an
 * actionable message: a stale file from a manual install owned by another
 * user surfaces here as EACCES (p-cms.com incident 2026-10-06). */
function stageArtifact(incomingDir: string, name: string, content: string | Buffer): void {
  const path = join(incomingDir, name);
  // Stale files from manual installs are often owned by another user
  // (site agents run as ubuntu) — opening them for write fails with
  // EACCES even though the directory itself is group-writable. Unlink
  // first; the dir permission is what actually governs staging here.
  try {
    unlinkSync(path);
  } catch {
    // ENOENT is the normal path; an EACCES here re-surfaces on write.
  }
  try {
    writeFileSync(path, content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EACCES" || code === "EPERM") {
      throw new ApiError(
        "UPDATE_STAGE_FAILED",
        `cannot write ${name} into ${incomingDir} — the directory is not writable by the service user; fix ownership and retry`,
        { status: 500 },
      );
    }
    throw error;
  }
}

/** Registry-driven update: index → release → version gate → download →
 * sha256 verify → stage into incoming/ → standard orchestrator → telemetry.
 * Shared by the REST route and the MCP mirror (owner 2026-10-06 audit). */
export async function registryApplyUpdateOp(
  app: ApplicationServices,
  ctx: OperationContext,
  version: string,
  opts: { readonly wait?: boolean } = {},
): Promise<Record<string, unknown>> {
  const index = await wrapRegistry(() => registryOf(app).index());
  const release = index.releases.find((candidate) => candidate.version === version);
  if (release === undefined) {
    throw new ApiError(
      "REGISTRY_RELEASE_NOT_FOUND",
      `release "${version}" is not in the registry`,
      {
        status: 404,
      },
    );
  }
  // Update gate (owner design 2026-10-06): only strictly newer versions
  // apply. Same version = nothing to do; older = downgrade, refused.
  const currentVersion = currentCmsVersion(app);
  if (!__isVersionNewer(version, currentVersion)) {
    throw new ApiError(
      "UPDATE_NOT_AN_UPGRADE",
      version === currentVersion
        ? `version ${version} is already installed — nothing to apply`
        : `downgrade refused: ${version} is not newer than the running ${currentVersion}`,
      { status: 409 },
    );
  }
  // Async apply (owner 2026-10-07): the synchronous POST holds the browser
  // for ~40s and long proxy chains mangle the body on the way back. With
  // wait=false the endpoint returns RUNNING immediately while the heavy
  // part (download → stage → orchestrator) continues detached; pollers
  // arbitrate on GET /registry/update-status (pcms_update_history), never
  // on this response body.
  if (opts.wait === false) {
    const from = currentVersion;
    const actor = {
      type: ctx.actor.type,
      ...(ctx.actor.id === undefined ? {} : { id: ctx.actor.id }),
    };
    void applyStagedRelease(app, ctx, release, version).catch(async (error: unknown) => {
      console.error("[update] async apply failed:", error);
      const code = (error as { code?: string } | null)?.code;
      try {
        await recordFailedUpdateAttempt(app.pool, app.clock, {
          from_version: from,
          to_version: version,
          failure_code: typeof code === "string" && code !== "" ? code : "UPDATE_STAGE_FAILED",
          actor,
        });
      } catch {
        // best-effort: the orchestrator path records its own failures
      }
    });
    return {
      staged: null,
      sha256: null,
      update: {
        id: null,
        status: "RUNNING",
        failure_code: null,
        rollback_policy: null,
        from_version: from,
        to_version: version,
      },
    };
  }
  return applyStagedRelease(app, ctx, release, version);
}

async function applyStagedRelease(
  app: ApplicationServices,
  ctx: OperationContext,
  release: RegistryRelease,
  version: string,
): Promise<Record<string, unknown>> {
  const bytes = await wrapRegistry(() => registryOf(app).downloadRelease(release));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== release.sha256) {
    throw new ApiError(
      "REGISTRY_CHECKSUM_MISMATCH",
      `artifact sha256 mismatch (expected ${release.sha256}, got ${sha256})`,
      { status: 422 },
    );
  }
  const incomingDir = app.registryIncomingDir;
  // Artifacts are zip (0.1.91+ contract); tar.gz remains for legacy
  // entries still present in a registry index.
  const artifactName = `progressive-cms-registry-${version}${isZip(bytes) ? ".zip" : ".tar.gz"}`;
  stageArtifact(incomingDir, artifactName, bytes);
  stageArtifact(incomingDir, `${artifactName}.sha256`, `${sha256}  ${artifactName}\n`); // Extract the embedded update manifest as the apply target. The
  // artifact is sha256-verified against the registry index seconds
  // earlier, so the manifest is trusted as the apply target — the
  // configured boot-time target compare is skipped (it can never match
  // on first download; the operator intent IS this version).
  const manifest = await extractUpdateManifest(bytes);
  stageArtifact(incomingDir, "update-manifest.json", JSON.stringify(manifest, null, 1));
  const applied = (await applyUpdate(app, ctx, {
    manifest,
    backup_confirmation: version,
    confirmed_from_registry: true,
  })) as Record<string, unknown>;
  // Per-instance telemetry (2026-09-29): best-effort — never fails the
  // apply, never blocks on the registry being slow.
  const instanceCode = await app.registryInstanceCode.read();
  if (instanceCode !== null) {
    void registryOf(app)
      .noticeDownload(instanceCode, version)
      .catch(() => {});
    // Agent report (owner decision 2026-10-01: markdown, consent-gated,
    // best-effort — a failed upload never affects the update result).
    if (app.registryReportUpdates === true) {
      const previous = currentCmsVersion(app);
      const finishedAt = new Date().toISOString();
      let markdown = [
        "# PCMS update report",
        "",
        "| field | value |",
        "|---|---|",
        `| instance_code | ${instanceCode} |`,
        `| version | ${version} |`,
        `| previous_version | ${previous} |`,
        `| finished_at | ${finishedAt} |`,
        "| result | SUCCEEDED |",
        "",
      ].join("\n");
      const observationsPath = observationsFileOf(app);
      if (observationsPath !== null && existsSync(observationsPath)) {
        const raw = readFileSync(observationsPath, "utf8");
        const notes = __normalizeObservations(raw);
        if (notes.length > 0) {
          markdown += `\n\n## Agent observations\n\n${notes}\n`;
        }
        if (raw.trim().length > 0) {
          // Consume-after-report (owner request 2026-10-01): shipped
          // notes must not ride along on every later update (0.1.125-era
          // text was still shipping with 0.1.134). Cleared right after
          // the report body is built; the send itself stays best-effort
          // — the update just downloaded from the registry, so the
          // transport was proven reachable moments ago. A clear failure
          // never affects the apply.
          try {
            writeFileSync(observationsPath, "");
          } catch {
            // best-effort tier: next report ships the same notes again
          }
        }
      }
      void registryOf(app)
        .report(instanceCode, markdown)
        .catch(() => {});
    }
  }
  return { staged: artifactName, sha256, update: applied };
}

export function makeRegistryRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "GET",
        url: "/registry/index",
        operationId: "registry_index",
        summary: "Artifact repository catalog: packages (skills/extensions) and engine releases",
        tag: "discovery",
        auth: "authenticated",
      },
      async handle(app) {
        if (app.registryClient === null) {
          return { status: 200, body: { configured: false, packages: [], releases: [] } };
        }
        const index = await wrapRegistry(() => registryOf(app).index());
        return { status: 200, body: { configured: true, ...index } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/registry/packages/:id",
        operationId: "registry_package_card",
        summary: "Package card from the repository (description, versions, check status)",
        tag: "discovery",
        auth: "authenticated",
      },
      async handle(app, _ctx, request) {
        const params = request.params as { id: string };
        const card = await wrapRegistry(() => registryOf(app).packageCard(params.id));
        return { status: 200, body: card };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/registry/install",
        operationId: "registry_install_package",
        summary:
          "Install an approved repository skill package (bytes stream through the existing fail-closed installer; skills.manage)",
        tag: "discovery",
        auth: "authenticated",
        permission: "skills.manage",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["download_url"],
          properties: { download_url: { type: "string", minLength: 8, maxLength: 2048 } },
        },
      },
      async handle(app, _ctx, request) {
        if (!app.communitySkillsEnabled) {
          throw new ApiError(
            "SKILLS_COMMUNITY_DISABLED",
            "community skills are disabled: set skills.communityEnabled=true in the config",
            { status: 409 },
          );
        }
        const body = request.body as { download_url?: unknown };
        const url = typeof body.download_url === "string" ? body.download_url : "";
        const bytes = await wrapRegistry(() => registryOf(app).download(url));
        try {
          const result = await installSkillPackage(bytes, {
            communityDir: app.communitySkillsDir,
            firstPartyIds: (await import("@pcms/skills"))
              .loadInstalledSkills(app.skillsDir)
              .skills.map(({ manifest }) => manifest.id),
            isRegisteredPermission: (scope: string) =>
              PERMISSION_REGISTRY.some((definition) => definition.key === scope),
            source: url,
          });
          return { status: 201, body: { id: result.skill.manifest.id, sha256: result.sha256 } };
        } catch (error) {
          if (error instanceof SkillInstallError) {
            throw new ApiError(error.code, error.message, { status: 422 });
          }
          throw error;
        }
      },
    },
    {
      spec: {
        method: "POST",
        url: "/registry/publish/:skillId",
        operationId: "registry_publish_skill",
        summary:
          "Publish an installed community skill to the repository (upload goes through the account token; review pending) (skills.manage)",
        tag: "discovery",
        auth: "authenticated",
        permission: "skills.manage",
        csrf: true,
      },
      async handle(app, ctx, request) {
        const params = request.params as { skillId: string };
        if (!params.skillId.startsWith("community.")) {
          throw new ApiError("SKILL_ID_FORBIDDEN", "only community skills can be published", {
            status: 403,
          });
        }
        const skill = loadCommunitySkills(app.communitySkillsDir).skills.find(
          (candidate) => candidate.manifest.id === params.skillId,
        );
        if (skill === undefined) {
          throw new ApiError(
            "SKILL_NOT_FOUND",
            `community skill "${params.skillId}" is not installed`,
            {
              status: 404,
            },
          );
        }
        const bytes = await zipSkillDirectory(skill.directory);
        const token = (await app.registryAccountTokenRuntime.read()) ?? app.registryAccountToken;
        if (token === undefined || token === null) {
          throw new ApiError(
            "REGISTRY_NOT_CONFIGURED",
            "registry account token is not configured (secret slot registry.token)",
            { status: 409 },
          );
        }
        const base = registryOf(app).baseUrl as string;
        const response = await fetch(`${base}/api/v1/publish`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
          body: new Uint8Array(bytes),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          throw new ApiError(
            "REGISTRY_PUBLISH_FAILED",
            `registry publish HTTP ${response.status}`,
            {
              status: 502,
            },
          );
        }
        await recordSecurityEvent(app.pool, null, {
          type: "SKILL_INSTALLED",
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          transport: ctx.transport === "rest" ? "api" : ctx.transport,
          metadata: { published: params.skillId, bytes: bytes.byteLength },
        });
        const result = (await response.json()) as Record<string, unknown>;
        return { status: 200, body: { published: true, registry: result } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/registry/instance",
        operationId: "registry_instance_get",
        summary:
          "This instance's registry binding identity: the stable instance code (generated on first read, shown in Admin for the account-area claim flow; NOT secret per owner decision).",
        tag: "discovery",
        auth: "authenticated",
        permission: "extensions.manage",
      },
      async handle(app, ctx) {
        let code = await app.registryInstanceCode.read();
        if (code === null) {
          // Crockford Base32 (no 0/O/1/I/L), human-groups of five — the code
          // is typed by the owner into the account area and compared visually.
          const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
          const raw = randomBytes(15);
          let generated = "";
          for (const byte of raw) generated += alphabet[byte % alphabet.length];
          code = `PCMS-${generated.slice(0, 5)}-${generated.slice(5, 10)}-${generated.slice(10, 15)}`;
          await app.registryInstanceCode.write(code, `${ctx.actor.type}:${ctx.actor.id}`);
        }
        const accountToken = await app.registryAccountTokenRuntime.read();
        return {
          status: 200,
          body: {
            instance_code: code,
            report_updates: app.registryReportUpdates === true,
            account_token_set: accountToken !== null || app.registryAccountToken !== null,
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/registry/instance/status",
        operationId: "registry_instance_status",
        summary:
          "Binding status from the repository for this instance's code (unknown / unclaimed / pending / confirmed + account email). Registry unreachable → status unknown.",
        tag: "discovery",
        auth: "authenticated",
        permission: "extensions.manage",
      },
      async handle(app) {
        const code = await app.registryInstanceCode.read();
        if (code === null) return { status: 200, body: { status: "unclaimed" } };
        try {
          const status = await registryOf(app).confirmStatus(code);
          return { status: 200, body: { instance_code: code, ...status } };
        } catch (error) {
          // Registry down = binding status simply unknown, never a 500.
          if (error instanceof RegistryError) {
            return { status: 200, body: { instance_code: code, status: "unknown" } };
          }
          throw error;
        }
      },
    },
    {
      spec: {
        method: "POST",
        url: "/registry/instance/confirm",
        operationId: "registry_instance_confirm",
        summary:
          "Registry v2 binding, phase 2: confirm the owner's pending claim and store the issued per-instance token (encrypted, never readable back). Last confirm wins.",
        tag: "discovery",
        auth: "authenticated",
        permission: "extensions.manage",
        csrf: true,
      },
      async handle(app, ctx) {
        const code = await app.registryInstanceCode.read();
        if (code === null) {
          throw new ApiError("REGISTRY_CODE_UNKNOWN", "instance code is not generated yet", {
            status: 409,
          });
        }
        const confirmed = await registryOf(app).confirmInstance(code);
        await app.registryInstanceToken.write(confirmed.token, `${ctx.actor.type}:${ctx.actor.id}`);
        await recordSecurityEvent(app.pool, null, {
          type: "REGISTRY_INSTANCE_REGISTERED",
          ...auditBase(ctx),
          subjectType: "registry_instance",
          subjectId: code,
          metadata: { account_email: confirmed.account_email },
        });
        return { status: 200, body: { bound: true, account_email: confirmed.account_email } };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/registry/account-token",
        operationId: "registry_account_token_set",
        summary:
          "Store the registry account token (write-only runtime secret; catalog access without rebind; extensions.manage). Never readable back, never logged.",
        tag: "discovery",
        auth: "authenticated",
        permission: "extensions.manage",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: { token: { type: "string", minLength: 16, maxLength: 512 } },
        },
      },
      async handle(app, ctx, request) {
        const body = request.body as { token?: unknown };
        if (typeof body.token !== "string" || body.token.trim().length < 16) {
          throw new ApiError("REGISTRY_ACCOUNT_TOKEN_INVALID", "token looks too short", {
            status: 422,
          });
        }
        await app.registryAccountTokenRuntime.write(
          body.token.trim(),
          `${ctx.actor.type}:${ctx.actor.id}`,
        );
        await recordSecurityEvent(app.pool, null, {
          type: "REGISTRY_ACCOUNT_TOKEN_SET",
          ...auditBase(ctx),
          subjectType: "registry_account_token",
          subjectId: await app.registryInstanceCode.read().then((code) => code ?? "ungenerated"),
          metadata: {},
        });
        return { status: 200, body: { set: true } };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/registry/account-token",
        operationId: "registry_account_token_clear",
        summary:
          "Remove the stored registry account token (extensions.manage; audited without the value).",
        tag: "discovery",
        auth: "authenticated",
        permission: "extensions.manage",
        csrf: true,
      },
      async handle(app, ctx) {
        await app.registryAccountTokenRuntime.clear(`${ctx.actor.type}:${ctx.actor.id}`);
        await recordSecurityEvent(app.pool, null, {
          type: "REGISTRY_ACCOUNT_TOKEN_CLEARED",
          ...auditBase(ctx),
          subjectType: "registry_account_token",
          subjectId: await app.registryInstanceCode.read().then((code) => code ?? "ungenerated"),
          metadata: {},
        });
        return { status: 200, body: { set: false } };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/registry/release-upload",
        operationId: "registry_release_upload",
        summary:
          "Manual engine-release install for unregistered deployments: upload the release zip (application/octet-stream), it is validated (embedded update manifest, strictly newer version), staged into incoming/ with its checksum sidecar and applied through the standard update orchestrator (extensions.manage)",
        tag: "discovery",
        auth: "authenticated",
        permission: "extensions.manage",
        csrf: true,
        bodyLimit: RELEASE_ARTIFACT_MAX_BYTES,
      },
      async handle(app, ctx, request) {
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1000) {
          throw new ApiError(
            "API_REQUEST_INVALID",
            "body must be the release zip as application/octet-stream",
            { status: 422 },
          );
        }
        if (!isZip(bytes)) {
          throw new ApiError("UPDATE_MANIFEST_INVALID", "artifact must be a zip archive", {
            status: 422,
          });
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        // Wild-archive control (owner 2026-10-06): the manifest must parse
        // and the version must be STRICTLY newer — same version is a no-op,
        // older is a downgrade, both refused before anything is staged.
        const manifest = await extractUpdateManifest(bytes);
        const targetVersion = String((manifest as { version?: unknown }).version ?? "");
        const currentVersion = currentCmsVersion(app);
        if (!__isVersionNewer(targetVersion, currentVersion)) {
          throw new ApiError(
            "UPDATE_NOT_AN_UPGRADE",
            targetVersion === currentVersion
              ? `version ${targetVersion} is already installed — nothing to apply`
              : `downgrade refused: ${targetVersion} is not newer than the running ${currentVersion}`,
            { status: 409 },
          );
        }
        const incomingDir = app.registryIncomingDir;
        const artifactName = `progressive-cms-registry-${targetVersion}.zip`;
        stageArtifact(incomingDir, artifactName, bytes);
        stageArtifact(incomingDir, `${artifactName}.sha256`, `${sha256}  ${artifactName}\n`);
        stageArtifact(incomingDir, "update-manifest.json", JSON.stringify(manifest, null, 1));
        await recordSecurityEvent(app.pool, null, {
          type: "UPDATE_APPLY_ATTEMPT",
          ...auditBase(ctx),
          subjectType: "update",
          subjectId: `upload:${targetVersion}`,
          metadata: { source: "manual-upload", sha256, size_bytes: bytes.byteLength },
        });
        const applied = (await applyUpdate(app, ctx, {
          manifest,
          backup_confirmation: targetVersion,
          confirmed_from_registry: true,
        })) as Record<string, unknown>;
        return { status: 200, body: { staged: artifactName, sha256, update: applied } };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/registry/apply-update",
        operationId: "registry_apply_update",
        summary:
          "Download an engine release from the repository into incoming/ and apply it through the standard update orchestrator (extensions.manage)",
        tag: "discovery",
        auth: "authenticated",
        permission: "extensions.manage",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["version"],
          properties: {
            version: { type: "string", minLength: 1, maxLength: 32 },
            wait: { type: "boolean" },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = request.body as { version?: unknown; wait?: unknown };
        const version = typeof body.version === "string" ? body.version : "";
        const wait = body.wait !== false;
        return {
          status: 200,
          body: await registryApplyUpdateOp(app, ctx, version, { wait }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/registry/update-status",
        operationId: "registry_update_status",
        summary:
          "Latest update-orchestrator record plus the running cms version — the arbiter for async apply-update polling",
        tag: "discovery",
        auth: "authenticated",
        permission: "extensions.manage",
      },
      async handle(app) {
        const record = await latestUpdateRecord(app.pool);
        return {
          status: 200,
          body: {
            current_version: currentCmsVersion(app),
            deployment: {
              running_version: currentCmsVersion(app),
              running_release_id: app.releaseId,
              selected: app.selectedReleaseStatus?.() ?? null,
            },
            update:
              record === null
                ? null
                : {
                    id: record.id,
                    status: record.status,
                    from_version: record.fromVersion,
                    to_version: record.toVersion,
                    failure_code: record.failureCode ?? null,
                    backup_warnings: record.validationSummary.backup_warnings ?? [],
                    started_at: record.startedAt.toISOString(),
                    completed_at: record.completedAt?.toISOString() ?? null,
                  },
          },
        };
      },
    },
  ];
}

/** Exported for tests (zip member read).
 * @internal
 */
export const __extractUpdateManifest = extractUpdateManifest;

function isZip(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).toString("latin1") === "PK\x03\x04";
}

function readZipMember(bytes: Buffer, memberSuffix: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || zipFile === undefined) {
          reject(
            new ApiError("REGISTRY_ARTIFACT_INVALID", "artifact is not a readable zip", {
              status: 422,
            }),
          );
          return;
        }
        zipFile.on("entry", (entry: yauzl.Entry) => {
          if (!entry.fileName.endsWith(memberSuffix) || entry.fileName.endsWith("/")) {
            zipFile.readEntry();
            return;
          }
          zipFile.openReadStream(entry, (streamError, stream) => {
            if (streamError || stream === undefined) {
              reject(
                new ApiError("REGISTRY_ARTIFACT_INVALID", `cannot read ${entry.fileName}`, {
                  status: 422,
                }),
              );
              return;
            }
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            stream.on("error", () =>
              reject(
                new ApiError("REGISTRY_ARTIFACT_INVALID", `cannot read ${entry.fileName}`, {
                  status: 422,
                }),
              ),
            );
          });
        });
        zipFile.on("end", () => resolve(null));
        zipFile.on("error", () =>
          reject(
            new ApiError("REGISTRY_ARTIFACT_INVALID", "corrupt zip artifact", { status: 422 }),
          ),
        );
        zipFile.readEntry();
      },
    );
  });
}

async function extractUpdateManifest(artifactBytes: Buffer): Promise<unknown> {
  // PCMS release artifacts are zip (0.1.91+ yazl contract) with the manifest
  // at the release-dir root; legacy tar.gz entries are still honored. The
  // artifact was sha256-verified against the registry index seconds earlier.
  if (isZip(artifactBytes)) {
    const body = await readZipMember(artifactBytes, "update-manifest.json");
    if (body === null) {
      throw new ApiError(
        "REGISTRY_ARTIFACT_INVALID",
        "release artifact has no update-manifest.json",
        {
          status: 422,
        },
      );
    }
    return JSON.parse(body) as unknown;
  }
  const { gunzipSync } = await import("node:zlib");
  const tarBytes = gunzipSync(artifactBytes);
  for (let offset = 0; offset + 512 <= tarBytes.byteLength; ) {
    const header = tarBytes.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeField = header.subarray(124, 136).toString("utf8").trim();
    const size = sizeField === "" ? 0 : Number.parseInt(sizeField, 8);
    if (Number.isFinite(size)) {
      if (name === "update-manifest.json" || name.endsWith("/update-manifest.json")) {
        const body = tarBytes.subarray(offset + 512, offset + 512 + size).toString("utf8");
        return JSON.parse(body) as unknown;
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    } else break;
  }
  throw new ApiError("REGISTRY_ARTIFACT_INVALID", "release artifact has no update-manifest.json", {
    status: 422,
  });
}
