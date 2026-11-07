// Runs under the EXISTING privileged install unit, outside the web process.
// Extension JavaScript is never imported by this root-owned controller.
import { execFile } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { type DbPool, systemClock } from "@pcms/core";
import {
  assertExtensionStorePath,
  canonicalPackageJson,
  createCapabilityRegistry,
  createExtensionCatalog,
  createExtensionLifecycleService,
  createUpdateOrchestrator,
  defineExtensionArtifact,
  type ExtensionCatalog,
  type ExtensionPackageTrust,
  extensionFileSha256,
  independentGenerationDigest,
  planIndependentExtensionUpdate,
  readIndependentExtensionPackages,
  releaseUpdateLease,
  stageIndependentExtensionPackage,
  type VerifiedExtensionPackage,
} from "@pcms/extensions/internal";
import { readWorkerHeartbeat } from "@pcms/operations";
import { THEME_CONTRACT_VERSION } from "@pcms/themes";
import {
  createProductionUpdatePorts,
  waitForWorkerRestartConfirmation,
} from "./update-adapters.js";

const exec = promisify(execFile);
export interface IndependentUpdateIntent {
  readonly schema: "pcms-extension-update-intent/1";
  readonly leaseId: string;
  readonly extensionId: string;
  readonly version: string;
  readonly artifact: string;
  readonly sha256: string;
  readonly packageDigest: string;
  readonly coreReleaseId: string;
  readonly coreVersion: string;
  readonly approvedPermissions: readonly string[];
  readonly actor: { readonly type: string; readonly id?: string };
}

function dataOnlyCatalog(
  root: string,
  packages: readonly VerifiedExtensionPackage[],
): ExtensionCatalog {
  const catalog = createExtensionCatalog();
  const manifest = JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")) as {
    first_party_extensions: readonly { id: string; dir: string; content_sha256: string }[];
  };
  for (const pkg of manifest.first_party_extensions) {
    if (!/^extensions\/[a-z0-9][a-z0-9-]*$/.test(pkg.dir))
      throw new Error("invalid deployed Core package directory");
    const directory = join(root, pkg.dir);
    const doc = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    if (doc.id !== pkg.id) throw new Error("Core inventory identity mismatch");
    catalog.register(
      defineExtensionArtifact({
        manifest: doc,
        module: {},
        extensionsDir: directory,
        ...(doc.migrations ? { migrationsDir: join(directory, doc.migrations.dir) } : {}),
        contentSha256: pkg.content_sha256,
      }),
    );
  }
  for (const pkg of packages)
    catalog.register(
      defineExtensionArtifact({
        manifest: pkg.manifest,
        module: {},
        extensionsDir: pkg.directory,
        ...(pkg.manifest.migrations
          ? { migrationsDir: join(pkg.directory, pkg.manifest.migrations.dir) }
          : {}),
        contentSha256: pkg.digest,
      }),
    );
  return catalog;
}

