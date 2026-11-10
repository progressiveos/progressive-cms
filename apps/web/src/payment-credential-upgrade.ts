// Target-side payment credential upgrade (CORE-PAYMENTS-ADMIN-CONFIG-01
// review R1).
//
// The FIRST upgrade from an older release runs the update orchestrator inside
// the OLD process: its update-adapters know nothing about the encrypted
// payment credential store, so a hook added to the new adapters cannot fire.
// The supported boundary is therefore the new release itself: this step runs
// at boot, before the web process serves traffic, retires every legacy
// process-secret reference exactly once and leaves the connection ready.
//
// It never throws into the boot path. A blocked import keeps the site up, but
// the affected connections stay non-ready and money operations fail with a
// typed PAYMENT_CREDENTIALS_INCOMPLETE naming the import — never a silent read
// of deployment secrets.
import { recordSecurityEvent } from "@pcms/auth";
import type { DbPool, Logger } from "@pcms/core";
import { systemClock } from "@pcms/core";
import { createLegacyCredentialImport, type PaymentSecretBox } from "@pcms/payments";

/**
 * The ONE audited importer every automatic caller uses (boot and the update
 * orchestrator). Review R7 (second pass): the audit row is written with the
 * SAME transaction as the credential move, so a failing audit insert rolls the
 * import back instead of leaving an unaudited change that the next boot cannot
 * reconstruct. Keeping this in one factory is what makes "no caller can forget
 * the audit" true rather than a promise.
 */
export function createAuditedImporter(input: {
  readonly pool: DbPool;
  readonly box: PaymentSecretBox | undefined;
  readonly legacyResolver: (name: string) => string | undefined;
  readonly source: "boot" | "update";
}) {
  return createLegacyCredentialImport({
    pool: input.pool,
    clock: systemClock,
    box: () => input.box,
    legacyResolver: input.legacyResolver,
    audit: async (tx, info) => {
      await recordSecurityEvent(tx, null, {
        type: "PAYMENT_CREDENTIAL_IMPORTED",
        actorType: "SYSTEM",
        actorId: null,
        subjectType: "payment_provider_instance",
        subjectId: info.instanceId,
        transport: "cli",
        metadata: { slots: info.slots, retired: info.retired, source: input.source },
      });
    },
  });
}

export interface ConnectionReadiness {
  readonly ready: boolean;
  readonly code: string;
  readonly detail: string;
}

export async function applyPaymentCredentialUpgrade(input: {
  readonly pool: DbPool;
  readonly box: PaymentSecretBox | undefined;
  readonly legacyResolver: (name: string) => string | undefined;
  readonly logger: Logger;
  /**
   * Review R3 (second pass): the upgrade must also REPORT connections whose
   * stored endpoint the provider package does not trust. The import alone
   * cannot judge that, so the composition supplies the readiness projection.
   */
  readonly readinessOf?: (instanceId: string) => Promise<ConnectionReadiness>;
}): Promise<void> {
  try {
    const importer = createAuditedImporter({
      pool: input.pool,
      box: input.box,
      legacyResolver: input.legacyResolver,
      source: "boot",
    });
    const plan = await importer.preflight();
    if (plan.importable === 0 && plan.blocked === 0) return;
    if (plan.blocked > 0) {
      input.logger.error("payments.credentials.import_blocked", {
        operation: "web.boot",
        blocked: plan.blocked,
        // Connection names and slot/ref NAMES only — never values.
        instances: plan.instances
          .filter((entry) => entry.action === "blocked")
          .map((entry) => ({ id: entry.instance_id, name: entry.name, reason: entry.reason })),
      });
      return;
    }
    const result = await importer.run();
    input.logger.info("payments.credentials.imported", {
      operation: "web.boot",
      instances: result.imported_instances.length,
      stale_refs: result.stale_refs,
    });
    // Review R3 (second pass): importing credentials into a connection whose
    // endpoint is not trusted would make an old, previously ignored config
    // authoritative. Report it here — the runtime refuses those calls anyway,
    // but an operator must learn it from the boot log, not from failed money.
    if (input.readinessOf !== undefined) {
      for (const instanceId of result.imported_instances) {
        const readiness = await input.readinessOf(instanceId).catch(() => undefined);
        if (readiness === undefined || readiness.ready) continue;
        input.logger.warn("payments.connection.not_ready_after_import", {
          operation: "web.boot",
          instance_id: instanceId,
          code: readiness.code,
          detail: readiness.detail,
        });
      }
    }
  } catch (error) {
    input.logger.error("payments.credentials.import_failed", {
      operation: "web.boot",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
