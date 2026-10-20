// .pcpub ingest REST transport (PCMS-PCPUB E5/E8; ADR-0014, API spec §81).
// Raw bounded upload → application operation; status is a safe read of the
// ingest ledger. No binary MCP tool exists by design — this route and the
// CLI/Admin are the only apply paths.
import type { FastifyRequest } from "fastify";
import type { ApplicationServices, OperationContext } from "../../context.js";
import { ApiError } from "../../errors.js";
import {
  getPcpubIngestStatus,
  listPcpubIngests,
  receivePcpub,
  validatePcpubBytes,
} from "../../pcpub-ingest.js";
import { API_BODY_LIMIT_PCPUB } from "../../pcpub-limits.js";
import type { ApiRoute } from "../registry.js";

const PCPUB_MIME = "application/vnd.progressive-cms.pcpub+zip";

const INGEST_ID_PARAM = {
  type: "object",
  additionalProperties: false,
  required: ["ingestId"],
  properties: {
    ingestId: {
      type: "string",
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    },
  },
} as const;

const MODE_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: { mode: { enum: ["validate", "apply"] } },
} as const;

function bodyBytes(request: FastifyRequest): Buffer {
  const body = request.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new ApiError("PCPUB_ARCHIVE_UNREADABLE", `a raw ${PCPUB_MIME} body is required`, {
      status: 400,
    });
  }
  return body;
}

export function makePcpubBundleRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "POST",
        url: "/bundles/pcpub",
        operationId: "ingest_publication_bundle",
        summary:
          "Ingest a .pcpub bundle (raw ZIP body). ?mode=validate reports issues with zero writes; apply is async (202 + status URL)",
        tag: "bundle",
        auth: "authenticated",
        permission: "content.create",
        bodyLimit: API_BODY_LIMIT_PCPUB,
        querySchema: MODE_QUERY,
      },
      async handle(app, ctx, request) {
        const bytes = bodyBytes(request);
        const query = (request.query ?? {}) as { mode?: "validate" | "apply" };
        if (query.mode === "validate") {
          return { status: 200, body: await validatePcpubBytes(app, bytes, ctx) };
        }
        const received = await receivePcpub(app, ctx, bytes);
        return { status: received.replayed ? 200 : 202, body: received };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/bundles/pcpub/ingests",
        operationId: "list_publication_bundle_ingests",
        summary:
          "Recent ingests, newest first (own ingests unless the caller holds publication.plan). Recovers an ingest id lost with a submit stdout.",
        tag: "bundle",
        auth: "authenticated",
      },
      async handle(app, ctx, request) {
        const query = (request.query ?? {}) as { limit?: unknown };
        const limitRaw = Number(query.limit ?? 20);
        const limit =
          Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 20;
        return { status: 200, body: await listPcpubIngests(app, ctx, limit) };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/bundles/pcpub/ingests/:ingestId",
        operationId: "get_publication_bundle_ingest",
        summary: "Ingest status: stage, outcome, diagnostics and result links",
        tag: "bundle",
        auth: "authenticated",
        paramsSchema: INGEST_ID_PARAM,
      },
      async handle(app, ctx, request) {
        const params = request.params as { ingestId: string };
        return {
          status: 200,
          body: await getPcpubIngestStatus(app, ctx, params.ingestId),
        };
      },
    },
  ];
}
