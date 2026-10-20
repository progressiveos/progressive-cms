// Candidate preview (PCMS-PUB-T016/T017): a preview token never creates a
// public pointer, never enters canonical routes/sitemap, and expiry has no
// effect on public state (spec §45–§48). Tokens are HMAC-signed, expiry- and
// scope-carrying, tamper-rejecting; secrets arrive through the M01 secret
// channel, never hard-coded; raw tokens must never be logged (the core
// logger's secret-shape redaction covers `token`-shaped keys — pinned in
// tests).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DbClient, StableId } from "@pcms/core";
import type { ChangeSetService } from "./changesets.js";
import { PublicationError } from "./errors.js";
import type { RevisionReaderPort, SealedRevisionRef } from "./ports.js";

export type PreviewRef =
  | {
      readonly kind: "revision";
      readonly entityType: string;
      readonly entityId: StableId;
      readonly revisionId: StableId;
    }
  | { readonly kind: "changeset"; readonly changesetId: StableId }
  | {
      readonly kind: "service";
      readonly template: "search" | "error-404";
      readonly locale?: string;
    };

export interface PreviewTokenService {
  /** Opaque signed token; carries scope + expiry, contains no secrets.
   * `theme` (2026-10-01 site-developer request): a candidate theme id for
   * /preview page renders — signed so a token can never name an arbitrary
   * filesystem path. */
  issue(ref: PreviewRef, options?: { readonly draft?: boolean; readonly theme?: string }): string;
  verify(token: string):
    | {
        readonly ok: true;
        readonly ref: PreviewRef;
        readonly draft: boolean;
        readonly theme?: string;
      }
    | {
        readonly ok: false;
        readonly reason: "PREVIEW_TOKEN_INVALID" | "PREVIEW_TOKEN_EXPIRED";
      };
}

export function createPreviewTokenService(deps: {
  /** HMAC key from the secrets channel (fail-secure: empty/missing rejects at
   * construction — PREVIEW_SECRET_MISSING). */
  readonly secret: string;
  readonly ttlMilliseconds: number;
  readonly clock: { readonly now: () => Date };
}): PreviewTokenService {
  if (deps.secret.length < 32) {
    throw new PublicationError(
      "PREVIEW_SECRET_MISSING",
      "preview token secret missing or too short (need >= 32 chars)",
    );
  }
  // The payload is a fixed-shape object built below; JSON.stringify is
  // deterministic for it (no L1 import of the revisions canonicalizer).
  const encoded = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const decoded = (value: string) =>
    JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v: number;
      r: PreviewRef;
      e: number;
      d?: number;
      t?: string;
    };
  const sign = (payload: string) =>
    createHmac("sha256", deps.secret).update(payload).digest("base64url");

  return {
    issue(ref, options) {
      const exp = deps.clock.now().getTime() + deps.ttlMilliseconds;
      const payload = encoded({
        v: 1,
        r: ref,
        e: exp,
        ...(options?.draft === true ? { d: 1 } : {}),
        ...(options?.theme === undefined ? {} : { t: options.theme }),
      });
      return `${payload}.${sign(payload)}`;
    },
    verify(token) {
      const parts = token.split(".");
      if (parts.length !== 2) return { ok: false, reason: "PREVIEW_TOKEN_INVALID" };
      const [payload, signature] = parts as [string, string];
      const expected = Buffer.from(sign(payload));
      let provided: Buffer;
      try {
        provided = Buffer.from(signature);
      } catch {
        return { ok: false, reason: "PREVIEW_TOKEN_INVALID" };
      }
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return { ok: false, reason: "PREVIEW_TOKEN_INVALID" };
      }
      let parsed: { v: number; r: PreviewRef; e: number; d?: number; t?: string };
      try {
        parsed = decoded(payload);
      } catch {
        return { ok: false, reason: "PREVIEW_TOKEN_INVALID" };
      }
      if (parsed.v !== 1 || parsed.r === undefined || typeof parsed.e !== "number") {
        return { ok: false, reason: "PREVIEW_TOKEN_INVALID" };
      }
      if (parsed.e < deps.clock.now().getTime()) {
        return { ok: false, reason: "PREVIEW_TOKEN_EXPIRED" };
      }
      return {
        ok: true,
        ref: parsed.r,
        draft: parsed.d === 1,
        ...(parsed.t === undefined ? {} : { theme: parsed.t }),
      };
    },
  };
}

