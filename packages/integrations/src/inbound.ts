// Inbound endpoints + InboundEvent persistence (PCMS-INT-T012/T013;
// Integrations spec §22–§25). Pipeline: receive → verify → persist with
// dedup → normalize. A duplicate provider callback hits the
// (source_type, source_id, dedup_key) unique key and never reaches domain
// processing again. Raw provider payloads may contain PII/secrets: they
// are stored ONLY in this protected table (bounded size, bounded
// retention) and are never logged — log lines carry safe metadata only.
import { createHash } from "node:crypto";
import { type Clock, type DbPool, newStableId, type StableId } from "@pcms/core";
import { IntegrationError } from "./errors.js";

/** The part of an inbound HTTP call the contract may inspect. */
export interface InboundRequestView {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
}

/**
 * Per-endpoint contract (spec §22): instance + verifier + payload limit +
 * provider event id extraction + parser/normalizer. Registered by
 * connectors or payment providers at composition time; credential
 * resolution closes over the composition's secret channel (per-instance
 * secret refs are resolved there), so this L1 surface stays credential-
 * blind.
 */
export interface InboundEndpointContract {
  /** Hard cap for the raw provider body (bytes). */
  readonly payloadLimitBytes: number;
  /** Authenticates the call; throws INTEGRATION_INBOUND_INVALID on failure. */
  verify(request: InboundRequestView, context: { readonly sourceId: string }): void | Promise<void>;
  /** Provider event id when the protocol carries one; null → fingerprint. */
  extractEventId(request: InboundRequestView): string | null;
  /** Normalizer: safe derived shape only (never the raw payload). */
  parse(request: InboundRequestView): { readonly eventType: string; readonly normalized: unknown };
}

/** source key → contract (e.g. "payment_provider:<providerType>"). */
export class InboundContractRegistry {
  private readonly contracts = new Map<string, InboundEndpointContract>();

  register(key: string, contract: InboundEndpointContract): void {
    this.contracts.set(key, contract);
  }

  get(key: string): InboundEndpointContract | undefined {
    return this.contracts.get(key);
  }
}

export interface InboundRecord {
  readonly id: StableId;
  readonly sourceType: "integration_instance" | "payment_provider";
  readonly sourceId: string;
  readonly providerEventId: string | null;
  readonly dedupKey: string;
  readonly payloadHash: string;
  readonly eventType: string | null;
  readonly status: "RECEIVED" | "PROCESSED" | "FAILED";
  readonly errorCode: string | null;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
}

export interface InboundReceiveResult {
  /** True when this exact event was already recorded — side effects must be skipped. */
  readonly duplicate: boolean;
  readonly record: InboundRecord;
  readonly eventType: string | null;
  readonly normalized: unknown;
}

interface InboundRow {
  [column: string]: unknown;
  id: string;
  source_type: string;
  source_id: string;
  provider_event_id: string | null;
  dedup_key: string;
  payload_hash: string;
  event_type: string | null;
  status: "RECEIVED" | "PROCESSED" | "FAILED";
  error_code: string | null;
  received_at: Date;
  processed_at: Date | null;
}

