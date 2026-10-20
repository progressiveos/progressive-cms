// Media provider configuration + test operations (PCMS-MPA-T007; ADR-0013
// §7, Media spec §71.8). Credentials are Admin-managed: values are
// write-only through the extension runtime secret store, the stored config
// keeps only `$secret_ref` slots for secrets, and NO response ever carries a
// secret value, ciphertext, internal slot mapping or masked fragment.
// `media.providers.manage` (NOT `extensions.manage`) gates configuration —
// provider credentials are a media-admin capability and never an agent
// default.

import { recordSecurityEvent } from "@pcms/auth";
import {
  clearExtensionRuntimeSecret,
  listExtensionRuntimeSecretSlots,
  setExtensionRuntimeSecret,
  validateExtensionConfig,
} from "@pcms/extensions/internal";
import { type GenerationProviderCapabilities, ProviderError } from "@pcms/media";
import type { ApplicationServices, OperationContext } from "./context.js";
import {
  auditBase,
  type OperationContext as Context,
  omitSecretRefs,
  pickSecretRefs,
  requirePermission,
} from "./context.js";
import { ApiError } from "./errors.js";

export async function listMediaProvidersOp(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "media.read");
  return { items: await app.mediaProviders.list() };
}

export async function getMediaProviderOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly provider_id: string },
) {
  requirePermission(app, ctx, "media.read");
  const summary = await app.mediaProviders.get(input.provider_id);
  if (summary === null) {
    throw new ApiError("MEDIA_PROVIDER_UNKNOWN", `no media provider "${input.provider_id}"`, {
      status: 404,
    });
  }
  const artifact = app.extensions.catalog.get(summary.extension_id);
  const configSchema = artifact?.manifest.config_schema ?? null;
  const storedConfig =
    (await app.extensions.lifecycle.getInstallation(summary.extension_id))?.config ?? {};
  // Non-secret values only — secret-ref slots are reduced to presence.
  const publicConfig = omitSecretRefs(storedConfig);
  return {
    provider: summary,
    config_schema: configSchema,
    config: publicConfig,
    secret_slots: await listExtensionRuntimeSecretSlots(app.pool, summary.extension_id),
  };
}

/**
 * Read-side of the provider settings contract (PCMS-ADMIN fix): GET
 * /media/providers/:id/config — the dialog-facing shape (schema + public
 * config + secret-slot presence). The RUNBOOK documented this GET since the
 * network-section feature, but the route was never registered, so provider
 * settings dialogs spun on a 404.
 */
export async function getMediaProviderConfigOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly provider_id: string },
) {
  requirePermission(app, ctx, "media.providers.manage");
  const summary = await requireSummary(app, input.provider_id);
  const artifact = requireArtifact(app, summary.extension_id);
  const storedConfig =
    (await app.extensions.lifecycle.getInstallation(summary.extension_id))?.config ?? {};
  const publicConfig = omitSecretRefs(storedConfig);
  return {
    extension_id: summary.extension_id,
    config_schema: artifact.manifest.config_schema ?? null,
    config: publicConfig,
    secret_slots: await listExtensionRuntimeSecretSlots(app.pool, summary.extension_id),
  };
}

export async function updateMediaProviderConfigOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly provider_id: string; readonly config: Record<string, unknown> },
) {
  requirePermission(app, ctx, "media.providers.manage");
  const summary = await requireSummary(app, input.provider_id);
  const artifact = requireArtifact(app, summary.extension_id);
  const existing =
    (await app.extensions.lifecycle.getInstallation(summary.extension_id))?.config ?? {};
  // Keep existing secret references; the caller may only set non-secret keys.
  const merged = { ...pickSecretRefs(existing), ...input.config };
  const check = validateExtensionConfig({
    extensionId: summary.extension_id,
    schema: artifact.manifest.config_schema,
    config: merged,
  });
  if (!check.ok) {
    throw new ApiError(
      "EXTENSION_CONFIG_INVALID",
      "provider configuration failed schema validation",
      {
        status: 422,
        details: check.issues,
      },
    );
  }
  await app.extensions.lifecycle.install({
    extensionId: summary.extension_id,
    config: merged,
  });
  // The live adapter captured the previous config snapshot — without this,
  // a newly configured model/key stays invisible until a restart.
  app.mediaProviders.invalidate(summary.extension_id);
  await recordSecurityEvent(app.pool, null, {
    type: "EXTENSION_PROVIDER_CONFIG_UPDATED",
    ...auditBase(ctx),
    subjectType: "extension",
    subjectId: summary.extension_id,
    // Names only (mode/hosts/ports) — never values, never secrets.
    metadata: { provider_id: input.provider_id, keys: Object.keys(input.config) },
  });
  return { provider_id: input.provider_id, config: await safeConfig(app, summary.extension_id) };
}

