// Extension Jobs composition (PREPUBLIC §4): the worker-side half of the
// extension job contract. Handlers resolve from EVERY deployed artifact (R3
// pattern — enabling later cannot introduce an unknown queue type); the
// shared M07 queue owns durability, leases, retries and dead letters.
//
// Lifecycle semantics (contract, PREPUBLIC §4, owner review 2026-10-12):
// - DISABLED ⇒ jobs PARK: back to PENDING without burning an attempt, the
//   handler was not in a position to run. Queued work survives a temporary
//   disable and CONTINUES after re-enable (a parked job sits in the queue
//   with last_error=EXTENSION_DISABLED; operators cancel it explicitly when
//   the disable is meant to be permanent).
// - UNINSTALLED ⇒ the artifact left the composition, the queue type has no
//   handler at all → the shared queue dead-letters it (no handler registered)
//   — permanent by nature, the code that could run it no longer exists.
// - PAYLOAD VERSION policy is enforced BEFORE invocation: a job stamped with
//   a version the deployed handler no longer accepts dead-letters
//   immediately with EXTENSION_JOB_PAYLOAD_VERSION_UNSUPPORTED. Recovery is
//   an explicit operator action: declare older generations in the updated
//   manifest's accepts_payload_versions (then jobs.retryDeadLetter), or
//   drop the dead letter. Permanent refusal and temporary unavailability
//   are different states and never conflated.
import type { DbPool } from "@pcms/core";
import { type DeployedExtensionArtifact, resolveHandler } from "@pcms/extensions/internal";
import type { JobHandler } from "@pcms/jobs";
import { buildExtensionSourceContext } from "./extension-platform.js";

export interface ExtensionJobHandlerDeps {
  readonly pool: DbPool;
  /** Structural catalog subset (composition may pass a lazy proxy). */
  readonly catalog: {
    get(extensionId: string):
      | {
          readonly manifest: {
            readonly id: string;
            readonly registrations: {
              readonly jobs: readonly {
                readonly job_id: string;
                readonly handler: string;
                readonly payload_version: number;
                readonly accepts_payload_versions?: readonly number[];
              }[];
            };
          };
        }
      | undefined;
    list(): readonly {
      readonly manifest: {
        readonly id: string;
        readonly registrations: {
          readonly jobs: readonly {
            readonly job_id: string;
            readonly handler: string;
            readonly payload_version: number;
            readonly accepts_payload_versions?: readonly number[];
          }[];
        };
      };
    }[];
  };
  readonly enabledIds: () => Promise<readonly string[]>;
  readonly site: { readonly key: string; readonly defaultLocale: string };
}

export function createExtensionJobHandlers(
  deps: ExtensionJobHandlerDeps,
): Record<string, JobHandler> {
  const handlers: Record<string, JobHandler> = {};
  for (const artifact of deps.catalog.list()) {
    for (const job of artifact.manifest.registrations.jobs) {
      const queueType = `${artifact.manifest.id}/${job.job_id}`;
      handlers[queueType] = async (payload, context) => {
        const enabled = await deps.enabledIds();
        if (!enabled.includes(artifact.manifest.id)) {
          // Temporary unavailability: park, do not burn attempts.
          return {
            outcome: "parked",
            delayMilliseconds: 60_000,
            reason: `EXTENSION_DISABLED: "${artifact.manifest.id}" is disabled — job parked until re-enable`,
          };
        }
        const stamped = context.job.payloadVersion;
        const accepted = [job.payload_version, ...(job.accepts_payload_versions ?? [])];
        if (stamped !== null && !accepted.includes(stamped)) {
          return {
            outcome: "permanent",
            error: new Error(
              `EXTENSION_JOB_PAYLOAD_VERSION_UNSUPPORTED: job stamped v${stamped}; handler "${job.handler}" of "${queueType}" accepts [${accepted.join(", ")}]`,
            ),
          };
        }
        const handler = resolveHandler(artifact as DeployedExtensionArtifact, job.handler) as (
          ctx: unknown,
          payload: unknown,
          job: unknown,
        ) => Promise<unknown>;
        const ctx = buildExtensionSourceContext({
          pool: deps.pool,
          site: deps.site,
          extensionId: artifact.manifest.id,
          config: null,
        });
        await handler(ctx, payload, {
          id: context.job.id,
          attempts: context.attempt,
          maxAttempts: context.job.maxAttempts,
          payloadVersion: stamped,
        });
      };
    }
  }
  return handlers;
}