function rowToRecord(row: InboundRow): InboundRecord {
  return {
    id: row.id as StableId,
    sourceType: row.source_type as InboundRecord["sourceType"],
    sourceId: row.source_id,
    providerEventId: row.provider_event_id,
    dedupKey: row.dedup_key,
    payloadHash: row.payload_hash,
    eventType: row.event_type,
    status: row.status,
    errorCode: row.error_code,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}

const MAX_PROVIDER_EVENT_ID = 300;
const DEFAULT_RETENTION_DAYS = 7;

export function createInboundService(deps: {
  pool: DbPool;
  clock: Clock;
  contracts: InboundContractRegistry;
}) {
  const { pool, clock, contracts } = deps;

  async function insert(input: {
    readonly sourceType: InboundRecord["sourceType"];
    readonly sourceId: string;
    readonly providerEventId: string | null;
    readonly dedupKey: string;
    readonly payloadHash: string;
    readonly eventType: string | null;
    readonly rawBody: string;
    readonly status: InboundRecord["status"];
    readonly errorCode: string | null;
  }): Promise<InboundRecord> {
    const result = await pool.query<InboundRow>(
      `INSERT INTO integration_inbound_event
         (id, source_type, source_id, provider_event_id, dedup_key, payload_hash,
          event_type, raw_payload, status, error_code, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               CASE WHEN $10::boolean THEN $8::jsonb ELSE NULL END, $9, $11, $12)
       ON CONFLICT (source_type, source_id, dedup_key) DO NOTHING
       RETURNING *`,
      [
        newStableId(),
        input.sourceType,
        input.sourceId,
        input.providerEventId,
        input.dedupKey,
        input.payloadHash,
        input.eventType,
        input.rawBody,
        input.status,
        true,
        input.errorCode,
        clock.now(),
      ],
    );
    if (result.rows.length === 1) return rowToRecord(result.rows[0]!);
    const existing = await pool.query<InboundRow>(
      `SELECT * FROM integration_inbound_event
       WHERE source_type = $1 AND source_id = $2 AND dedup_key = $3`,
      [input.sourceType, input.sourceId, input.dedupKey],
    );
    return rowToRecord(existing.rows[0]!);
  }

  return {
    contractFor(sourceType: InboundRecord["sourceType"], providerType: string) {
      return contracts.get(`${sourceType}:${providerType}`);
    },

    /**
     * Retains a callback that arrived for a provider with NO registered
     * contract (extension disabled/uninstalled — S6 lifecycle policy).
     * Fail-closed for state (nothing is applied) but NEVER lost: the raw
     * payload is persisted FAILED with the reason, so the S7 recovery
     * worker (or a provider retry after re-composition) can replay it.
     */
    async receiveOrphan(input: {
      readonly sourceType: InboundRecord["sourceType"];
      readonly sourceId: string;
      readonly rawBody: string;
      readonly reason: string;
    }): Promise<InboundRecord> {
      const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");
      return insert({
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        providerEventId: null,
        dedupKey: `orphan:${payloadHash}`,
        payloadHash,
        eventType: null,
        rawBody: input.rawBody,
        status: "FAILED",
        errorCode: input.reason.slice(0, 160),
      });
    },

    /**
     * Receive → verify → persist/dedup → normalize (spec §34 pipeline steps
     * 1–4; the caller continues with domain processing only when
     * `duplicate === false`).
     */
    async receive(input: {
      readonly sourceType: InboundRecord["sourceType"];
      readonly sourceId: string;
      readonly contractKey: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly rawBody: string;
    }): Promise<InboundReceiveResult> {
      const contract = contracts.get(input.contractKey);
      if (contract === undefined) {
        throw new IntegrationError(
          "INTEGRATION_INBOUND_INVALID",
          `no inbound contract registered for "${input.contractKey}"`,
        );
      }
      if (Buffer.byteLength(input.rawBody, "utf8") > contract.payloadLimitBytes) {
        throw new IntegrationError(
          "INTEGRATION_INBOUND_PAYLOAD_TOO_LARGE",
          `payload exceeds ${contract.payloadLimitBytes} bytes`,
        );
      }
      const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");
      try {
        await contract.verify(
          { headers: input.headers, rawBody: input.rawBody },
          { sourceId: input.sourceId },
        );
      } catch (error) {
        // Verification failure: not persisted as a receivable event (the
        // call was not authentic); safe diagnostic only, raw body dropped.
        throw new IntegrationError(
          "INTEGRATION_INBOUND_INVALID",
          error instanceof Error ? error.message.slice(0, 160) : "verification failed",
        );
      }
      const providerEventId = contract.extractEventId({
        headers: input.headers,
        rawBody: input.rawBody,
      });
      const dedupKey =
        providerEventId === null
          ? `sha256:${payloadHash}`
          : `evt:${providerEventId.slice(0, MAX_PROVIDER_EVENT_ID)}`;

      // Pre-check for the duplicate path (keeps the raw body out of the DB
      // when the event is already known).
      const existing = await pool.query<InboundRow>(
        `SELECT * FROM integration_inbound_event
         WHERE source_type = $1 AND source_id = $2 AND dedup_key = $3`,
        [input.sourceType, input.sourceId, dedupKey],
      );
      if (existing.rows.length === 1) {
        const record = rowToRecord(existing.rows[0]!);
        return { duplicate: true, record, eventType: record.eventType, normalized: null };
      }

      let eventType: string | null = null;
      let normalized: unknown = null;
      let status: InboundRecord["status"] = "RECEIVED";
      let errorCode: string | null = null;
      try {
        const parsed = contract.parse({ headers: input.headers, rawBody: input.rawBody });
        eventType = parsed.eventType;
        normalized = parsed.normalized;
      } catch (error) {
        status = "FAILED";
        errorCode = "INTEGRATION_INBOUND_INVALID";
        void error; // never persist/log the failing body itself
      }
      const record = await insert({
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        providerEventId,
        dedupKey,
        payloadHash,
        eventType,
        rawBody: input.rawBody,
        status,
        errorCode,
      });
      // Opportunistic bounded retention (spec §25): old raw payloads are
      // nulled; metadata/history remains. One indexed DELETE-free UPDATE.
      await pool.query(
        `UPDATE integration_inbound_event SET raw_payload = NULL
         WHERE raw_payload IS NOT NULL
           AND received_at < $1::timestamptz - ($2 || ' days')::interval`,
        [clock.now(), String(DEFAULT_RETENTION_DAYS)],
      );
      return { duplicate: false, record, eventType, normalized };
    },

    async markProcessed(id: string): Promise<void> {
      await pool.query(
        `UPDATE integration_inbound_event
         SET status = 'PROCESSED', processed_at = $2, error_code = NULL
         WHERE id = $1 AND status = 'RECEIVED'`,
        [id, clock.now()],
      );
    },

    async markFailed(id: string, errorCode: string): Promise<void> {
      await pool.query(
        `UPDATE integration_inbound_event
         SET status = 'FAILED', processed_at = $2, error_code = $3
         WHERE id = $1 AND status = 'RECEIVED'`,
        [id, clock.now(), errorCode.slice(0, 120)],
      );
    },

    async list(options?: {
      readonly sourceType?: InboundRecord["sourceType"];
      readonly sourceId?: string;
      readonly status?: InboundRecord["status"];
      readonly limit?: number;
    }): Promise<readonly InboundRecord[]> {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (options?.sourceType !== undefined) {
        params.push(options.sourceType);
        conditions.push(`source_type = $${params.length}`);
      }
      if (options?.sourceId !== undefined) {
        params.push(options.sourceId);
        conditions.push(`source_id = $${params.length}`);
      }
      if (options?.status !== undefined) {
        params.push(options.status);
        conditions.push(`status = $${params.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(Math.min(options?.limit ?? 50, 200));
      const rows = await pool.query<InboundRow>(
        // Raw payloads are never part of listings (permission surface).
        `SELECT id, source_type, source_id, provider_event_id, dedup_key, payload_hash,
                event_type, status, error_code, received_at, processed_at
         FROM integration_inbound_event ${where} ORDER BY received_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.rows.map(rowToRecord);
    },

    /** Explicit retention sweep (also invoked opportunistically). */
    async enforceRetention(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<number> {
      const result = await pool.query<{ id: string }>(
        `UPDATE integration_inbound_event SET raw_payload = NULL
         WHERE raw_payload IS NOT NULL
           AND received_at < $1::timestamptz - ($2 || ' days')::interval
         RETURNING id`,
        [clock.now(), String(Math.max(0, retentionDays))],
      );
      return result.rows.length;
    },
  };
}