export async function runIndependentExtensionUpdate(options: {
  readonly pool: DbPool;
  readonly currentRoot: string;
  readonly currentSymlink: string;
  readonly incomingDir: string;
  readonly storeDir: string;
  readonly trustFile: string;
  readonly configFile: string;
  readonly healthUrl: string;
  readonly intent: IndependentUpdateIntent;
  readonly allowDev?: boolean;
}): Promise<unknown> {
  const { pool, intent } = options;
  const beforeRoot = realpathSync(options.currentSymlink);
  const identity = JSON.parse(
    readFileSync(join(options.currentRoot, "build-metadata.json"), "utf8"),
  );
  if (
    beforeRoot !== realpathSync(options.currentRoot) ||
    identity.releaseId !== intent.coreReleaseId ||
    identity.version !== intent.coreVersion
  )
    throw new Error("Core changed after the extension update was planned");
  if (
    intent.schema !== "pcms-extension-update-intent/1" ||
    !/^[a-f0-9-]{36}$/.test(intent.leaseId) ||
    basename(intent.artifact) !== intent.artifact ||
    !intent.artifact.endsWith(".zip") ||
    intent.artifact.includes("\\") ||
    !/^[a-f0-9]{64}$/.test(intent.sha256) ||
    !/^[a-f0-9]{64}$/.test(intent.packageDigest)
  )
    throw new Error("invalid extension install intent");
  const lease = await pool.query<{ value: string }>(
    "SELECT value FROM pcms_kernel_metadata WHERE key = 'update.exclusive_lease'",
  );
  const reserved = lease.rows[0] ? JSON.parse(lease.rows[0].value) : null;
  if (
    reserved?.id !== intent.leaseId ||
    reserved?.product_id !== intent.extensionId ||
    reserved?.state !== "STAGED"
  )
    throw new Error("extension intent does not own the staged update lease");
  assertExtensionStorePath(options.storeDir, options.storeDir);
  assertExtensionStorePath(options.trustFile, options.trustFile);
  const archive = join(options.incomingDir, intent.artifact);
  if (
    !lstatSync(archive).isFile() ||
    lstatSync(archive).isSymbolicLink() ||
    lstatSync(archive).size > 64 * 1024 * 1024
  )
    throw new Error("invalid staged extension archive");
  const bytes = readFileSync(archive);
  if (extensionFileSha256(bytes) !== intent.sha256)
    throw new Error("staged extension archive checksum mismatch");
  const trust = JSON.parse(readFileSync(options.trustFile, "utf8")) as ExtensionPackageTrust;
  const oldPackages = readIndependentExtensionPackages({
    storeDir: options.storeDir,
    trustFile: options.trustFile,
    coreVersion: identity.version,
    ...(options.allowDev ? { allowDev: true } : {}),
  });
  const staged = await stageIndependentExtensionPackage({
    bytes,
    stagingDir: join(options.storeDir, "staging"),
    trust,
    coreVersion: identity.version,
    ...(options.allowDev ? { allowDev: true } : {}),
  });
  try {
    if (
      staged.digest !== intent.packageDigest ||
      staged.manifest.id !== intent.extensionId ||
      staged.manifest.version !== intent.version
    )
      throw new Error("staged package does not match approved target");
    const oldIndex = readFileSync(join(options.storeDir, "active.json"));
    const oldCatalog = dataOnlyCatalog(options.currentRoot, oldPackages);
    const capabilities = createCapabilityRegistry();
    capabilities.provide({
      key: "theme-contract",
      version: THEME_CONTRACT_VERSION,
      provider: "cms:themes",
    });
    const oldLifecycle = createExtensionLifecycleService({
      pool,
      clock: systemClock,
      coreVersion: identity.version,
      catalog: oldCatalog,
      systemCapabilities: capabilities,
    });
    const readPlan = async () => {
      const installed = await oldLifecycle.getInstallation(intent.extensionId);
      const effectiveCapabilities = [...capabilities.list()];
      for (const id of await oldLifecycle.enabledIds())
        for (const capability of oldCatalog.get(id)?.manifest.provides ?? [])
          effectiveCapabilities.push({
            key: capability.capability,
            version: capability.version,
            provider: id,
            multi: false,
          });
      const ledger = await pool.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM pcms_extension_migrations WHERE extension_id = $1 ORDER BY name",
        [intent.extensionId],
      );
      const jobs = await pool.query<{ type: string; payload_version: number | null }>(
        "SELECT DISTINCT type, payload_version FROM jobs WHERE starts_with(type, $1) AND state IN ('PENDING', 'RUNNING', 'FAILED')",
        [`${intent.extensionId}/`],
      );
      const planned = planIndependentExtensionUpdate({
        target: staged,
        currentVersion: installed?.version ?? null,
        currentDigest: installed?.artifactDigest ?? null,
        currentPermissions: oldCatalog.get(intent.extensionId)?.manifest.permissions ?? [],
        currentConfig: installed?.config ?? {},
        currentEnabled: installed?.state === "ENABLED",
        enabledExtensions: (await oldLifecycle.enabledIds()).map((id) => ({
          id,
          requires: oldCatalog.get(id)?.manifest.requires ?? [],
        })),
        approvedPermissions: intent.approvedPermissions,
        capabilities: effectiveCapabilities,
        appliedMigrations: ledger.rows,
        queuedJobs: jobs.rows.map((job) => ({
          jobId: job.type.slice(intent.extensionId.length + 1),
          payloadVersion: job.payload_version ?? 1,
        })),
        coreVersion: identity.version,
        currentJobs: oldCatalog.get(intent.extensionId)?.manifest.registrations.jobs ?? [],
      });
      return { installed, planned };
    };
    const { installed, planned } = await readPlan();
    if (planned.preflight.outcome === "BLOCKED")
      throw new Error(
        `extension preflight blocked: ${planned.preflight.issues.map((issue) => issue.code).join(", ")}`,
      );
    if (planned.noOp) {
      rmSync(staged.directory, { recursive: true, force: true });
      await releaseUpdateLease(pool, intent.leaseId);
      return { status: "NO_OP", product_id: intent.extensionId, version: installed?.version };
    }
    const common = createProductionUpdatePorts({
      currentReleaseRoot: options.currentRoot,
      incomingDir: options.incomingDir,
      currentSymlink: options.currentSymlink,
      installStatusFile: "/run/progressive-cms/install.status",
      backupUnit: "progressive-cms-backup.service",
      installUnit: "progressive-cms-install.service",
      backupDir: "/var/backups/progressive-cms",
      healthUrl: options.healthUrl,
      pool,
      lifecycle: oldLifecycle,
    });
    const finalDirectory = join(options.storeDir, "packages", staged.digest);
    const nextPackages = [
      ...oldPackages.filter((pkg) => pkg.manifest.id !== staged.manifest.id),
      { ...staged, directory: finalDirectory },
    ];
    const nextIndex = {
      schema: "pcms-active-extensions/1",
      state: "pending",
      packages: nextPackages
        .map((pkg) => ({ id: pkg.manifest.id, digest: pkg.digest }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
    const writeIndex = (value: unknown): void => {
      const temporary = join(options.storeDir, `.active-${intent.leaseId}.json`);
      writeFileSync(temporary, typeof value === "string" ? value : JSON.stringify(value), {
        mode: 0o644,
      });
      const fd = openSync(temporary, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, join(options.storeDir, "active.json"));
      const directoryFd = openSync(options.storeDir, "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    };
    const receiptsDirectory = join(options.storeDir, "receipts");
    mkdirSync(receiptsDirectory, { recursive: true, mode: 0o700 });
    const receipt: Record<string, unknown> = {
      request_id: intent.leaseId,
      product_id: intent.extensionId,
      core_release_id: identity.releaseId,
      from_version: installed?.version ?? null,
      to_version: intent.version,
      target_digest: staged.digest,
      rollback_policy: planned.target.rollback_policy,
      previous_generation: JSON.parse(oldIndex.toString("utf8")),
      phase: "PLANNED",
    };
    const saveReceipt = (phase: string): void => {
      receipt.phase = phase;
      receipt.updated_at = new Date().toISOString();
      const temporary = join(receiptsDirectory, `.${intent.leaseId}.json`);
      writeFileSync(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
      const fd = openSync(temporary, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, join(receiptsDirectory, `${intent.leaseId}.json`));
      const dir = openSync(receiptsDirectory, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    };
    const nextLifecycle = (useStaged = false) =>
      createExtensionLifecycleService({
        pool,
        clock: systemClock,
        coreVersion: identity.version,
        catalog: dataOnlyCatalog(
          options.currentRoot,
          useStaged
            ? [...oldPackages.filter((pkg) => pkg.manifest.id !== staged.manifest.id), staged]
            : nextPackages,
        ),
        systemCapabilities: capabilities,
      });
    const nextCheck = await nextLifecycle(true).installPreflight(
      intent.extensionId,
      installed?.config ?? {},
    );
    if (nextCheck.issues.some((issue) => issue.blocking))
      throw new Error(
        `target lifecycle preflight blocked: ${nextCheck.issues
          .filter((issue) => issue.blocking)
          .map((issue) => issue.code)
          .join(", ")}`,
      );
    saveReceipt("PLANNED");
    let quiesced = false;
    let promoted = false;
    const stop = async (): Promise<void> => {
      await exec("systemctl", [
        "stop",
        "progressive-cms-web.service",
        "progressive-cms-worker.service",
      ]);
    };
    const start = async (): Promise<void> => {
      await exec("systemctl", [
        "start",
        "progressive-cms-worker.service",
        "progressive-cms-web.service",
      ]);
    };
    let restartRequestedAt = new Date();
    const originalHeartbeat = await readWorkerHeartbeat(pool);
    const doctor = async (
      expectedPackages: readonly { id: string; digest: string }[],
    ): Promise<{ ok: boolean }> => {
      const fresh = await waitForWorkerRestartConfirmation(() => readWorkerHeartbeat(pool), {
        bootId: originalHeartbeat?.bootId,
        requestedAt: restartRequestedAt,
      });
      if (!fresh) return { ok: false };
      let ready = false;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          ready = (await fetch(options.healthUrl, { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
          /* boot may still be in progress */
        }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) return { ok: false };
      const loaded = await pool.query<{ key: string; value: string }>(
        "SELECT key, value FROM pcms_kernel_metadata WHERE key IN ('extension.delivery.loaded:web', 'extension.delivery.loaded:worker')",
      );
      const expected = independentGenerationDigest(expectedPackages);
      if (
        loaded.rows.length !== 2 ||
        loaded.rows.some((row) => {
          const value = JSON.parse(row.value) as {
            digest: string;
            core_version: string;
            loaded_at: string;
          };
          return (
            value.digest !== expected ||
            value.core_version !== identity.version ||
            new Date(value.loaded_at).getTime() < restartRequestedAt.getTime()
          );
        })
      )
        return { ok: false };
      await exec(process.execPath, [
        join(options.currentRoot, "packages/cli/src/bin/cms.js"),
        "doctor",
        "--json",
        "--config",
        options.configFile,
      ]);
      if (realpathSync(options.currentSymlink) !== beforeRoot)
        throw new Error("extension update changed the Core release identity");
      return { ok: true };
    };
    const orchestrator = createUpdateOrchestrator({
      pool,
      clock: systemClock,
      preflight: planned.preflight,
      target: planned.target,
      actor: intent.actor,
      reservedLeaseId: intent.leaseId,
      releaseLeaseOnFinish: false,
      ports: {
        backupGate: {
          warnings: () => common.backupGate.warnings?.() ?? [],
          confirm: async (plan) => {
            const before = new Set(readdirSync("/var/backups/progressive-cms"));
            await common.backupGate.confirm(plan);
            const created = readdirSync("/var/backups/progressive-cms")
              .filter((name) => /^2/.test(name) && !before.has(name))
              .sort();
            if (created.length !== 1)
              throw new Error("backup gate did not produce one fresh verified set");
            receipt.backup_set = join("/var/backups/progressive-cms", created[0] as string);
            saveReceipt("BACKUP_CONFIRMED");
          },
        },
        maintenance: {
          enter: async (plan) => {
            await common.maintenance?.enter(plan);
            quiesced = true;
            await stop();
            const fresh = await readPlan();
            if (
              fresh.planned.preflight.outcome === "BLOCKED" ||
              JSON.stringify(fresh.installed ?? null) !== JSON.stringify(installed ?? null) ||
              canonicalPackageJson(fresh.planned.preflight) !==
                canonicalPackageJson(planned.preflight)
            )
              throw new Error(
                "extension prerequisites changed during backup; retry from a fresh plan",
              );
            saveReceipt("QUIESCED");
          },
          exit: async (plan) => {
            await common.maintenance?.exit(plan);
          },
        },
        releaseDeployment: {
          deploy: async () => {
            if (!readFileSync(join(options.storeDir, "active.json")).equals(oldIndex))
              throw new Error("active extension generation changed concurrently");
            mkdirSync(join(options.storeDir, "packages"), { recursive: true, mode: 0o755 });
            if (existsSync(finalDirectory))
              throw new Error(
                "target package directory already exists; inspect the previous attempt",
              );
            renameSync(staged.directory, finalDirectory);
            chmodSync(finalDirectory, 0o755);
            writeIndex(nextIndex);
            promoted = true;
            saveReceipt("DEPLOYED_PENDING");
          },
        },
        migrations: {
          applyCore: async () => [],
          applyExtensionMigrations: async () => {
            saveReceipt("MIGRATING");
            const lifecycle = nextLifecycle();
            const initial =
              installed === undefined
                ? (
                    await lifecycle.install({ extensionId: intent.extensionId, config: {} })
                  ).appliedMigrations.map((name) => `${intent.extensionId}/${name}`)
                : [];
            const applied = await lifecycle.reconcileIdentity();
            return [
              ...initial,
              ...applied.flatMap((entry) =>
                entry.appliedMigrations.map((name) => `${entry.extensionId}/${name}`),
              ),
            ];
          },
        },
        serviceRestart: {
          restart: async () => {
            writeIndex({ ...nextIndex, state: "active" });
            restartRequestedAt = new Date();
            saveReceipt("RESTARTING");
            await start();
          },
        },
        postflightDoctor: { run: () => doctor(nextIndex.packages) },
      },
    });
    try {
      const result = await orchestrator.apply({ backupConfirmation: intent.version });
      saveReceipt("SUCCEEDED");
      return result;
    } catch (error) {
      if (quiesced) {
        await stop();
        if (!promoted || planned.target.rollback_policy === "rollback_safe") {
          writeIndex(oldIndex.toString("utf8"));
          await oldLifecycle.reconcileIdentity();
          restartRequestedAt = new Date();
          await start();
          if (
            (
              await doctor(
                (
                  JSON.parse(oldIndex.toString("utf8")) as {
                    packages: { id: string; digest: string }[];
                  }
                ).packages,
              )
            ).ok
          ) {
            await common.maintenance?.exit(planned.preflight);
            saveReceipt("ROLLED_BACK");
          }
        } else if (promoted) {
          writeIndex({ ...nextIndex, state: "restore_required" });
          saveReceipt("RESTORE_REQUIRED");
        }
      }
      throw error;
    } finally {
      await releaseUpdateLease(pool, intent.leaseId);
    }
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
}
