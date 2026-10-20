// Analytics browser-fixture server: boots the REAL composition (api fixture
// + site render + analytics settings) against a disposable database so the
// Playwright spec exercises the true planner → slots → CSP pipeline.
// Prints "READY <port>" on stdout; the spec spawns it and waits for that.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiFastify, createApiV1, makeAnalyticsRoutes } from "@pcms/api";
import { apiContextOf, createApiFixture, scopedActor } from "../helpers/api-composition.js";

const REFERENCE_TYPES = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
) as { contentTypes: never };

const root = mkdtempSync(join(tmpdir(), "pcms-analytics-browser-"));
mkdirSync(join(root, "media"), { recursive: true });
const cleanups: (() => void)[] = [];
const t = { after: (fn: () => void) => void cleanups.push(fn) };
const { app } = await createApiFixture(t, {
  contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
  themeDir: "themes/reference-theme-v1",
  seoEnvironment: "production",
  mediaRoots: { storage: join(root, "media"), quarantine: join(root, "q") },
});
function t2() {}
const ctx = apiContextOf(
  scopedActor(["content.create", "content.edit", "revision.seal", "publication.publish"]),
);
const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
const site = await app.routes.ensureSite(app.defaultSiteKey);
const draft = await createDraft(app, ctx, {
  content_type: "page",
  payload: {
    fields: { title: "Analytics fixture" },
    blocks: {
      schema_version: 1,
      blocks: [
        {
          id: "01990000-0000-7000-8000-0000000000a1",
          type: "cta",
          schema_version: 1,
          variant: null,
          props: {
            title: "Call us",
            primary_action: { type: "phone", phone: "+7 900 000-00-00" },
          },
          children: [],
        },
      ],
    },
  },
});
await sealRevision(app, ctx, { revision_id: draft.revision_id });
await publishRevision(app, ctx, {
  entity_type: "entry",
  entity_id: draft.entry_id,
  target_revision_id: draft.revision_id,
  expected_generation: 0,
});
await app.routes.setHomeEntry(site.id, draft.entry_id);

const { saveAnalyticsSettingsOp } = await import("@pcms/api");
await saveAnalyticsSettingsOp(
  app,
  apiContextOf(scopedActor(["analytics.manage", "analytics.network.manage"])),
  {
    settings: {
      schemaVersion: 1,
      providers: {
        yandex_metrica: {
          enabled: true,
          counterId: "12345678",
          webvisor: true,
          clickmap: true,
          trackLinks: true,
          accurateTrackBounce: true,
          ecommerce: false,
          sendTitle: true,
          activationPolicy: "immediate",
        },
        google_analytics_4: { enabled: false, measurementId: null, activationPolicy: "immediate" },
        google_tag_manager: {
          enabled: true,
          containerId: "GTM-ABC1234",
          activationPolicy: "marketing_consent",
        },
      },
      networkRules: [
        {
          id: "dni",
          label: "Mock DNI provider",
          origin: "https://vendor.example",
          directives: ["script-src", "connect-src"],
        },
      ],
    },
    expected_generation: 0,
  },
);

const fastify = createApiFastify(() => "req_browser");
const routes = [...makeAnalyticsRoutes()];
await fastify.register(createApiV1(routes), {
  application: app,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
  cookieSecure: false,
});
const { registerSiteRoute } = await import("../../apps/web/src/site.js");
await registerSiteRoute(fastify, { application: app });
// Theme public assets (the real surface mounts these; the fixture mirrors
// them so the page loads its css/js like production).
const MIME: Record<string, string> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};
fastify.get("/themes/reference-theme-v1/assets/*", async (request, reply) => {
  const relative = (request.params as { "*": string })["*"];
  if (relative.includes("..")) return reply.status(404).send();
  try {
    const bytes = readFileSync(join("themes/reference-theme-v1/assets", relative));
    return reply
      .header(
        "content-type",
        MIME[join(relative).slice(join(relative).lastIndexOf("."))] ?? "application/octet-stream",
      )
      .send(bytes);
  } catch {
    return reply.status(404).send();
  }
});
await fastify.listen({ port: 0, host: "127.0.0.1" });
const address = fastify.server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
console.log(`READY ${port}`);
process.on("SIGTERM", () => {
  void fastify.close().then(() => {
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  });
});
