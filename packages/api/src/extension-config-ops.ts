// Generic extension configuration operations (PCMS-PRE-RESEARCH A2).
// Media providers already expose Admin-managed config + write-only secret
// slots (media-provider-ops.ts); every extension with a config_schema gets
// the same contract here, so settings render from ONE declarative source —
// manifest schema → these operations → the Admin settings dialog. Secrets
// stay write-only: no response ever carries a secret value, ciphertext or
// masked fragment. `extensions.manage` gates these (provider credentials
// keep the stricter media.providers.manage).

import { recordSecurityEvent } from "@pcms/auth";
import {
  clearExtensionRuntimeSecret,
  listExtensionRuntimeSecretSlots,
  setExtensionRuntimeSecret,
  validateExtensionConfig,
} from "@pcms/extensions/internal";
import type { ApplicationServices, OperationContext } from "./context.js";
import {
  auditBase,
  type OperationContext as Context,
  omitSecretRefs,
  requirePermission,
} from "./context.js";
import { ApiError } from "./errors.js";

function requireArtifact(app: ApplicationServices, extensionId: string) {
  const artifact = app.extensions.catalog.get(extensionId);
  if (artifact === undefined) {
    throw new ApiError("EXTENSION_UNKNOWN", `no deployed extension "${extensionId}"`, {
      status: 404,
    });
  }
  return artifact;
}

export async function getExtensionConfigOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly extension_id: string },
) {
  requirePermission(app, ctx, "extensions.manage");
  const artifact = requireArtifact(app, input.extension_id);
  const stored = (await app.extensions.lifecycle.getInstallation(input.extension_id))?.config ?? {};
  return {
    extension_id: input.extension_id,
    installed: (await app.extensions.lifecycle.getInstallation(input.extension_id)) !== undefined,
    config_schema: artifact.manifest.config_schema ?? null,
    config: omitSecretRefs(stored),
    secret_slots: await listExtensionRuntimeSecretSlots(app.pool, input.extension_id),
  };
}

export async function updateExtensionConfigOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly extension_id: string; readonly config: Record<string, unknown> },
) {
  requirePermission(app, ctx, "extensions.manage");
  const artifact = requireArtifact(app, input.extension_id);
  const existing =
    (await app.extensions.lifecycle.getInstallation(input.extension_id))?.config ?? {};
  // Merge semantics (PCMS-WEB-RESEARCH §95 regression): a partial update —
  // e.g. changing only the network mode — must never erase sibling settings
  // (search engine, user id, fetch limits). Secret slots stay set-only via
  // the dedicated secrets op: any secret-slot key arriving here is dropped
  // and the stored $secret_ref survives untouched.
  const schemaProperties =
    (artifact.manifest.config_schema as { properties?: Record<string, unknown> } | undefined)
      ?.properties ?? {};
  const secretSlots = new Set(
    Object.entries(schemaProperties)
      .filter(([, slotSchema]) => (slotSchema as { format?: string }).format === "secret-ref")
      .map(([key]) => key),
  );
  const incoming = Object.fromEntries(
    Object.entries(input.config).filter(([key]) => !secretSlots.has(key)),
  );
  const merged = { ...existing, ...incoming };
  const check = validateExtensionConfig({
    extensionId: input.extension_id,
    schema: artifact.manifest.config_schema,
    config: merged,
  });
  if (!check.ok) {
    throw new ApiError(
      "EXTENSION_CONFIG_INVALID",
      "extension configuration failed schema validation",
      { status: 422, details: check.issues },
    );
  }
  await app.extensions.lifecycle.install({ extensionId: input.extension_id, config: merged });
  // Provider adapters capture their config at creation — drop cached
  // instances so the change is live without a restart.
  app.mediaProviders.invalidate(input.extension_id);
  await recordSecurityEvent(app.pool, null, {
    type: "EXTENSION_CONFIG_UPDATED",
    ...auditBase(ctx),
    subjectType: "extension",
    subjectId: input.extension_id,
    // Names only (mode/hosts/ports) — never values, never secrets.
    metadata: { keys: Object.keys(input.config) },
  });
  return {
    extension_id: input.extension_id,
    config: omitSecretRefs(
      (await app.extensions.lifecycle.getInstallation(input.extension_id))?.config ?? {},
    ),
  };
}