/**
 * Response headers a preview transport MUST emit (M09 mounts them; the
 * contract and enforcement live here). Preview is never indexable and never
 * leaks via referrer.
 */
export const PREVIEW_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
};

export interface PreviewEntityState {
  readonly entityType: string;
  readonly entityId: StableId;
  readonly context: string;
  readonly intent: "PUBLISH" | "UNPUBLISH";
  readonly revision: SealedRevisionRef | null;
  readonly routeOperation: unknown;
}

export interface PreviewState {
  readonly ref: PreviewRef;
  /** Every candidate entity resolved TOGETHER (spec §48): a changeset
   * preview never mixes a new Entry against the old current Navigation if
   * the ChangeSet contains a new Navigation. */
  readonly entities: readonly PreviewEntityState[];
  readonly resolvedAt: Date;
}

export interface PreviewStateResolver {
  resolve(
    executor: DbClient,
    ref: PreviewRef,
    options?: { readonly draft?: boolean },
  ): Promise<PreviewState>;
}

export function createPreviewStateResolver(deps: {
  readonly revisions: RevisionReaderPort;
  readonly changesets: ChangeSetService;
  readonly clock: { readonly now: () => Date };
}): PreviewStateResolver {
  return {
    async resolve(executor, ref, options) {
      if (ref.kind === "revision") {
        // Single-revision preview resolves through the revisions port — the
        // publication package never touches another package's tables.
        let revision = await deps.revisions.getSealedRevision(
          executor,
          ref.entityType,
          ref.entityId,
          ref.revisionId,
        );
        if (
          revision === null &&
          options?.draft === true &&
          deps.revisions.getWorkingRevision !== undefined
        ) {
          // Draft preview (2026-09-29): the token was issued by an actor
          // holding content.edit — render the WORKING revision without
          // sealing it (seal stays the gate to publication).
          revision = await deps.revisions.getWorkingRevision(
            executor,
            ref.entityType,
            ref.entityId,
            ref.revisionId,
          );
        }
        if (revision === null) {
          throw new PublicationError("REVISION_NOT_SEALED", "preview target is not sealed");
        }
        return {
          ref,
          entities: [
            {
              entityType: ref.entityType,
              entityId: ref.entityId,
              context: revision.locale,
              intent: "PUBLISH",
              revision,
              routeOperation: { kind: "none" },
            },
          ],
          resolvedAt: deps.clock.now(),
        };
      }
      if (ref.kind === "service") {
        return { ref, entities: [], resolvedAt: deps.clock.now() };
      }
      const changeset = await deps.changesets.requireChangeset(ref.changesetId);
      if (changeset.state === "CANCELLED") {
        throw new PublicationError(
          "CHANGESET_INVALID",
          "changeset preview: changeset is cancelled",
        );
      }
      const items = await deps.changesets.listItems(ref.changesetId);
      const entities: PreviewEntityState[] = [];
      for (const item of items) {
        const revision =
          item.targetRevisionId === null
            ? null
            : await deps.revisions.getSealedRevision(
                executor,
                item.entityType,
                item.entityId,
                item.targetRevisionId,
              );
        entities.push({
          entityType: item.entityType,
          entityId: item.entityId,
          context: item.context,
          intent: item.intent,
          revision,
          routeOperation: item.routeOperation,
        });
      }
      return { ref, entities, resolvedAt: deps.clock.now() };
    },
  };
}
