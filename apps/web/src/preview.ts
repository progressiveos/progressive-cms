// Preview HTTP transport (PCMS-API-T016/T029; API spec §47, M07 preview
// contract). The signed token IS the credential: no session, no bearer. The
// route never becomes a public content route, never flips pointers, and
// always emits the M07 security headers (noindex / no-referrer / no-store).

import type { ApplicationServices } from "@pcms/api";
import { PREVIEW_RESPONSE_HEADERS } from "@pcms/publication";
import type { FastifyInstance } from "fastify";

export interface PreviewRouteOptions {
  readonly application: ApplicationServices;
}

export function registerPreviewRoute(fastify: FastifyInstance, options: PreviewRouteOptions): void {
  fastify.get("/preview", async (request, reply) => {
    for (const [name, value] of Object.entries(PREVIEW_RESPONSE_HEADERS)) {
      void reply.header(name, value);
    }
    const fail = (status: number, code: string, message: string) => {
      void reply.status(status).send({ error: { code, message } });
      return reply;
    };
    const { application } = options;
    if (application.previewTokens === null) {
      return fail(503, "PREVIEW_SECRET_MISSING", "preview signing is not configured");
    }
    const query = request.query as { token?: unknown };
    if (typeof query.token !== "string" || query.token.length === 0) {
      return fail(400, "PREVIEW_TOKEN_INVALID", "preview token is required");
    }
    const verified = application.previewTokens.verify(query.token);
    if (!verified.ok) {
      return fail(404, verified.reason, "preview token rejected");
    }
    try {
      const state = await application.pool.withTransaction((executor) =>
        application.previewState.resolve(executor, verified.ref, { draft: verified.draft }),
      );
      return {
        preview: {
          ref:
            verified.ref.kind === "revision"
              ? {
                  kind: verified.ref.kind,
                  entity_type: verified.ref.entityType,
                  entity_id: verified.ref.entityId,
                  revision_id: verified.ref.revisionId,
                }
              : verified.ref.kind === "changeset"
                ? { kind: verified.ref.kind, changeset_id: verified.ref.changesetId }
                : verified.ref,
          // Candidate theme the signed render will use (null = active theme).
          theme: verified.theme ?? null,
          entities: state.entities.map((entity) => ({
            entity_type: entity.entityType,
            entity_id: entity.entityId,
            context: entity.context,
            intent: entity.intent,
            route_operation: entity.routeOperation,
            revision:
              entity.revision === null
                ? null
                : {
                    revision_id: entity.revision.revisionId,
                    payload_hash: entity.revision.payloadHash,
                    schema_version: entity.revision.schemaVersion,
                    locale: entity.revision.locale,
                    payload: entity.revision.payload,
                    sidecar: entity.revision.sidecar,
                    sealed_at: entity.revision.sealedAt.toISOString(),
                  },
          })),
        },
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "REVISION_NOT_SEALED" || code === "CHANGESET_INVALID") {
        return fail(409, code, error instanceof Error ? error.message : "preview state invalid");
      }
      return fail(404, "PREVIEW_TOKEN_INVALID", "preview target does not exist");
    }
  });
}
