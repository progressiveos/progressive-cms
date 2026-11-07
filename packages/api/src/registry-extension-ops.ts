import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertExtensionStorePath,
  type ExtensionPackageTrust,
  extensionFileSha256,
  planIndependentExtensionUpdate,
  readExtensionPackageArchive,
  releaseUpdateLease,
  reserveUpdateLease,
  stageIndependentExtensionPackage,
  verifyExtensionPackageDescriptor,
} from "@pcms/extensions/internal";
import { type ApplicationServices, type OperationContext, requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

export interface RegistryExtensionDeployment {
  readonly storeDir: string;
  readonly trustFile: string;
  readonly releaseId: string;
  readonly allowDev: boolean;
  readonly ownerUid: number;
  /** Existing privileged install unit; never a caller-selected executable. */
  schedule(): Promise<void>;
}

async function bound(app: ApplicationServices, ctx: OperationContext): Promise<void> {
  requirePermission(app, ctx, "extensions.manage");
  if (!(await app.registryInstanceCode.read()) || !(await app.registryInstanceToken.read()))
    throw new ApiError(
      "REGISTRY_INSTANCE_BINDING_REQUIRED",
      "bind the instance before managed updates; public Registry downloads do not require binding",
      { status: 409 },
    );
}

type PackageRequest = {
  readonly productId: string;
  readonly version: string;
  readonly approvedPermissions?: readonly string[];
};

async function planPackage(
  app: ApplicationServices,
  ctx: OperationContext,
  input: PackageRequest,
  descriptor: unknown,
) {
  requirePermission(app, ctx, "extensions.manage");
  const deployment = app.registryExtensionDeployment;
  if (!deployment)
    throw new ApiError(
      "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE",
      "trusted independent extension delivery is not configured",
      { status: 409 },
    );
  assertExtensionStorePath(deployment.trustFile, deployment.trustFile, deployment.ownerUid);
  const trust = JSON.parse(readFileSync(deployment.trustFile, "utf8")) as ExtensionPackageTrust;
  const coreVersion = String(app.extensions.contractVersions.get("cms")?.version ?? "0.0.0");
  const target = verifyExtensionPackageDescriptor({
    descriptor,
    trust,
    coreVersion,
    allowDev: deployment.allowDev,
  });
  if (target.manifest.id !== input.productId || target.manifest.version !== input.version)
    throw new ApiError(
      "REGISTRY_CHECKSUM_MISMATCH",
      "Registry package identity disagrees with signed metadata",
      { status: 422 },
    );
  const installed = await app.extensions.lifecycle.getInstallation(input.productId);
  const currentArtifact = app.extensions.catalog.get(input.productId);
  if (currentArtifact && !currentArtifact.independentPackage)
    throw new ApiError(
      "EXTENSION_STATIC_COMPOSITION_CONFLICT",
      "this extension is compiled into Core; use a CMS-only Core with independent delivery configured before adopting a standalone package",
      { status: 409 },
    );
  const enabledIds = await app.extensions.lifecycle.enabledIds();
  const applied = await app.pool.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM pcms_extension_migrations WHERE extension_id = $1 ORDER BY name",
    [input.productId],
  );
  const jobs = await app.pool.query<{ type: string; payload_version: number | null }>(
    "SELECT DISTINCT type, payload_version FROM jobs WHERE starts_with(type, $1) AND state IN ('PENDING', 'RUNNING', 'FAILED')",
    [`${input.productId}/`],
  );
  const planned = planIndependentExtensionUpdate({
    target,
    currentVersion: installed?.version ?? null,
    currentDigest: installed?.artifactDigest ?? null,
    currentPermissions: app.extensions.catalog.get(input.productId)?.manifest.permissions ?? [],
    currentConfig: installed?.config ?? {},
    currentEnabled: installed?.state === "ENABLED",
    currentJobs: currentArtifact?.manifest.registrations.jobs ?? [],
    enabledExtensions: enabledIds.map((id) => ({
      id,
      requires: app.extensions.catalog.get(id)?.manifest.requires ?? [],
    })),
    approvedPermissions: input.approvedPermissions ?? [],
    capabilities: await app.extensions.capabilities(),
    appliedMigrations: applied.rows,
    queuedJobs: jobs.rows.map((job) => ({
      jobId: job.type.slice(input.productId.length + 1),
      payloadVersion: job.payload_version ?? 1,
    })),
    coreVersion,
  });
  return { ...planned, packageIdentity: target, coreVersion, trust };
}

export async function registryExtensionPlan(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly productId: string;
    readonly version: string;
    readonly approvedPermissions?: readonly string[];
  },
) {
  await bound(app, ctx);
  const deployment = app.registryExtensionDeployment;
  if (!deployment || !app.registryClient)
    throw new ApiError(
      "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE",
      "trusted independent extension delivery is not configured",
      { status: 409 },
    );
  const card = await app.registryClient.packageCard(input.productId);
  const releases = (Array.isArray(card.versions) ? card.versions : []) as readonly {
    version: string;
    artifact: string;
    sha256: string;
    package_descriptor: unknown;
    state: string;
  }[];
  const release = releases.find((candidate) => candidate.version === input.version);
  if (
    card.id !== input.productId ||
    card.kind !== "extension" ||
    !release ||
    release.state !== "published" ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    typeof release.artifact !== "string" ||
    !release.package_descriptor
  )
    throw new ApiError(
      "REGISTRY_EXTENSION_METADATA_UNAVAILABLE",
      "Registry must supply versioned compiled-package metadata and signed provenance",
      { status: 409 },
    );
  return { ...(await planPackage(app, ctx, input, release.package_descriptor)), release };
}