export async function setMediaProviderSecretOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly provider_id: string; readonly slot: string; readonly value: string },
) {
  requirePermission(app, ctx, "media.providers.manage");
  if (app.runtimeSecretBox === undefined) {
    throw new ApiError(
      "EXTENSION_RUNTIME_SECRETS_NOT_CONFIGURED",
      "provider credentials require the runtime secrets encryption key in the deployment config",
      { status: 409 },
    );
  }
  const summary = await requireSummary(app, input.provider_id);
  const artifact = requireArtifact(app, summary.extension_id);
  const existing =
    (await app.extensions.lifecycle.getInstallation(summary.extension_id))?.config ?? {};
  // Fail closed unless the slot is a declared `format: "secret-ref"` slot.
  const candidate = { ...existing, [input.slot]: { $secret_ref: input.slot } };
  const check = validateExtensionConfig({
    extensionId: summary.extension_id,
    schema: artifact.manifest.config_schema,
    config: candidate,
  });
  if (!check.ok) {
    throw new ApiError(
      "EXTENSION_CONFIG_INVALID",
      `"${input.slot}" is not a declared secret slot of provider "${input.provider_id}"`,
      { status: 422 },
    );
  }
  await setExtensionRuntimeSecret(app.pool, app.runtimeSecretBox, {
    extensionId: summary.extension_id,
    slot: input.slot,
    value: input.value,
    actor: ctx.actor.id,
  });
  await app.extensions.lifecycle.install({
    extensionId: summary.extension_id,
    config: candidate,
  });
  app.mediaProviders.invalidate(summary.extension_id);
  await recordSecurityEvent(app.pool, null, {
    type: "EXTENSION_PROVIDER_SECRET_SET",
    ...auditBase(ctx),
    subjectType: "extension",
    subjectId: summary.extension_id,
    // The VALUE is never recorded — only which slot was set.
    metadata: { provider_id: input.provider_id, slot: input.slot },
  });
  return { provider_id: input.provider_id, configured: true };
}

export async function clearMediaProviderSecretOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly provider_id: string; readonly slot: string },
) {
  requirePermission(app, ctx, "media.providers.manage");
  const summary = await requireSummary(app, input.provider_id);
  const removed = await clearExtensionRuntimeSecret(app.pool, {
    extensionId: summary.extension_id,
    slot: input.slot,
  });
  app.mediaProviders.invalidate(summary.extension_id);
  await recordSecurityEvent(app.pool, null, {
    type: "EXTENSION_PROVIDER_SECRET_CLEARED",
    ...auditBase(ctx),
    subjectType: "extension",
    subjectId: summary.extension_id,
    metadata: { provider_id: input.provider_id, slot: input.slot },
  });
  return { provider_id: input.provider_id, removed };
}

export async function testMediaProviderOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly provider_id: string },
) {
  requirePermission(app, ctx, "media.providers.manage");
  const summary = await app.mediaProviders.get(input.provider_id);
  if (summary === null) {
    throw new ApiError("MEDIA_PROVIDER_UNKNOWN", `no media provider "${input.provider_id}"`, {
      status: 404,
    });
  }
  const provider =
    summary.kind === "stock"
      ? await app.mediaProviders.stock(input.provider_id)
      : await app.mediaProviders.generation(input.provider_id);
  if (provider === null) {
    return {
      ok: false,
      code: "PROVIDER_NOT_CONFIGURED",
      message: "provider credentials are not configured",
    };
  }
  try {
    const health = await provider.testConnection({ requestId: ctx.requestId });
    return { ok: health.ok, ...(health.message === null ? {} : { message: health.message }) };
  } catch (error) {
    if (error instanceof ProviderError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, code: "PROVIDER_UNAVAILABLE", message: "provider test failed" };
  }
}

async function requireSummary(app: ApplicationServices, providerId: string) {
  const summary = await app.mediaProviders.get(providerId);
  if (summary === null) {
    throw new ApiError("MEDIA_PROVIDER_UNKNOWN", `no media provider "${providerId}"`, {
      status: 404,
    });
  }
  return summary;
}

function requireArtifact(app: ApplicationServices, extensionId: string) {
  const artifact = app.extensions.catalog.get(extensionId);
  if (artifact === undefined) {
    throw new ApiError("EXTENSION_NOT_DEPLOYED", `extension "${extensionId}" is not deployed`, {
      status: 404,
    });
  }
  return artifact;
}

async function safeConfig(
  app: ApplicationServices,
  extensionId: string,
): Promise<Record<string, unknown>> {
  const stored = (await app.extensions.lifecycle.getInstallation(extensionId))?.config ?? {};
  return omitSecretRefs(stored);
}