export async function setExtensionSecretOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly extension_id: string; readonly slot: string; readonly value: string },
) {
  requirePermission(app, ctx, "extensions.manage");
  if (app.runtimeSecretBox === undefined) {
    throw new ApiError(
      "EXTENSION_RUNTIME_SECRETS_NOT_CONFIGURED",
      "extension secrets require the runtime secrets encryption key in the deployment config",
      { status: 409 },
    );
  }
  const artifact = requireArtifact(app, input.extension_id);
  const existing =
    (await app.extensions.lifecycle.getInstallation(input.extension_id))?.config ?? {};
  // Fail closed unless the slot is a declared `format: "secret-ref"` slot.
  const candidate = { ...existing, [input.slot]: { $secret_ref: input.slot } };
  const check = validateExtensionConfig({
    extensionId: input.extension_id,
    schema: artifact.manifest.config_schema,
    config: candidate,
  });
  if (!check.ok) {
    throw new ApiError(
      "EXTENSION_CONFIG_INVALID",
      `"${input.slot}" is not a declared secret slot of extension "${input.extension_id}"`,
      { status: 422 },
    );
  }
  await setExtensionRuntimeSecret(app.pool, app.runtimeSecretBox, {
    extensionId: input.extension_id,
    slot: input.slot,
    value: input.value,
    actor: ctx.actor.id,
  });
  await app.extensions.lifecycle.install({ extensionId: input.extension_id, config: candidate });
  app.mediaProviders.invalidate(input.extension_id);
  await recordSecurityEvent(app.pool, null, {
    type: "EXTENSION_SECRET_SET",
    ...auditBase(ctx),
    subjectType: "extension",
    subjectId: input.extension_id,
    // The VALUE is never recorded — only which slot was set.
    metadata: { slot: input.slot },
  });
  return { extension_id: input.extension_id, configured: true };
}

export async function clearExtensionSecretOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly extension_id: string; readonly slot: string },
) {
  requirePermission(app, ctx, "extensions.manage");
  const artifact = requireArtifact(app, input.extension_id);
  const removed = await clearExtensionRuntimeSecret(app.pool, {
    extensionId: input.extension_id,
    slot: input.slot,
  });
  // PCMS-WEB-RESEARCH §143 generic fix: a stored config that still carries a
  // `$secret_ref` for a cleared slot can never resolve again — the runtime
  // resolver throws EXTENSION_SECRET_REF_UNRESOLVED and the whole extension
  // runtime degrades to null. Drop the dangling reference alongside the
  // secret value so "clear key" really means "this slot is not configured".
  const stored = (await app.extensions.lifecycle.getInstallation(input.extension_id))?.config ?? {};
  if (input.slot in stored) {
    const withoutSlot = { ...stored };
    delete withoutSlot[input.slot];
    const check = validateExtensionConfig({
      extensionId: input.extension_id,
      schema: artifact.manifest.config_schema,
      config: withoutSlot,
    });
    if (!check.ok) {
      throw new ApiError(
        "EXTENSION_CONFIG_INVALID",
        "extension configuration failed schema validation",
        {
          status: 422,
          details: check.issues,
        },
      );
    }
    await app.extensions.lifecycle.install({
      extensionId: input.extension_id,
      config: withoutSlot,
    });
    app.mediaProviders.invalidate(input.extension_id);
  }
  await recordSecurityEvent(app.pool, null, {
    type: "EXTENSION_SECRET_CLEARED",
    ...auditBase(ctx),
    subjectType: "extension",
    subjectId: input.extension_id,
    metadata: { slot: input.slot, existed: removed },
  });
  return { extension_id: input.extension_id, configured: false };
}
