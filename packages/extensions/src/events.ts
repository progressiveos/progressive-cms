// Extension event subscription contract (PCMS-EXT-T008, Extensions spec §7–§8).
//
// Events are facts (past tense, M07 outbox). Extensions subscribe through
// typed manifest descriptors; the consumer below fans ONE claimed outbox
// event out to every matching enabled-extension subscription. It is NOT a
// second claimer: core and M13 handlers run from the same claim in the
// worker composition, so an extension consumer can never steal an event.
//
// Idempotency: the consumption ledger row (event, extension, subscription)
// is claimed in the same transaction as an opted-in handler's writes.
// Legacy handlers retain the original claim/callback/release behavior.
import type { DbPool } from "@pcms/core";
import { ExtensionError } from "./errors.js";
import { createExtensionPlatformServices, type ExtensionTransactionContext } from "./platform.js";

export const EVENT_CONSUMPTIONS_TABLE = "pcms_extension_event_consumptions";

/** Structural view of an M07 outbox event (matches publication's shape). */
export interface ExtensionEventView {
  readonly id: string;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

/** Bounded, typed handler an extension registers for one event type. */
export type TransactionalExtensionEventHandler = (
  event: ExtensionEventView,
  tx: ExtensionTransactionContext,
) => Promise<void>;
export type ExtensionEventHandler = (event: ExtensionEventView) => Promise<void>;

interface ExtensionEventSubscriptionBase {
  readonly extensionId: string;
  readonly subscriptionId: string;
  readonly eventType: string;
}

export type ExtensionEventSubscriptionSpec = ExtensionEventSubscriptionBase &
  (
    | { readonly transactional: true; readonly handler: TransactionalExtensionEventHandler }
    | { readonly transactional?: false; readonly handler: ExtensionEventHandler }
  );

export interface ExtensionEventConsumer {
  /** Fans one event out to all matching subscriptions, idempotently. */
  handle(event: ExtensionEventView): Promise<void>;
  /** Deterministic view of the active subscriptions (discovery/doctor). */
  subscriptions(): readonly ExtensionEventSubscriptionSpec[];
  subscriptionsFor(eventType: string): readonly ExtensionEventSubscriptionSpec[];
}

export function createExtensionEventConsumer(options: {
  readonly pool: DbPool;
  readonly clock: { now(): Date };
  /** Core-owned writers, executed on the same client as the ledger claim. */
  readonly writers?: Pick<
    Parameters<typeof createExtensionPlatformServices>[0],
    "auditWriter" | "outboxAppender"
  >;
  /** Only subscriptions of ENABLED extensions are passed in here —
   * composition derives them from the lifecycle state. */
  readonly subscriptions: readonly ExtensionEventSubscriptionSpec[];
}): ExtensionEventConsumer {
  const sorted = [...options.subscriptions].sort(
    (a, b) =>
      a.eventType.localeCompare(b.eventType) ||
      a.extensionId.localeCompare(b.extensionId) ||
      a.subscriptionId.localeCompare(b.subscriptionId),
  );
  const byType = new Map<string, ExtensionEventSubscriptionSpec[]>();
  for (const subscription of sorted) {
    const list = byType.get(subscription.eventType) ?? [];
    list.push(subscription);
    byType.set(subscription.eventType, list);
  }
  const { pool } = options;

  return {
    subscriptions() {
      return sorted;
    },
    subscriptionsFor(eventType) {
      return byType.get(eventType) ?? [];
    },
    async handle(event) {
      const matching = byType.get(event.eventType) ?? [];
      for (const subscription of matching) {
        try {
          if (!subscription.transactional) {
            const claim = await pool.query(
              `INSERT INTO ${EVENT_CONSUMPTIONS_TABLE} (event_id, extension_id, subscription_id)
               VALUES ($1, $2, $3) ON CONFLICT (event_id, extension_id, subscription_id) DO NOTHING`,
              [event.id, subscription.extensionId, subscription.subscriptionId],
            );
            if (claim.rowCount === 0) continue;
            try {
              await subscription.handler(event);
            } catch (error) {
              await pool.query(
                `DELETE FROM ${EVENT_CONSUMPTIONS_TABLE} WHERE event_id = $1 AND extension_id = $2 AND subscription_id = $3`,
                [event.id, subscription.extensionId, subscription.subscriptionId],
              );
              throw error;
            }
            continue;
          }
          await pool.withTransaction(async (client) => {
            const claim = await client.query(
              `INSERT INTO ${EVENT_CONSUMPTIONS_TABLE} (event_id, extension_id, subscription_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (event_id, extension_id, subscription_id) DO NOTHING`,
              [event.id, subscription.extensionId, subscription.subscriptionId],
            );
            if (claim.rowCount === 0) return;
            const platform = createExtensionPlatformServices({
              pool: {
                query: (sql, params) => client.query(sql, params),
                withTransaction: (run) => run(client),
              },
              authorize: async () => {
                throw new Error("event handlers cannot authorize");
              },
              actor: { kind: "actor", id: "system", type: "system" },
              requestId: `outbox:${event.id}`,
              extensionId: subscription.extensionId,
              auditWriter:
                options.writers?.auditWriter ??
                (async () => {
                  throw new Error("event audit writer unavailable");
                }),
              outboxAppender:
                options.writers?.outboxAppender ??
                (async () => {
                  throw new Error("event outbox writer unavailable");
                }),
            });
            await platform.transaction((tx) => subscription.handler(event, tx));
          });
        } catch (error) {
          throw new ExtensionError(
            "EXTENSION_EVENT_CONSUMPTION_INVALID",
            `extension "${subscription.extensionId}" subscription "${subscription.subscriptionId}" failed to consume event "${event.id}": ${error instanceof Error ? error.message : String(error)}`,
            {
              details: { event_id: event.id, extension_id: subscription.extensionId },
              cause: error,
            },
          );
        }
      }
    },
  };
}

/**
 * Worker-composition helper: merges handler families (search, M13 dispatcher,
 * extension consumer) WITHOUT overwriting each other — one claimed event is
 * offered to every family in deterministic order. This is the anti-theft
 * guarantee at the composition level: extension handlers are appended, never
 * substituted for existing ones.
 */
export function mergeOutboxHandlers(
  families: readonly Record<string, (event: ExtensionEventView) => Promise<void>>[],
): Record<string, (event: ExtensionEventView) => Promise<void>> {
  const byType = new Map<string, ((event: ExtensionEventView) => Promise<void>)[]>();
  for (const family of families) {
    for (const [eventType, handler] of Object.entries(family)) {
      const list = byType.get(eventType) ?? [];
      list.push(handler);
      byType.set(eventType, list);
    }
  }
  const merged: Record<string, (event: ExtensionEventView) => Promise<void>> = {};
  for (const [eventType, handlers] of byType) {
    merged[eventType] = async (event) => {
      for (const handler of handlers) await handler(event);
    };
  }
  return merged;
}
