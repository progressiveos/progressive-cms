// Payment application service (PCMS-PAY-T004..T007; Payments spec
// §28–§37). Canonical callback pipeline (spec §34): verify (provider
// adapter) → persist/dedupe (InboundEvent, composition layer) → normalize
// → lock Payment → validate transition → PaymentEvent append → Outbox →
// commit. Duplicate provider callbacks never re-apply business state:
// transitions are guarded by the state machine and no-op replays return
// the unchanged payment. Provider network calls NEVER run inside a DB
// transaction.
import { type Clock, type DbClient, type DbPool, newStableId, type StableId } from "@pcms/core";
import { assertTrustedEndpoints } from "./endpoint-policy.js";
import { PaymentError } from "./errors.js";
import { amountLt, isSupportedCurrency, toMinorUnits } from "./money.js";
import {
  type PaymentProviderInstanceService,
  type ProviderInstanceRow,
  rowToInstance,
} from "./provider-instances.js";
import { validateAgainstSchema } from "./schema.js";
import {
  configureProvider,
  type NormalizedProviderOutcome,
  type ParsedCallback,
  type PaymentProvider,
  type PaymentProviderRegistry,
  type PaymentSecrets,
} from "./providers.js";
import { loadInstanceCredentialSnapshot, resolveRequiredCredentials } from "./readiness.js";
import type { PaymentSecretBox } from "./runtime-secrets.js";
import {
  assertTransition,
  canTransition,
  isAllowedSubjectType,
  type PaymentEventType,
  type PaymentStatus,
  statusChangeEvent,
} from "./state.js";

export interface Payment {
  readonly id: StableId;
  readonly providerInstanceId: string;
  readonly externalPaymentId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly description: string | null;
  readonly idempotencyKey: string;
  readonly metadata: Record<string, unknown>;
  /** Provider-hosted payment form for the payer, when the provider returned one. */
  readonly paymentUrl: string | null;
  /** First external create attempt, if one was ever started (durable). */
  readonly providerAttemptAt: Date | null;
  /**
   * What the stored row can PROVE about an external attempt:
   * - "attempted": a durable attempt marker or a held claim token;
   * - "never_attempted": a fresh intent, positively not submitted yet;
   * - "unknown_legacy": neither trace — the shape an older release left after
   *   releasing the claim of a request whose answer was lost (B4).
   */
  readonly providerAttemptState: "attempted" | "never_attempted" | "unknown_legacy";
  readonly refundedAmount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly paidAt: Date | null;
  readonly cancelledAt: Date | null;
}

export interface PaymentEvent {
  readonly id: StableId;
  readonly paymentId: string;
  readonly eventType: PaymentEventType;
  readonly actorType: string | null;
  readonly actorId: string | null;
  readonly source: "operator" | "provider" | "system";
  readonly providerEventId: string | null;
  readonly inboundEventId: string | null;
  readonly payload: unknown;
  readonly createdAt: Date;
}

export interface PaymentActor {
  readonly type: string;
  readonly id: string;
}

interface PaymentRow {
  [column: string]: unknown;
  id: string;
  provider_instance_id: string;
  external_payment_id: string | null;
  subject_type: string;
  subject_id: string;
  amount: string;
  currency: string;
  status: PaymentStatus;
  description: string | null;
  idempotency_key: string;
  metadata: unknown;
  payment_url: string | null;
  refunded_amount: string;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
  cancelled_at: Date | null;
}

interface EventRow {
  [column: string]: unknown;
  id: string;
  payment_id: string;
  event_type: PaymentEventType;
  actor_type: string | null;
  actor_id: string | null;
  source: "operator" | "provider" | "system";
  provider_event_id: string | null;
  inbound_event_id: string | null;
  payload: unknown;
  created_at: Date;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Metadata marker written BEFORE the provider create call. Its presence means
 * "an external attempt happened (outcome possibly unknown)" — the settings
 * guard uses it to tell a never-submitted payment from an unknown one.
 */
export const CREATE_CLAIM_KEY = "__pcms_provider_create_submitted";
/**
 * Durable record of the FIRST external create attempt (ISO timestamp). The
 * claim above is a lease and is released on a retryable failure, but a released
 * claim is NOT proof that nothing was sent: a lost response looks exactly like
 * that. This marker is written with the claim and never removed, so
 * "was the provider ever contacted" and "how old is that unknown attempt" stay
 * answerable after the lease is gone (review M1 / Y6).
 */
export const PROVIDER_ATTEMPT_KEY = "__pcms_provider_first_attempt_at";

function rowToPayment(row: PaymentRow): Payment {
  const metadata = { ...((row.metadata ?? {}) as Record<string, unknown>) };
  delete metadata[CREATE_CLAIM_KEY];
  delete metadata[PROVIDER_ATTEMPT_KEY];
  return {
    id: row.id as StableId,
    providerInstanceId: row.provider_instance_id,
    externalPaymentId: row.external_payment_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    description: row.description,
    idempotencyKey: row.idempotency_key,
    metadata,
    paymentUrl: row.payment_url ?? null,
    providerAttemptAt: (() => {
      const raw = (row.metadata as Record<string, unknown> | null)?.[PROVIDER_ATTEMPT_KEY];
      if (typeof raw !== "string") return null;
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })(),
    providerAttemptState: (() => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      if (typeof meta[PROVIDER_ATTEMPT_KEY] === "string") return "attempted" as const;
      const claim = meta[CREATE_CLAIM_KEY];
      if (typeof claim === "object" && claim !== null) {
        const record = claim as Record<string, unknown>;
        if (typeof record["token"] === "string") return "attempted" as const;
        if (record["ready"] === true) return "never_attempted" as const;
      }
      return "unknown_legacy" as const;
    })(),
    refundedAmount: Number(row.refunded_amount),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    cancelledAt: row.cancelled_at,
  };
}