export async function registryExtensionApply(
  app: ApplicationServices,
  ctx: OperationContext,
  input: PackageRequest,
): Promise<Record<string, unknown>> {
  const plan = await registryExtensionPlan(app, ctx, input);
  const registry = app.registryClient;
  if (!registry)
    throw new ApiError("REGISTRY_NOT_CONFIGURED", "Registry is not configured", { status: 409 });
  return stageAndSchedule(
    app,
    ctx,
    input,
    plan,
    () =>
      registry.downloadExtensionPackage
        ? registry.downloadExtensionPackage(plan.release.artifact)
        : registry.download(plan.release.artifact),
    plan.release.sha256,
  );
}

export async function uploadIndependentExtensionPackage(
  app: ApplicationServices,
  ctx: OperationContext,
  input: PackageRequest & { readonly bytes: Buffer; readonly preview?: boolean },
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "extensions.manage");
  const files = await readExtensionPackageArchive(input.bytes);
  const descriptor = JSON.parse(files.get("extension-package.json")?.toString("utf8") ?? "null");
  const plan = await planPackage(app, ctx, input, descriptor);
  if (input.preview) {
    const deployment = app.registryExtensionDeployment;
    if (!deployment) throw new Error("extension delivery is unavailable");
    const staged = await stageIndependentExtensionPackage({
      bytes: input.bytes,
      stagingDir: join(app.registryIncomingDir, "extension-preflight"),
      trust: plan.trust,
      coreVersion: plan.coreVersion,
      allowDev: deployment.allowDev,
    });
    const { rmSync } = await import("node:fs");
    rmSync(staged.directory, { recursive: true, force: true });
    return {
      ...plan.preflight,
      no_op: plan.noOp,
      new_permissions: plan.newPermissions,
      product_id: input.productId,
    };
  }
  return stageAndSchedule(
    app,
    ctx,
    input,
    plan,
    async () => input.bytes,
    extensionFileSha256(input.bytes),
  );
}

async function stageAndSchedule(
  app: ApplicationServices,
  ctx: OperationContext,
  input: PackageRequest,
  plan: Awaited<ReturnType<typeof planPackage>>,
  download: () => Promise<Buffer>,
  sha256: string,
): Promise<Record<string, unknown>> {
  if (plan.preflight.outcome === "BLOCKED")
    throw new ApiError(
      "UPDATE_COMPATIBILITY_BLOCKED",
      "extension update requires compatibility and explicit privilege approvals",
      { status: 409, details: plan.preflight.issues },
    );
  if (plan.noOp)
    return {
      update: { status: "NO_OP", product_id: input.productId, to_version: input.version },
      core_version: plan.coreVersion,
    };
  const deployment = app.registryExtensionDeployment;
  if (!deployment)
    throw new ApiError(
      "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE",
      "independent extension adapter unavailable",
      { status: 409 },
    );
  const leaseId = await reserveUpdateLease(app.pool, input.productId);
  const artifact = `extension-${input.productId}-${input.version}-${leaseId}.zip`;
  const intentPath = join(app.registryIncomingDir, "extension-update.json");
  let staged: Awaited<ReturnType<typeof stageIndependentExtensionPackage>> | undefined;
  try {
    const bytes = await download();
    if (extensionFileSha256(bytes) !== sha256)
      throw new ApiError("REGISTRY_CHECKSUM_MISMATCH", "extension archive checksum mismatch", {
        status: 422,
      });
    staged = await stageIndependentExtensionPackage({
      bytes,
      stagingDir: join(app.registryIncomingDir, "extension-preflight"),
      trust: plan.trust,
      coreVersion: plan.coreVersion,
      allowDev: deployment.allowDev,
    });
    if (staged.digest !== plan.packageIdentity.digest)
      throw new ApiError(
        "REGISTRY_CHECKSUM_MISMATCH",
        "downloaded package differs from the approved signed plan",
        { status: 422 },
      );
    writeFileSync(join(app.registryIncomingDir, artifact), bytes, { flag: "wx", mode: 0o600 });
    writeFileSync(
      intentPath,
      JSON.stringify({
        schema: "pcms-extension-update-intent/1",
        leaseId,
        extensionId: input.productId,
        version: input.version,
        artifact,
        sha256,
        packageDigest: staged.digest,
        coreReleaseId: deployment.releaseId,
        coreVersion: plan.coreVersion,
        approvedPermissions: input.approvedPermissions ?? [],
        actor: {
          type: ctx.actor.type,
          ...(ctx.actor.id === undefined ? {} : { id: ctx.actor.id }),
        },
      }),
      { flag: "wx", mode: 0o600 },
    );
    await deployment.schedule();
    return {
      update: {
        status: "RUNNING",
        request_id: leaseId,
        product_id: input.productId,
        to_version: input.version,
      },
      core_version: plan.coreVersion,
    };
  } catch (error) {
    try {
      const pending = JSON.parse(readFileSync(intentPath, "utf8"));
      if (pending.leaseId === leaseId) unlinkSync(intentPath);
    } catch {
      /* no owned intent */
    }
    try {
      unlinkSync(join(app.registryIncomingDir, artifact));
    } catch {
      /* no owned archive */
    }
    await releaseUpdateLease(app.pool, leaseId);
    throw error;
  } finally {
    if (staged) {
      const { rmSync } = await import("node:fs");
      rmSync(staged.directory, { recursive: true, force: true });
    }
  }
}