function rowToEvent(row: EventRow): PaymentEvent {
  return {
    id: row.id as StableId,
    paymentId: row.payment_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    source: row.source,
    providerEventId: row.provider_event_id,
    inboundEventId: row.inbound_event_id,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

const MAX_METADATA_JSON = 4096;
/**
 * How many times the executor may ASK the provider about a refund whose
 * outcome is not final yet, before escalating to a human. One confirmation per
 * worker sweep (~60s), so this is about an hour — long enough for an
 * asynchronous bank refund, short enough to surface a stuck one (F1).
 */
const MAX_REFUND_CONFIRMATIONS = 60;

export function createPaymentService(deps: {
  pool: DbPool;
  clock: Clock;
  providers: PaymentProviderRegistry;
  instances: PaymentProviderInstanceService;
  /** Deployment master key (integrations.runtimeSecretsEncryptionKeySecret-
   * Ref); undefined when the deployment has none — then stored credentials
   * are reported missing/unreadable instead of guessed. */
  secretBox?: () => PaymentSecretBox | undefined;
}) {
  const { pool, clock, providers, instances, secretBox } = deps;

  /**
   * The ONE resolution path for every money/inbound operation.
   *
   * Review R5: the connection row and its encrypted slots must come from ONE
   * snapshot — otherwise a concurrent save could hand the old adapter config
   * to the new credentials. The read runs in a short REPEATABLE READ
   * transaction (no lock is held over the provider HTTP call), so both
   * statements observe the same committed state; the adapter, the decryption
   * and the call then belong to that snapshot.
   */
  async function wiringFor(instance: PaymentProviderInstanceLike): Promise<{
    readonly provider: PaymentProvider;
    readonly instance: PaymentProviderInstanceLike;
    readonly secrets: PaymentSecrets;
  }> {
    const registered = providers.get(instance.providerType);
    if (registered === undefined) {
      throw new PaymentError(
        "PAYMENT_PROVIDER_UNKNOWN",
        `provider type "${instance.providerType}" is not registered`,
      );
    }
    const snapshot = await pool.withTransaction(
      async (tx) => {
        const fresh = await tx.query<ProviderInstanceRow>(
          "SELECT * FROM payment_provider_instance WHERE id = $1",
          [instance.id],
        );
        const row = fresh.rows[0];
        if (row === undefined) {
          throw new PaymentError(
            "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
            "provider instance deleted",
          );
        }
        const current = rowToInstance(row);
        const credentialSnapshot = await loadInstanceCredentialSnapshot(tx, secretBox?.(), current);
        return { current, credentialSnapshot };
      },
      { isolation: "repeatable read" },
    );
    const current = snapshot.current;
    // A stored config that no longer matches the adapter's schema must not be
    // silently applied to a money call.
    const issues = validateAgainstSchema(registered.configSchema, current.config, "config");
    if (issues.length > 0) {
      throw new PaymentError(
        "PAYMENT_PROVIDER_CONFIG_UNSUPPORTED",
        `stored settings of provider instance "${current.name}" do not match the provider schema: ${issues.join("; ")}`,
      );
    }
    // Review R3 (second pass): the endpoint policy is enforced HERE too, not
    // only in the settings form. A legacy document with an arbitrary apiBase
    // must not become authoritative just because the import moved its
    // credentials — otherwise the saved secret travels to that host.
    assertTrustedEndpoints(registered, current.config, current.name);
    const provider = configureProvider(registered, current.config);
    const { values } = resolveRequiredCredentials(provider, current, snapshot.credentialSnapshot);
    return { provider, instance: current, secrets: { values } };
  }

  /**
   * Applies a provider-CONFIRMED refund: the amount is booked once, the intent
   * becomes SUCCEEDED, the payment advances and the outbox is written — all in
   * one transaction. Callers that merely re-read a known refund object share
   * this, so "confirm twice" cannot book twice.
   */
  async function applyConfirmedRefund(input: {
    readonly intentId: string;
    readonly paymentId: string;
    readonly amount: number;
    readonly providerRefundId: string | null | undefined;
  }): Promise<void> {
    const { intentId, paymentId, amount, providerRefundId } = input;
    await pool.withTransaction(async (tx) => {
      const locked = await getWithinTx(tx, paymentId, true);
      const current = await tx.query<{ status: string }>(
        "SELECT status FROM payment_refund WHERE id = $1 FOR UPDATE",
        [intentId],
      );
      if (current.rows[0]?.status === "SUCCEEDED") return;
      if (!["SUBMITTED", "NEEDS_REVIEW"].includes(current.rows[0]?.status ?? "")) {
        throw new PaymentError("PAYMENT_REQUEST_INVALID", "refund intent is no longer executable");
      }
      if (locked === null) throw new PaymentError("PAYMENT_NOT_FOUND", "payment vanished");
      const nextRemainder = round2(locked.amount - locked.refundedAmount - amount);
      if (nextRemainder < 0) {
        throw new PaymentError(
          "PAYMENT_REFUND_EXCEEDS_AMOUNT",
          "concurrent refund exhausted the amount",
        );
      }
      const target: PaymentStatus = nextRemainder === 0 ? "REFUNDED" : "PARTIALLY_REFUNDED";
      assertTransition(locked.status, target);
      const clean = await tx.query<PaymentRow>(
        `UPDATE payment
         SET refunded_amount = ROUND((refunded_amount + $2)::numeric, 2),
             status = $3, updated_at = $4
         WHERE id = $1 RETURNING *`,
        [paymentId, amount, target, clock.now()],
      );
      const next = rowToPayment(clean.rows[0]!);
      await tx.query(
        `UPDATE payment_refund SET status = 'SUCCEEDED', provider_refund_id = COALESCE($2, provider_refund_id),
           updated_at = $3
         WHERE id = $1`,
        [intentId, providerRefundId ?? null, clock.now()],
      );
      await appendEvent(tx, paymentId, {
        eventType: target,
        source: "system",
        payload: { amount, refunded_amount: next.refundedAmount, refund_intent_id: intentId },
      });
      await writeOutbox(tx, next, locked.status);
    });
  }

  async function appendEvent(
    executor: DbClient,
    paymentId: string,
    event: {
      readonly eventType: PaymentEventType;
      readonly source: "operator" | "provider" | "system";
      readonly actor?: PaymentActor;
      readonly providerEventId?: string;
      readonly inboundEventId?: string;
      readonly payload?: unknown;
    },
  ): Promise<void> {
    await executor.query(
      `INSERT INTO payment_event
         (id, payment_id, event_type, actor_type, actor_id, source,
          provider_event_id, inbound_event_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        newStableId(),
        paymentId,
        event.eventType,
        event.actor?.type ?? null,
        event.actor?.id ?? null,
        event.source,
        event.providerEventId ?? null,
        event.inboundEventId ?? null,
        event.payload === undefined ? null : JSON.stringify(event.payload),
      ],
    );
  }

  /** The M07 outbox INSERT (same envelope; L1 cannot import publication). */
  async function writeOutbox(
    executor: DbClient,
    payment: {
      readonly id: string;
      readonly status: PaymentStatus;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly amount: number;
      readonly currency: string;
    },
    previousStatus: PaymentStatus,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO publication_outbox (id, aggregate, aggregate_id, event_type, payload)
       VALUES ($1, 'payment', $2, 'PaymentStatusChanged', $3)`,
      [
        newStableId(),
        payment.id,
        JSON.stringify({
          payment_id: payment.id,
          previous_status: previousStatus,
          status: payment.status,
          subject_type: payment.subjectType,
          subject_id: payment.subjectId,
          amount: payment.amount,
          currency: payment.currency,
        }),
      ],
    );
  }

  async function getWithinTx(
    executor: DbClient,
    id: string,
    forUpdate: boolean,
  ): Promise<Payment | null> {
    const result = await executor.query<PaymentRow>(
      `SELECT * FROM payment WHERE id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
      [id],
    );
    return result.rows.length === 1 ? rowToPayment(result.rows[0]!) : null;
  }

  function validateCreateInput(input: CreatePaymentInput): void {
    if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 9_999_999_999.99) {
      throw new PaymentError("PAYMENT_REQUEST_INVALID", "amount must be a positive amount");
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new PaymentError(
        "PAYMENT_REQUEST_INVALID",
        "currency must be an ISO-4217 alpha-3 code",
      );
    }
    // S7 money boundary: explicit whitelist; sub-minor precision is rejected
    // (never silently rounded) — toMinorUnits throws on 3+ decimals / drift.
    if (!isSupportedCurrency(input.currency)) {
      throw new PaymentError(
        "PAYMENT_CURRENCY_UNSUPPORTED",
        `currency "${input.currency}" is not supported by the 2-decimal money model`,
      );
    }
    toMinorUnits(input.amount, input.currency);
    if (!isAllowedSubjectType(input.subject_type)) {
      throw new PaymentError(
        "PAYMENT_REQUEST_INVALID",
        `subject_type "${input.subject_type}" is not allowed`,
      );
    }
    if (
      typeof input.subject_id !== "string" ||
      input.subject_id.length === 0 ||
      input.subject_id.length > 120
    ) {
      throw new PaymentError("PAYMENT_REQUEST_INVALID", "subject_id is required (opaque id)");
    }
    if (
      typeof input.idempotency_key !== "string" ||
      input.idempotency_key.length < 8 ||
      input.idempotency_key.length > 200
    ) {
      throw new PaymentError(
        "PAYMENT_REQUEST_INVALID",
        "idempotency_key must be 8–200 chars (it is the retry identity)",
      );
    }
    if (input.description !== undefined && input.description.length > 500) {
      throw new PaymentError("PAYMENT_REQUEST_INVALID", "description exceeds 500 chars");
    }
    if (input.metadata !== undefined) {
      if (
        Object.hasOwn(input.metadata, CREATE_CLAIM_KEY) ||
        Object.hasOwn(input.metadata, PROVIDER_ATTEMPT_KEY)
      ) {
        throw new PaymentError("PAYMENT_REQUEST_INVALID", "reserved payment metadata key");
      }
      const keys = Object.keys(input.metadata);
      if (keys.length > 32) {
        throw new PaymentError("PAYMENT_METADATA_TOO_LARGE", "metadata allows at most 32 keys");
      }
      if (JSON.stringify(input.metadata).length > MAX_METADATA_JSON) {
        throw new PaymentError("PAYMENT_METADATA_TOO_LARGE", "metadata exceeds 4096 bytes");
      }
    }
  }

  async function applyProviderOutcome(
    payment: Payment,
    outcome: {
      readonly status: NormalizedProviderOutcome;
      readonly externalId?: string;
      readonly providerStatus?: string;
      readonly paymentUrl?: string;
    },
    event: {
      readonly source: "operator" | "provider" | "system";
      readonly providerEventId?: string;
      readonly inboundEventId?: string;
      readonly actor?: PaymentActor;
    },
    expectedClaim?: string,
  ): Promise<Payment> {
    const target: PaymentStatus =
      outcome.status === "SUCCEEDED"
        ? "SUCCEEDED"
        : outcome.status === "FAILED"
          ? "FAILED"
          : "PENDING";
    const settle = async (tx: DbClient): Promise<Payment> => {
      const locked = await getWithinTx(tx, payment.id, true);
      if (locked === null) throw new PaymentError("PAYMENT_NOT_FOUND", "payment vanished");
      if (expectedClaim !== undefined) {
        const claim = await tx.query<{ token: string | null }>(
          `SELECT metadata #>> ARRAY[$2, 'token'] AS token FROM payment WHERE id=$1`,
          [payment.id, CREATE_CLAIM_KEY],
        );
        if (claim.rows[0]?.token !== expectedClaim) {
          throw new PaymentError("PAYMENT_PROVIDER_UNAVAILABLE", "stale payment create attempt");
        }
      }
      if (
        outcome.externalId !== undefined &&
        locked.externalPaymentId !== null &&
        locked.externalPaymentId !== outcome.externalId
      ) {
        throw new PaymentError(
          "PAYMENT_INBOUND_INVALID",
          "provider payment reference does not match",
        );
      }
      if (locked.status === target || !canTransition(locked.status, target)) {
        // A callback may settle first; retain its status and attach the later reference.
        if (locked.externalPaymentId === null && outcome.externalId !== undefined) {
          const attached = await tx.query<PaymentRow>(
            `UPDATE payment SET external_payment_id=$2,
               payment_url = COALESCE($4, payment_url), updated_at=$3
             WHERE id=$1 RETURNING *`,
            [payment.id, outcome.externalId, clock.now(), outcome.paymentUrl ?? null],
          );
          return rowToPayment(attached.rows[0]!);
        }
        return locked;
      }
      assertTransition(locked.status, target);
      const now = clock.now();
      const updated = await tx.query<PaymentRow>(
        `UPDATE payment SET status = $2, updated_at = $3,
           external_payment_id = COALESCE($4, external_payment_id),
           payment_url = COALESCE($5, payment_url),
           paid_at = CASE WHEN $2 = 'SUCCEEDED' THEN COALESCE(paid_at, $3) ELSE paid_at END
         WHERE id = $1 RETURNING *`,
        [payment.id, target, now, outcome.externalId ?? null, outcome.paymentUrl ?? null],
      );
      const next = rowToPayment(updated.rows[0]!);
      await appendEvent(tx, payment.id, {
        eventType: statusChangeEvent(locked.status, target),
        ...event,
        payload: {
          previous_status: locked.status,
          provider_status: outcome.providerStatus ?? null,
        },
      });
      await writeOutbox(tx, next, locked.status);
      return next;
    };
    return pool.withTransaction(settle);
  }

  async function insertPaymentIntent(
    tx: DbClient,
    paymentId: string,
    input: CreatePaymentInput,
    actor?: PaymentActor,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO payment
         (id, provider_instance_id, subject_type, subject_id, amount, currency,
          status, description, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'CREATED', $7, $8, $9)`,
      [
        paymentId,
        input.provider_instance_id,
        input.subject_type,
        input.subject_id,
        round2(input.amount),
        input.currency,
        input.description ?? null,
        input.idempotency_key,
        JSON.stringify({ ...input.metadata, [CREATE_CLAIM_KEY]: { ready: true } }),
      ],
    );
    await appendEvent(tx, paymentId, {
      eventType: "CREATED",
      source: "system",
      ...(actor === undefined ? {} : { actor }),
    });
  }

  return {
    /** Creates a subject-owned intent under the owner's row lock. The trusted
     * callback checks ownership, locks/reserves the subject and reads its
     * immutable snapshot. Provider I/O runs only after this transaction. */
    async createForExtension(
      base: {
        readonly provider_instance_id: string;
        readonly subject_type: string;
        readonly subject_id: string;
        readonly idempotency_key: string;
        readonly metadata: Record<string, unknown>;
      },
      reserve: (tx: DbClient) => Promise<{ readonly amount: number; readonly currency: string }>,
      actor: PaymentActor,
    ): Promise<{ readonly payment: Payment; readonly replayed: boolean }> {
      const instance = await instances.get(base.provider_instance_id);
      if (instance === null)
        throw new PaymentError(
          "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
          "provider instance not found",
        );
      if (!instance.enabled)
        throw new PaymentError("PAYMENT_PROVIDER_UNAVAILABLE", "provider instance disabled");
      const provider = providers.get(instance.providerType);
      if (provider === undefined)
        throw new PaymentError("PAYMENT_PROVIDER_UNKNOWN", "provider is not registered");
      const result = await pool
        .withTransaction(async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `pcms:extension-payment-key:${base.idempotency_key}`,
          ]);
          const snapshot = await reserve(tx);
          const input: CreatePaymentInput = { ...base, ...snapshot };
          validateCreateInput(input);
          const existing = await tx.query<PaymentRow>(
            `SELECT * FROM payment WHERE idempotency_key = $1 AND metadata->>'extension_id' = $2`,
            [input.idempotency_key, input.metadata?.extension_id],
          );
          if (existing.rows.length > 0) {
            const payment = rowToPayment(existing.rows[0]!);
            if (
              payment.providerInstanceId !== instance.id ||
              payment.subjectType !== input.subject_type ||
              payment.subjectId !== input.subject_id ||
              payment.amount !== round2(input.amount) ||
              payment.currency !== input.currency ||
              payment.metadata.extension_id !== input.metadata?.extension_id
            )
              throw new PaymentError(
                "PAYMENT_DUPLICATE_REQUEST",
                "idempotency key already used with a different payload",
              );
            return { payment, replayed: true };
          }
          const active = await tx.query<PaymentRow>(
            `SELECT * FROM payment WHERE subject_type = $1 AND subject_id = $2
             AND status IN ('CREATED', 'PENDING', 'SUCCEEDED', 'PARTIALLY_REFUNDED') LIMIT 1`,
            [input.subject_type, input.subject_id],
          );
          if (active.rows.length > 0)
            throw new PaymentError(
              "PAYMENT_DUPLICATE_REQUEST",
              "subject already has an active or successful payment",
            );
          const paymentId = newStableId();
          await insertPaymentIntent(tx, paymentId, input, actor);
          const payment = await getWithinTx(tx, paymentId, false);
          if (payment === null)
            throw new PaymentError("PAYMENT_NOT_FOUND", "payment vanished after insert");
          return { payment, replayed: false };
        })
        .catch((error: unknown) => {
          const dbError = error as { code?: string; constraint?: string };
          if (
            dbError.code === "23505" &&
            dbError.constraint === "payment_provider_instance_id_idempotency_key_key"
          ) {
            throw new PaymentError(
              "PAYMENT_DUPLICATE_REQUEST",
              "idempotency key already used with a different payload",
            );
          }
          throw error;
        });
      if (result.payment.status === "CREATED" && result.payment.externalPaymentId === null) {
        const settled = await this.callProviderAndSettle(provider, instance, result.payment, actor);
        return { payment: settled.payment, replayed: result.replayed };
      }
      return result;
    },
    /**
     * Create with CMS-owned idempotency (spec §33): replays of the same
     * (provider instance, idempotency_key) return the SAME logical payment;
     * a changed payload under the same key is a hard conflict; an
     * interrupted creation (payment still CREATED) resumes transparently.
     */
    async create(
      input: CreatePaymentInput,
      actor?: PaymentActor,
    ): Promise<{ readonly payment: Payment; readonly replayed: boolean }> {
      validateCreateInput(input);
      const instance = await instances.get(input.provider_instance_id);
      if (instance === null) {
        throw new PaymentError(
          "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
          `provider instance ${String(input.provider_instance_id)} not found`,
        );
      }
      if (!instance.enabled) {
        throw new PaymentError(
          "PAYMENT_PROVIDER_UNAVAILABLE",
          `provider instance "${instance.name}" is disabled`,
        );
      }
      const provider = providers.get(instance.providerType);
      if (provider === undefined) {
        throw new PaymentError(
          "PAYMENT_PROVIDER_UNKNOWN",
          `provider type "${instance.providerType}" is not registered`,
        );
      }

      const existing = await pool.query<PaymentRow>(
        `SELECT * FROM payment WHERE provider_instance_id = $1 AND idempotency_key = $2`,
        [instance.id, input.idempotency_key],
      );
      if (existing.rows.length === 1) {
        const payment = rowToPayment(existing.rows[0]!);
        const samePayload =
          payment.amount === round2(input.amount) &&
          payment.currency === input.currency &&
          payment.subjectType === input.subject_type &&
          payment.subjectId === input.subject_id;
        if (!samePayload) {
          throw new PaymentError(
            "PAYMENT_DUPLICATE_REQUEST",
            "idempotency key already used with a different payload",
          );
        }
        if (payment.status === "CREATED" && payment.externalPaymentId === null) {
          // Interrupted creation: finish it through the same provider key.
          const finished = await this.callProviderAndSettle(provider, instance, payment, actor);
          return { payment: finished.payment, replayed: finished.replayed };
        }
        return { payment, replayed: true };
      }

      const paymentId = newStableId();
      try {
        await pool.withTransaction(async (tx) => {
          await insertPaymentIntent(tx, paymentId, input, actor);
        });
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          // Concurrent create with the same key: re-run the replay path.
          const raced = await this.create(input, actor);
          return { payment: raced.payment, replayed: true };
        }
        throw error;
      }
      const created = await getWithinTx(pool, paymentId, false);
      if (created === null)
        throw new PaymentError("PAYMENT_NOT_FOUND", "payment vanished after insert");
      const settled = await this.callProviderAndSettle(provider, instance, created, actor);
      return { payment: settled.payment, replayed: false };
    },

    /** Provider network call + state settlement — never inside a DB tx. */
    async callProviderAndSettle(
      provider: PaymentProvider,
      instance: PaymentProviderInstanceLike,
      payment: Payment,
      actor?: PaymentActor,
    ): Promise<{ readonly payment: Payment; readonly replayed: boolean }> {
      // Credentials and the configured adapter are resolved HERE, per call:
      // a settings change is visible to the next action without a restart.
      const wiring = await wiringFor(instance);
      const secrets = wiring.secrets;
      const configured = wiring.provider;
      const capabilities = configured.capabilities();
      const retryable = capabilities.providerIdempotency;
      // Review Y6: the provider's idempotency key expires. Re-sending an
      // UNKNOWN outcome after that window is a brand-new operation at the
      // provider, not a retry, so it is refused before any I/O and left for
      // reconciliation. A payment that was never submitted has no marker and
      // is unaffected.
      // B4: a legacy row with NO trace of an attempt is not "never sent" — the
      // previous release also removed the claim after a lost response, and it
      // wrote no durable marker. Treat it as an unknown outcome instead of
      // starting a fresh operation under the same key.
      if (payment.providerAttemptState === "unknown_legacy") {
        throw new PaymentError(
          "PAYMENT_RECONCILIATION_REQUIRED",
          `payment "${payment.id}" has no record of whether an external create was sent (written by an older release) — reconcile it with the provider before retrying; no provider call was made`,
          { details: { payment_id: payment.id, reason: "unknown_legacy" } },
        );
      }
      const windowSeconds = capabilities.providerIdempotencyWindowSeconds;
      if (payment.providerAttemptAt !== null && windowSeconds !== undefined) {
        const ageMs = clock.now().getTime() - payment.providerAttemptAt.getTime();
        if (ageMs > windowSeconds * 1000) {
          throw new PaymentError(
            "PAYMENT_RECONCILIATION_REQUIRED",
            `the first provider attempt for payment "${payment.id}" is older than the provider's ${windowSeconds}s idempotency window — re-sending would create a NEW operation; reconcile the payment with the provider before retrying`,
            {
              details: {
                payment_id: payment.id,
                first_attempt_at: payment.providerAttemptAt.toISOString(),
                window_seconds: windowSeconds,
              },
            },
          );
        }
      }
      const claim = newStableId();
      // A short committed CAS, not a connection or transaction held over I/O.
      // Missing legacy markers are unknown outcomes for non-idempotent providers.
      // Only an idempotent provider can reclaim an expired idempotent lease.
      const acquired = await pool.query<{ id: string }>(
        `UPDATE payment SET metadata =
           jsonb_set(
             jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY[$2],
               jsonb_build_object('token', $3::text, 'at', clock_timestamp(), 'retryable', $4::boolean)),
             ARRAY[$5], to_jsonb(COALESCE(metadata #>> ARRAY[$5], clock_timestamp()::text)), true)
         WHERE id=$1 AND status='CREATED' AND external_payment_id IS NULL AND (
           metadata #> ARRAY[$2, 'ready'] = 'true'::jsonb OR
           ($4::boolean AND NOT COALESCE(metadata ? $2, false)) OR (
             $4::boolean AND metadata #> ARRAY[$2, 'retryable'] = 'true'::jsonb AND
             (metadata #>> ARRAY[$2, 'at'])::timestamptz < clock_timestamp() - interval '5 minutes'
           )
         ) RETURNING id`,
        [payment.id, CREATE_CLAIM_KEY, claim, retryable, PROVIDER_ATTEMPT_KEY],
      );
      if (acquired.rows.length === 0) {
        const current = await getWithinTx(pool, payment.id, false);
        if (current === null) throw new PaymentError("PAYMENT_NOT_FOUND", "payment not found");
        if (current.status !== "CREATED" || current.externalPaymentId !== null)
          return { payment: current, replayed: true };
        throw new PaymentError(
          "PAYMENT_PROVIDER_UNAVAILABLE",
          retryable
            ? "payment creation is already in progress"
            : "provider create outcome is unknown; manual reconciliation required",
        );
      }
      const releaseRetryableClaim = async () => {
        if (!retryable) return;
        await pool.query(
          `UPDATE payment SET metadata = metadata - $2 WHERE id=$1 AND metadata #>> ARRAY[$2, 'token'] = $3`,
          [payment.id, CREATE_CLAIM_KEY, claim],
        );
      };
      let result: import("./providers.js").ProviderCreateResult;
      try {
        result = await configured.createPayment(
          {
            paymentId: payment.id,
            amount: payment.amount,
            currency: payment.currency,
            ...(payment.description === null ? {} : { description: payment.description }),
            idempotencyKey: `pcms:${payment.id}`,
            metadata: payment.metadata,
          },
          secrets,
        );
      } catch (error) {
        await releaseRetryableClaim();
        if (error instanceof PaymentError) throw error;
        throw new PaymentError(
          "PAYMENT_PROVIDER_UNAVAILABLE",
          `provider create failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
          { cause: error },
        );
      }
      try {
        const next = await applyProviderOutcome(
          payment,
          {
            status: result.status,
            externalId: result.externalId,
            ...(result.providerStatus === undefined
              ? {}
              : { providerStatus: result.providerStatus }),
            ...(result.paymentUrl === undefined ? {} : { paymentUrl: result.paymentUrl }),
          },
          { source: "provider", ...(actor === undefined ? {} : { actor }) },
          claim,
        );
        return { payment: next, replayed: payment.status !== "CREATED" };
      } catch (error) {
        await releaseRetryableClaim();
        throw error;
      }
    },

    /**
     * Callback application (steps 5–8 of the spec §34 pipeline; verify/
     * persist/dedupe happened upstream). Late or duplicate provider events
     * that would not form a valid transition are ignored harmlessly.
     */
    async processCallback(input: {
      readonly providerInstanceId: string;
      readonly parsed: ParsedCallback;
      readonly inboundEventId?: string;
    }): Promise<{ readonly payment: Payment; readonly applied: boolean }> {
      const instance = await instances.get(input.providerInstanceId);
      if (instance === null) {
        throw new PaymentError(
          "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
          "provider instance not found",
        );
      }
      const provider = providers.get(instance.providerType);
      if (provider === undefined) {
        throw new PaymentError("PAYMENT_PROVIDER_UNKNOWN", "provider not registered");
      }
      if (input.parsed.externalPaymentId === null && input.parsed.idempotencyKey === null) {
        throw new PaymentError("PAYMENT_INBOUND_INVALID", "callback carries no payment reference");
      }
      return pool.withTransaction(async (tx) => {
        const locate =
          input.parsed.externalPaymentId !== null
            ? await tx.query<PaymentRow>(
                `SELECT * FROM payment
               WHERE provider_instance_id = $1 AND external_payment_id = $2 FOR UPDATE`,
                [instance.id, input.parsed.externalPaymentId],
              )
            : await tx.query<PaymentRow>(
                `SELECT * FROM payment
               WHERE provider_instance_id = $1 AND idempotency_key = $2 FOR UPDATE`,
                [instance.id, input.parsed.idempotencyKey],
              );
        if (locate.rows.length !== 1) {
          throw new PaymentError("PAYMENT_NOT_FOUND", "callback references an unknown payment");
        }
        const payment = rowToPayment(locate.rows[0]!);
        // Amount/currency verification (fraud guard, spec §34): a callback
        // reporting a different amount than the payment is a verification
        // failure — it never drives the state machine. Throwing here rolls
        // the tx back; the upstream inbound record keeps its dedupe/audit
        // trail and is marked failed by the composition layer.
        if (
          (input.parsed.amount !== undefined && input.parsed.amount !== payment.amount) ||
          (input.parsed.currency !== undefined && input.parsed.currency !== payment.currency)
        ) {
          throw new PaymentError(
            "PAYMENT_INBOUND_INVALID",
            "callback amount or currency does not match the payment",
          );
        }
        const target: PaymentStatus =
          input.parsed.outcome === "SUCCEEDED"
            ? "SUCCEEDED"
            : input.parsed.outcome === "FAILED"
              ? "FAILED"
              : "PENDING";
        if (payment.status === target || !canTransition(payment.status, target)) {
          // Duplicate/regressing provider event — no state change.
          return { payment, applied: false };
        }
        const now = clock.now();
        const updated = await tx.query<PaymentRow>(
          `UPDATE payment SET status = $2, updated_at = $3,
             paid_at = CASE WHEN $2 = 'SUCCEEDED' THEN COALESCE(paid_at, $3) ELSE paid_at END
           WHERE id = $1 RETURNING *`,
          [payment.id, target, now],
        );
        const next = rowToPayment(updated.rows[0]!);
        await appendEvent(tx, payment.id, {
          eventType: statusChangeEvent(payment.status, target),
          source: "provider",
          ...(input.parsed.providerEventId === null
            ? {}
            : { providerEventId: input.parsed.providerEventId }),
          ...(input.inboundEventId === undefined ? {} : { inboundEventId: input.inboundEventId }),
          payload: {
            previous_status: payment.status,
            provider_status: input.parsed.providerStatus ?? null,
          },
        });
        await writeOutbox(tx, next, payment.status);
        return { payment: next, applied: true };
      });
    },

    async cancel(paymentId: string, actor: PaymentActor): Promise<Payment> {
      const payment = await this.getForUpdate(paymentId);
      if (payment.status === "CANCELLED") return payment; // idempotent cancel
      const { provider, instance, secrets } = await this.wiring(payment);
      if (!provider.capabilities().cancel) {
        throw new PaymentError(
          "PAYMENT_CAPABILITY_UNSUPPORTED",
          "provider does not support cancel",
        );
      }
      if (payment.status !== "CREATED" && payment.status !== "PENDING") {
        assertTransition(payment.status, "CANCELLED"); // precise error
      }
      if (payment.externalPaymentId !== null) {
        if (provider.cancelPayment === undefined) {
          throw new PaymentError("PAYMENT_CAPABILITY_UNSUPPORTED", "provider cannot cancel");
        }
        await provider.cancelPayment(payment.externalPaymentId, secrets);
      }
      void instance;
      const now = clock.now();
      return pool.withTransaction(async (tx) => {
        const locked = await getWithinTx(tx, paymentId, true);
        if (locked === null) throw new PaymentError("PAYMENT_NOT_FOUND", "payment vanished");
        if (locked.status === "CANCELLED") return locked;
        assertTransition(locked.status, "CANCELLED");
        const updated = await tx.query<PaymentRow>(
          `UPDATE payment SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2
           WHERE id = $1 RETURNING *`,
          [paymentId, now],
        );
        const next = rowToPayment(updated.rows[0]!);
        await appendEvent(tx, paymentId, {
          eventType: "CANCELLED",
          source: "operator",
          actor,
          payload: { previous_status: locked.status },
        });
        await writeOutbox(tx, next, locked.status);
        return next;
      });
    },

    /**
     * Privileged refund (spec §37): permission + audit live in the ops
     * layer; the service enforces state/capability/amount. Partial refunds
     * accumulate; the final one flips the status to REFUNDED.
     */
    /**
     * S7 durable refund flow: the REQUEST is recorded transactionally
     * (intent row + REFUND_REQUESTED event) BEFORE any provider call; the
     * external call happens ONLY from the controlled worker
     * ("payments.refund.execute" job) against the intent's stable
     * idempotency key. Crash-safe by construction: a crash before the
     * provider call leaves REQUESTED (re-queueable); a crash after the
     * external success but before commit leaves SUBMITTED (the executor
     * re-calls with the SAME key — idempotent where the provider supports
     * it — and reconciles; without provider idempotency the intent lands in
     * NEEDS_REVIEW, never auto-retried).
     */
    async refund(
      paymentId: string,
      input: { readonly amount?: number; readonly reason?: string },
      actor: PaymentActor,
    ): Promise<{ readonly payment: Payment; readonly intentId: string }> {
      const payment = await this.getForUpdate(paymentId);
      const { provider } = await this.wiring(payment);
      if (!provider.capabilities().refund) {
        throw new PaymentError(
          "PAYMENT_CAPABILITY_UNSUPPORTED",
          "provider does not support refund",
        );
      }
      if (payment.status !== "SUCCEEDED" && payment.status !== "PARTIALLY_REFUNDED") {
        assertTransition(payment.status, "PARTIALLY_REFUNDED");
      }
      const remaining = round2(payment.amount - payment.refundedAmount);
      if (remaining <= 0) {
        throw new PaymentError("PAYMENT_REFUND_EXCEEDS_AMOUNT", "nothing left to refund");
      }
      const amount = input.amount === undefined ? remaining : input.amount;
      // Integer minor-unit checks — no float tolerance paths (S7 money).
      try {
        toMinorUnits(amount, payment.currency);
      } catch (error) {
        throw new PaymentError(
          "PAYMENT_REQUEST_INVALID",
          "refund amount must be exact minor units",
          { cause: error },
        );
      }
      if (amountLt(remaining, amount)) {
        throw new PaymentError(
          "PAYMENT_REFUND_EXCEEDS_AMOUNT",
          `refund amount ${amount} exceeds the refundable remainder ${remaining}`,
        );
      }
      const intentId = newStableId();
      const idempotencyKey = `refund-intent-${intentId}`;
      const recorded = await pool.withTransaction(async (tx) => {
        // One ACTIVE intent per payment: concurrent refunds serialize on the
        // payment ROW LOCK taken HERE — the earlier getForUpdate read does
        // NOT lock (S7 corpus finding: both guards saw zero rows, the loser
        // surfaced a raw 23505 instead of this error code); the partial
        // unique index backs the guarantee at the DB level.
        await getWithinTx(tx, paymentId, true);
        const active = await tx.query(
          // B3: NEEDS_REVIEW is an UNKNOWN outcome — it still reserves the
          // amount, so a new refund key cannot start a second movement while
          // the first one is unproven.
          `SELECT 1 FROM payment_refund WHERE payment_id = $1
             AND status IN ('REQUESTED','SUBMITTED','NEEDS_REVIEW') FOR UPDATE`,
          [paymentId],
        );
        if (active.rows.length > 0) {
          throw new PaymentError(
            "PAYMENT_REFUND_IN_PROGRESS",
            "another refund for this payment is already in flight",
          );
        }
        await tx.query(
          `INSERT INTO payment_refund
             (id, payment_id, provider_instance_id, amount, currency, status,
              idempotency_key, created_by)
           VALUES ($1, $2, $3, $4, $5, 'REQUESTED', $6, $7)`,
          [
            intentId,
            paymentId,
            payment.providerInstanceId,
            amount,
            payment.currency,
            idempotencyKey,
            `${actor.type}:${actor.id}`,
          ],
        );
        await appendEvent(tx, paymentId, {
          eventType: "REFUND_REQUESTED",
          source: "operator",
          actor,
          payload: { amount, reason: input.reason ?? null, refund_intent_id: intentId },
        });
        return intentId;
      });
      return { payment, intentId: recorded };
    },

    /** Lists intents of one payment (Admin detail, diagnostics). */
    async listRefundIntents(paymentId: string) {
      const result = await pool.query<{
        id: string;
        status: string;
        amount: string;
        provider_refund_id: string | null;
        attempts: number;
        last_error: string | null;
        created_by: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, status, amount::text AS amount, provider_refund_id, attempts,
                last_error, created_by, created_at, updated_at
         FROM payment_refund WHERE payment_id = $1 ORDER BY created_at DESC, id`,
        [paymentId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        amount: Number(row.amount),
        provider_refund_id: row.provider_refund_id,
        attempts: row.attempts,
        last_error: row.last_error,
        created_by: row.created_by,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      }));
    },

    /** Provider status sync (spec §31 getPayment/status sync). */
    async sync(paymentId: string, actor?: PaymentActor): Promise<Payment> {
      const payment = await this.getForUpdate(paymentId);
      const { provider, secrets } = await this.wiring(payment);
      if (!provider.capabilities().statusSync) {
        throw new PaymentError(
          "PAYMENT_CAPABILITY_UNSUPPORTED",
          "provider does not support status sync",
        );
      }
      if (payment.externalPaymentId === null) {
        return payment; // nothing to sync yet
      }
      if (provider.getPayment === undefined) {
        throw new PaymentError("PAYMENT_CAPABILITY_UNSUPPORTED", "provider cannot sync");
      }
      const remote = await provider.getPayment(payment.externalPaymentId, secrets);
      if (remote === null) {
        throw new PaymentError("PAYMENT_NOT_FOUND", "provider no longer knows this payment");
      }
      return applyProviderOutcome(
        payment,
        {
          status: remote.status,
          ...(remote.providerStatus === undefined ? {} : { providerStatus: remote.providerStatus }),
        },
        { source: "system", ...(actor === undefined ? {} : { actor }) },
      );
    },

    async get(paymentId: string): Promise<Payment | null> {
      return getWithinTx(pool, paymentId, false);
    },

    // ---- S7: intent execution (worker-side) --------------------------------

    /**
     * Claims and executes one refund intent. Called ONLY from the
     * "payments.refund.execute" worker job. Outcome classification:
     *  - provider success            → SUCCEEDED + payment update (one tx)
     *  - provider definitive refusal → FAILED (no money moved; retryable
     *    only manually)
     *  - transport/timeout/unknown   → SUBMITTED stays; auto-retry ONLY when
     *    the provider supports idempotency; otherwise NEEDS_REVIEW.
     * A crash BEFORE the provider call leaves the intent REQUESTED (the
     * job retry re-claims it); a crash AFTER provider success but BEFORE
     * local commit leaves SUBMITTED with the same idempotency key — the
     * next execute re-issues the identical call and reconciles.
     */
    async executeRefundIntent(intentId: string): Promise<{ readonly status: string }> {
      const intentResult = await pool.query<{
        id: string;
        payment_id: string;
        amount: string;
        currency: string;
        status: string;
        idempotency_key: string;
        attempts: number;
        first_submitted_at: Date | null;
        first_submitted_proven: boolean;
        provider_refund_id: string | null;
        confirmations: number;
      }>(
        `SELECT id, payment_id, amount::text AS amount, currency, status, idempotency_key, attempts,
                first_submitted_at, first_submitted_proven, provider_refund_id, confirmations
         FROM payment_refund WHERE id = $1`,
        [intentId],
      );
      const intent = intentResult.rows[0];
      if (intent === undefined) {
        throw new PaymentError("PAYMENT_NOT_FOUND", `refund intent ${intentId} not found`);
      }
      if (intent.status !== "REQUESTED" && intent.status !== "SUBMITTED") {
        return { status: intent.status }; // terminal already — no-op
      }
      const payment = await this.getForUpdate(intent.payment_id);
      const { provider, secrets } = await this.wiring(payment);
      const amount = Number(intent.amount);
      // F1: a refund that keeps answering "not final" must not stay SUBMITTED
      // forever. The counter is bounded, so the escalation is visible instead
      // of an endless poll.
      if (intent.status === "SUBMITTED" && intent.confirmations >= MAX_REFUND_CONFIRMATIONS) {
        await pool.query(
          `UPDATE payment_refund SET status = 'NEEDS_REVIEW', last_error = $2, updated_at = $3
           WHERE id = $1 AND status = 'SUBMITTED'`,
          [
            intentId,
            `provider did not confirm the refund after ${intent.confirmations} checks; reconcile with the provider`,
            clock.now(),
          ],
        );
        return { status: "NEEDS_REVIEW" };
      }
      // B1: a previous answer already named the provider's refund object, and
      // it was not final. Confirm THAT object — a lookup, not a second money
      // POST.
      if (intent.status === "SUBMITTED" && intent.provider_refund_id !== null) {
        const remote =
          provider.getRefund === undefined
            ? null
            : await provider.getRefund(intent.provider_refund_id, secrets);
        if (remote !== null) {
          return this.settleRefundFromProvider(
            intentId,
            intent.payment_id,
            amount,
            remote.status,
            intent.provider_refund_id,
          );
        }
      }
      // SUBMITTED survives a process crash. Without provider idempotency an
      // automatic replay could move money twice, so require reconciliation.
      const capabilities = provider.capabilities();
      if (intent.status === "SUBMITTED" && !capabilities.providerIdempotency) {
        await pool.query(
          `UPDATE payment_refund SET status = 'NEEDS_REVIEW',
          last_error = 'interrupted submission without provider idempotency', updated_at = $2
          WHERE id = $1 AND status = 'SUBMITTED'`,
          [intentId, clock.now()],
        );
        return { status: "NEEDS_REVIEW" };
      }
      // Review Y6 (same boundary for refunds): after the provider's key
      // expires, re-sending the intent is a NEW refund at the provider.
      // B2: the age is measured from the FIRST submission, which retries,
      // errors and pending answers never move.
      const refundWindow = capabilities.providerIdempotencyWindowSeconds;
      if (intent.status === "SUBMITTED" && refundWindow !== undefined) {
        // F4: a time without recorded provenance may be the retired 0009
        // backfill (updated_at, moved by every retry). It cannot bound the
        // window, so the intent goes to reconciliation instead of a repeat.
        const firstSent =
          intent.first_submitted_at === null || intent.first_submitted_proven !== true
            ? null
            : new Date(intent.first_submitted_at);
        if (firstSent === null) {
          await pool.query(
            `UPDATE payment_refund SET status = 'NEEDS_REVIEW', last_error = $2, updated_at = $3
             WHERE id = $1 AND status = 'SUBMITTED'`,
            [
              intentId,
              "submitted without a recorded first-attempt time; the provider's idempotency window cannot be proven — reconcile with the provider",
              clock.now(),
            ],
          );
          return { status: "NEEDS_REVIEW" };
        }
        const ageMs = clock.now().getTime() - firstSent.getTime();
        if (ageMs > refundWindow * 1000) {
          await pool.query(
            `UPDATE payment_refund SET status = 'NEEDS_REVIEW', last_error = $2, updated_at = $3
             WHERE id = $1 AND status = 'SUBMITTED'`,
            [
              intentId,
              `unknown refund outcome older than the provider's ${refundWindow}s idempotency window; reconcile with the provider`,
              clock.now(),
            ],
          );
          return { status: "NEEDS_REVIEW" };
        }
      }
      // F1: for a SUBMITTED intent this is a CONFIRMATION, not a new attempt.
      // The provider deduplicates on the intent's stable key, so the same
      // operation is re-read; a separate counter keeps the stale-attempt
      // escalation from firing after five minutes.
      const claim =
        intent.status === "SUBMITTED"
          ? await pool.query(
              `UPDATE payment_refund SET confirmations = confirmations + 1, updated_at = $2
               WHERE id = $1 AND status = 'SUBMITTED' AND confirmations = $3 RETURNING id`,
              [intentId, clock.now(), intent.confirmations],
            )
          : await pool.query(
              // first_submitted_at is written once, on the first claim, and
              // never moved by a retry (B2: it bounds the provider's
              // idempotency window). Provenance is recorded so a later
              // migration never has to guess (F4).
              `UPDATE payment_refund SET status = 'SUBMITTED', attempts = attempts + 1, updated_at = $2,
                 first_submitted_at = COALESCE(first_submitted_at, $2), first_submitted_proven = true
               WHERE id = $1 AND status = 'REQUESTED' AND attempts = $3 RETURNING id`,
              [intentId, clock.now(), intent.attempts],
            );
      if (claim.rows.length === 0) {
        throw new PaymentError(
          "PAYMENT_REFUND_IN_PROGRESS",
          "another executor claimed the refund; retry",
        );
      }
      if (payment.externalPaymentId === null || provider.refundPayment === undefined) {
        // No capture to refund (CANCELLED/FAILED payment or capability
        // missing): record and fail the intent honestly.
        if (provider.refundPayment === undefined) {
          await pool.query(
            `UPDATE payment_refund SET status = 'FAILED', last_error = $2, updated_at = $3 WHERE id = $1`,
            [intentId, "provider cannot refund (capability missing)", clock.now()],
          );
          return { status: "FAILED" };
        }
        await pool.query(
          `UPDATE payment_refund SET status = 'FAILED', last_error = $2, updated_at = $3 WHERE id = $1`,
          [intentId, "payment has no provider-side capture", clock.now()],
        );
        return { status: "FAILED" };
      }
      let providerRefundId: string | undefined;
      let providerRefundStatus: NormalizedProviderOutcome | undefined;
      try {
        const result = await provider.refundPayment(
          payment.externalPaymentId,
          amount,
          intent.currency,
          secrets,
          intent.idempotency_key,
        );
        providerRefundId = result.providerRefundId;
        providerRefundStatus = result.status;
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
        const code = (error as { code?: string }).code ?? "";
        // Definitive provider refusal (validation/state) vs transport unknown.
        const definitive = [
          "PAYMENT_REQUEST_INVALID",
          "PAYMENT_CAPABILITY_UNSUPPORTED",
          "PAYMENT_REFUND_EXCEEDS_AMOUNT",
          "PAYMENT_NOT_FOUND",
        ].includes(code);
        if (definitive) {
          await pool.query(
            `UPDATE payment_refund SET status = 'FAILED', last_error = $2, updated_at = $3 WHERE id = $1 AND status = 'SUBMITTED'`,
            [intentId, message, clock.now()],
          );
          await appendEvent(pool, intent.payment_id, {
            eventType: "REFUND_REQUESTED",
            source: "system",
            payload: { refund_intent_id: intentId, outcome: "FAILED", error: message },
          });
          return { status: "FAILED" };
        }
        // Unknown outcome: auto-retry ONLY with provider idempotency.
        if (!provider.capabilities().providerIdempotency) {
          await pool.query(
            `UPDATE payment_refund SET status = 'NEEDS_REVIEW', last_error = $2, updated_at = $3 WHERE id = $1 AND status = 'SUBMITTED'`,
            [intentId, `unknown outcome (no provider idempotency): ${message}`, clock.now()],
          );
          await appendEvent(pool, intent.payment_id, {
            eventType: "REFUND_REQUESTED",
            source: "system",
            payload: { refund_intent_id: intentId, outcome: "NEEDS_REVIEW", error: message },
          });
          return { status: "NEEDS_REVIEW" };
        }
        // Idempotent provider: leave SUBMITTED — the job retry re-issues the
        // identical call with the same key; exceeding max attempts leaves it
        // SUBMITTED for manual reconciliation (never a silent loss).
        await pool.query(
          `UPDATE payment_refund SET last_error = $2, updated_at = $3 WHERE id = $1 AND status = 'SUBMITTED'`,
          [intentId, message, clock.now()],
        );
        throw error; // job retry machinery re-schedules with backoff
      }
      // Review Y2: a provider answer is not automatically a returned refund.
      // A definitive refusal must not book money, and a non-final state must
      // stay unresolved instead of being reported as success.
      if (providerRefundStatus === "FAILED") {
        await pool.query(
          `UPDATE payment_refund SET status = 'FAILED',
             provider_refund_id = COALESCE($4, provider_refund_id),
             last_error = $2, updated_at = $3
           WHERE id = $1 AND status IN ('SUBMITTED','NEEDS_REVIEW')`,
          [
            intentId,
            "provider reported the refund as canceled",
            clock.now(),
            providerRefundId ?? null,
          ],
        );
        await appendEvent(pool, intent.payment_id, {
          eventType: "REFUND_REQUESTED",
          source: "provider",
          payload: {
            refund_intent_id: intentId,
            outcome: "FAILED",
            provider_refund_id: providerRefundId ?? null,
          },
        });
        return { status: "FAILED" };
      }
      if (providerRefundStatus === "PENDING") {
        // Not confirmed yet: keep the intent SUBMITTED with the same key so the
        // next execution re-reads the provider, and never touch the amount.
        // B1: keep the provider's refund id — it is the handle the worker
        // uses to CONFIRM the outcome later without a second money POST.
        await pool.query(
          `UPDATE payment_refund SET provider_refund_id = COALESCE($2, provider_refund_id),
             last_error = $3, updated_at = $4
           WHERE id = $1 AND status = 'SUBMITTED'`,
          [
            intentId,
            providerRefundId ?? null,
            "provider reported the refund as not final; awaiting confirmation",
            clock.now(),
          ],
        );
        return { status: "SUBMITTED" };
      }
      // Provider confirmed the refund: apply it to the payment in ONE tx
      // (crash here = SUBMITTED + same key → the next execute reconciles).
      await applyConfirmedRefund({
        intentId,
        paymentId: intent.payment_id,
        amount,
        providerRefundId,
      });
      return { status: "SUCCEEDED" };
    },

    /**
     * B1: apply a refund state the provider reported for an ALREADY known
     * refund object (pending poll or inbound reconciliation). No money POST.
     */
    async settleRefundFromProvider(
      intentId: string,
      paymentId: string,
      amount: number,
      status: NormalizedProviderOutcome,
      providerRefundId: string | null,
    ): Promise<{ readonly status: string }> {
      if (status === "SUCCEEDED") {
        await applyConfirmedRefund({ intentId, paymentId, amount, providerRefundId });
        return { status: "SUCCEEDED" };
      }
      if (status === "FAILED") {
        await pool.query(
          `UPDATE payment_refund SET status = 'FAILED', provider_refund_id = COALESCE($2, provider_refund_id),
             last_error = $3, updated_at = $4
           WHERE id = $1 AND status IN ('SUBMITTED','NEEDS_REVIEW')`,
          [intentId, providerRefundId, "provider reported the refund as canceled", clock.now()],
        );
        await appendEvent(pool, paymentId, {
          eventType: "REFUND_REQUESTED",
          source: "provider",
          payload: {
            refund_intent_id: intentId,
            outcome: "FAILED",
            provider_refund_id: providerRefundId,
          },
        });
        return { status: "FAILED" };
      }
      const pending = await pool.query<{ confirmations: number }>(
        `UPDATE payment_refund SET provider_refund_id = COALESCE($2, provider_refund_id),
           confirmations = confirmations + 1,
           last_error = $3, updated_at = $4
         WHERE id = $1 AND status IN ('SUBMITTED','NEEDS_REVIEW')
         RETURNING confirmations`,
        [intentId, providerRefundId, "provider still reports the refund as not final", clock.now()],
      );
      if ((pending.rows[0]?.confirmations ?? 0) >= MAX_REFUND_CONFIRMATIONS) {
        await pool.query(
          `UPDATE payment_refund SET status = 'NEEDS_REVIEW', last_error = $2, updated_at = $3
           WHERE id = $1 AND status = 'SUBMITTED'`,
          [
            intentId,
            "provider did not confirm the refund after repeated checks; reconcile with the provider",
            clock.now(),
          ],
        );
        return { status: "NEEDS_REVIEW" };
      }
      return { status: "SUBMITTED" };
    },

    /** Refund intents whose SUBMITTED state exceeded max attempts — the
     * worker flips them to NEEDS_REVIEW (manual reconciliation; the provider
     * may have processed the refund) and records an event, so the escalation
     * is visible instead of a silent status change (B1). */
    async reconcileStaleRefundIntents(maxAttempts: number): Promise<number> {
      const stale = await pool.query<{ id: string; payment_id: string; last_error: string | null }>(
        `UPDATE payment_refund
         SET status = 'NEEDS_REVIEW',
             last_error = COALESCE(last_error, 'max execution attempts exceeded; outcome unknown'),
             updated_at = $2
         WHERE status = 'SUBMITTED' AND attempts >= $1
         RETURNING id, payment_id, last_error`,
        [maxAttempts, clock.now()],
      );
      for (const row of stale.rows) {
        await appendEvent(pool, row.payment_id, {
          eventType: "REFUND_REQUESTED",
          source: "system",
          payload: { refund_intent_id: row.id, outcome: "NEEDS_REVIEW", error: row.last_error },
        });
      }
      return stale.rows.length;
    },

    // ---- S7: inbound recovery (worker-side) --------------------------------

    /**
     * Replays inbound provider events that were persisted but not applied
     * (RECEIVED: crash between persist and apply; FAILED: transient apply
     * error) and orphan callbacks (provider type was absent and has come
     * back). AUTHENTICITY is re-verified before every apply — an event whose
     * provider contract cannot verify it is marked FAILED for good and NEVER
     * touches payment state. Reorder/parallel safety: the caller (worker)
     * claims rows FOR UPDATE SKIP LOCKED one at a time; business apply is
     * idempotent by (providerEventId/dedupKey + state machine).
     */
    async recoverInboundEvent(
      eventId: string,
    ): Promise<{ readonly applied: boolean; readonly status: string }> {
      const record = await pool.query<{
        id: string;
        source_id: string;
        raw_payload: unknown;
        transport: unknown;
        status: string;
        attempts: number;
      }>(
        `SELECT id, source_id, raw_payload, transport, status, attempts
         FROM integration_inbound_event WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const row = record.rows[0];
      if (row === undefined) {
        return { applied: false, status: "MISSING" };
      }
      // Recovery verifies against the ORIGINAL transport material (headers +
      // exact request bytes). raw_payload jsonb re-orders keys, so signature
      // verification uses `transport.raw_body` verbatim; raw_payload stays
      // the human-auditable normalized view.
      const transport = (row.transport ?? {}) as {
        readonly raw_body?: string;
        readonly headers?: Record<string, string>;
      };
      const rawBody =
        transport.raw_body ??
        (typeof row.raw_payload === "string" ? row.raw_payload : JSON.stringify(row.raw_payload));
      const recordHeaders = transport.headers;
      const instance = await instances.get(row.source_id);
      if (instance === null) {
        // Instance decommissioned: nothing to verify against; leave for the
        // operator (it is visible in diagnostics).
        return { applied: false, status: row.status };
      }
      if (providers.get(instance.providerType) === undefined) {
        return { applied: false, status: row.status }; // still absent — retry later
      }
      // Re-verify under the CURRENT credentials and config (the same resolver
      // as live inbound, never a process-env copy of an old key). Unavailable
      // credentials leave the event queued, never applied unverified.
      let wiring: Awaited<ReturnType<typeof wiringFor>>;
      try {
        wiring = await wiringFor(instance);
      } catch {
        return { applied: false, status: row.status };
      }
      const provider = wiring.provider;
      const values = { ...wiring.secrets.values };
      let parsed: ReturnType<typeof provider.parseCallback>;
      try {
        const storedHeaders = (recordHeaders ?? {}) as Record<string, string>;
        await provider.verifyCallback({ headers: storedHeaders, rawBody }, { values });
        parsed = provider.parseCallback({ headers: storedHeaders, rawBody });
      } catch {
        await pool.query(
          `UPDATE integration_inbound_event SET status = 'FAILED', error_code = 'PAYMENT_INBOUND_INVALID', attempts = attempts + 1 WHERE id = $1`,
          [eventId],
        );
        return { applied: false, status: "FAILED" };
      }
      const applied = await this.processCallback({
        providerInstanceId: instance.id,
        parsed,
        inboundEventId: eventId,
      });
      await pool.query(
        `UPDATE integration_inbound_event
         SET status = CASE WHEN $2 THEN 'PROCESSED' ELSE status END,
             error_code = NULL,
             attempts = attempts + 1,
             processed_at = CASE WHEN $2 THEN now() ELSE processed_at END
         WHERE id = $1`,
        [eventId, applied.applied],
      );
      return { applied: applied.applied, status: applied.applied ? "PROCESSED" : row.status };
    },

    /**
     * Worker claim. REQUESTED = never attempted (a money POST is due).
     *
     * SUBMITTED rows are selected by the ACTION the executor will take, not by
     * one blanket time predicate (review L1):
     *  - a known provider refund id means the next step is a READ of that
     *    object — always safe, so it needs no window and works with an unknown
     *    first-send time (the 0011 backfill retirement sets it to NULL);
     *  - without an id the executor replays the same key, which is paced by the
     *    record's own update time, never by an unproven first-send time.
     * Single-flight per payment is enforced by the DB.
     */
    async claimDueRefundIntents(limit: number, options?: { readonly dueBefore?: Date }) {
      const dueBefore = options?.dueBefore ?? null;
      const result = await pool.query<{ id: string }>(
        `SELECT r.id FROM payment_refund r
         WHERE (
             r.status = 'REQUESTED'
             OR (
               r.status = 'SUBMITTED'
               AND (
                 r.provider_refund_id IS NOT NULL
                 OR $2::timestamptz IS NULL
                 OR r.updated_at <= $2::timestamptz
               )
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM jobs j
             WHERE j.idempotency_key = 'refund-intent-' || r.id::text
               AND j.state <> 'SUCCEEDED'
           )
         ORDER BY r.created_at, r.id LIMIT $1`,
        [limit, dueBefore],
      );
      return result.rows.map((row) => row.id);
    },

    /** Worker claim: inbound events due for recovery (oldest first, bounded).
     * next_attempt_at NULL = never tried; the recovery run schedules the
     * next attempt with capped exponential backoff; attempts >= maxAttempts
     * stop surfacing (visible in Admin diagnostics as FAILED — dead-letter). */
    async claimDueInboundEvents(limit: number, maxAttempts: number) {
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM integration_inbound_event
         WHERE source_type = 'payment_provider'
           AND status IN ('RECEIVED', 'FAILED')
           AND attempts < $2
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY received_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit, maxAttempts],
      );
      return result.rows.map((row) => row.id);
    },

    async scheduleInboundRetry(eventId: string, attempts: number): Promise<void> {
      // Capped exponential backoff: 1m, 2m, 4m, 8m, 16m, 32m… max 1h.
      const seconds = Math.min(60 * 2 ** Math.min(attempts, 6), 3600);
      await pool.query(
        `UPDATE integration_inbound_event SET next_attempt_at = now() + ($2 || ' seconds')::interval WHERE id = $1`,
        [eventId, seconds],
      );
    },

    async listEvents(paymentId: string): Promise<readonly PaymentEvent[]> {
      // `seq` (insert order) makes the timeline deterministic even when many
      // events share a clock tick (fixed-clock tests, fast operators).
      const result = await pool.query<EventRow>(
        `SELECT * FROM payment_event WHERE payment_id = $1 ORDER BY seq`,
        [paymentId],
      );
      return result.rows.map(rowToEvent);
    },

    async list(options?: {
      readonly status?: PaymentStatus;
      readonly subject_type?: string;
      readonly provider_instance_id?: string;
      readonly external_id?: string;
      readonly search?: string;
      readonly created_from?: Date;
      readonly created_to?: Date;
      readonly limit?: number;
      readonly offset?: number;
    }): Promise<readonly Payment[]> {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (options?.status !== undefined) {
        params.push(options.status);
        conditions.push(`status = $${params.length}`);
      }
      if (options?.subject_type !== undefined) {
        params.push(options.subject_type);
        conditions.push(`subject_type = $${params.length}`);
      }
      // S6 Payments Admin filters (operator list views).
      if (options?.provider_instance_id !== undefined) {
        params.push(options.provider_instance_id);
        conditions.push(`provider_instance_id = $${params.length}`);
      }
      if (options?.external_id !== undefined) {
        params.push(options.external_id);
        conditions.push(`external_id = $${params.length}`);
      }
      if (options?.search !== undefined && options.search !== "") {
        params.push(`%${options.search}%`);
        const at = params.length;
        conditions.push(
          `(external_id ILIKE $${at} OR idempotency_key ILIKE $${at} OR subject_id ILIKE $${at} OR id::text ILIKE $${at})`,
        );
      }
      if (options?.created_from !== undefined) {
        params.push(options.created_from);
        conditions.push(`created_at >= $${params.length}`);
      }
      if (options?.created_to !== undefined) {
        params.push(options.created_to);
        conditions.push(`created_at < $${params.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(Math.min(options?.limit ?? 50, 200));
      params.push(Math.max(options?.offset ?? 0, 0));
      const result = await pool.query<PaymentRow>(
        `SELECT * FROM payment ${where} ORDER BY created_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return result.rows.map(rowToPayment);
    },

    // exposed for ops/corpus use
    async getByProviderAndKey(
      providerInstanceId: string,
      idempotencyKey: string,
    ): Promise<Payment | null> {
      const result = await pool.query<PaymentRow>(
        `SELECT * FROM payment WHERE provider_instance_id = $1 AND idempotency_key = $2`,
        [providerInstanceId, idempotencyKey],
      );
      return result.rows.length === 1 ? rowToPayment(result.rows[0]!) : null;
    },

    async getForUpdate(paymentId: string): Promise<Payment> {
      const payment = await getWithinTx(pool, paymentId, false);
      if (payment === null)
        throw new PaymentError("PAYMENT_NOT_FOUND", `payment ${paymentId} not found`);
      return payment;
    },

    async wiring(payment: Payment) {
      const instance = await instances.get(payment.providerInstanceId);
      if (instance === null) {
        throw new PaymentError("PAYMENT_PROVIDER_INSTANCE_NOT_FOUND", "provider instance deleted");
      }
      // Same resolver as create/refund/sync/callback: config applied, one
      // credential read, no process-env fallback for imported slots.
      return wiringFor(instance);
    },

    /** Exposed for the composition's callback verifier and the offline check:
     * the configured adapter plus this connection's resolved credentials. */
    async resolveInstanceWiring(instanceId: string) {
      const instance = await instances.get(instanceId);
      if (instance === null) {
        throw new PaymentError(
          "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
          "provider instance not found",
        );
      }
      return wiringFor(instance);
    },
  };
}

interface PaymentProviderInstanceLike {
  readonly id: string;
  readonly name: string;
  readonly providerType: string;
  readonly enabled: boolean;
  readonly config?: Record<string, unknown>;
  readonly secretRefs: Record<string, string>;
}

export interface CreatePaymentInput {
  readonly provider_instance_id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly amount: number;
  readonly currency: string;
  readonly description?: string;
  readonly idempotency_key: string;
  readonly metadata?: Record<string, unknown>;
}

export type PaymentService = ReturnType<typeof createPaymentService>;
