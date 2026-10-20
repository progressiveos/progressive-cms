// Site-developer defect report Core 0.1.144 (2026-10-01): block variants
// declared by an INSTALLED CANDIDATE theme failed content validation
// (BLOCK_VARIANT_UNSUPPORTED; discovery reported allowedVariants:[]) because
// only the active renderDir contributed variants to the block registry — and
// the preview page render silently dropped EVERY block of the document in
// response (HTTP 200, empty blocks_html).
//
// Contract after the fix (one registry, one validation point):
//   * every installed theme in the themes root (renderDir + candidates)
//     feeds its theme.json block_renderers[].variants into the registry —
//     at composition AND on every runtime /themes/install (no restart);
//   * validate / seal / preflight / candidate preview therefore accept a
//     candidate's variants BEFORE activation; the active theme, its render
//     and all editorial pointers stay untouched by preview;
//   * a variant no installed theme declares stays an error;
//   * a render facing an invalid document keeps the individually-valid
//     blocks and logs the dropped ones — never a silent blank page.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import {
  createApiFastify,
  createApiV1,
  createDraft,
  makeDiscoveryRoutes,
  makeMutationRoutes,
  makeThemeManageRoutes,
  validateRevision,
} from "@pcms/api";
import type { FastifyInstance } from "fastify";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_THEME = join(process.cwd(), "themes", "reference-theme-v1");
const OWNER_CTX = (): OperationContext =>
  apiContextOf(ownerActor("variant-seeder"), "rest", "req_owner");

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
  withContext: () => silentLogger,
};

/** Candidate package source: the reference theme with a new id, a gallery@1
 * variant set and a marker attribute in gallery.liquid proving the
 * candidate's own renderer handled the variant. */
function candidateThemeDir(stage: string): string {
  const dir = join(stage, "candidate-b");
  cpSync(REFERENCE_THEME, dir, { recursive: true });
  const manifestPath = join(dir, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    id: string;
    name: string;
    block_renderers: { block: string; variants?: string[] }[];
  };
  manifest.id = "candidate-b";
  manifest.name = "Candidate B";
  for (const renderer of manifest.block_renderers) {
    if (renderer.block === "gallery@1") renderer.variants = ["hero-worlds", "admin-proof"];
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const galleryPath = join(dir, "blocks", "gallery.liquid");
  writeFileSync(
    galleryPath,
    readFileSync(galleryPath, "utf8").replace(
      '<figure class="block block-gallery">',
      '<figure class="block block-gallery" data-gallery-variant="{{ block.variant }}">',
    ),
  );
  return dir;
}

async function zipDirOf(dir: string): Promise<Buffer> {
  const { default: Yazl } = await import("yazl");
  const zip = new Yazl.ZipFile();
  const walk = (prefix: string, absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(name, child);
      else zip.addBuffer(readFileSync(child), name);
    }
  };
  walk("", dir);
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

const HEADING_BLOCK = {
  id: "0198c0de-0000-7000-8000-0000000000a2",
  type: "heading",
  schema_version: 1,
  variant: null,
  props: { text: "Кандидатский заголовок", level: 2 },
  children: [],
};

const GALLERY_BLOCK = {
  id: "0198c0de-0000-7000-8000-0000000000a1",
  type: "gallery",
  schema_version: 1,
  variant: "admin-proof",
  props: {
    items: [
      {
        id: "0198c0de-0000-7000-8000-0000000000b1",
        media_id: "0198c0de-0000-7000-8000-0000000000c1",
      },
    ],
    layout_hint: "grid",
    lightbox_enabled: true,
  },
  children: [],
};

test("candidate theme variants validate and preview before activation; no silent block loss", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const stage = mkdtempSync(join(tmpdir(), "pcms-candidate-variants-"));
  t.after(() => rmSync(stage, { recursive: true, force: true }));

  // Active theme A: the reference theme copied into a private themes root
  // (the /themes/install route derives the root from dirname(themeDir), so
  // the candidate must install next to a COPIED render target, never into
  // the repository tree).
  const activeDir = join(stage, "reference-theme-v1");
  cpSync(REFERENCE_THEME, activeDir, { recursive: true });

  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "block_document",
        fields: {
          title: { id: "title", type: "string", required: true, sortable: true },
        },
      },
    ],
    themeDir: activeDir,
  });
  const fastify: FastifyInstance = createApiFastify(() => "req_candidate");
  await fastify.register(
    createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes(), ...makeThemeManageRoutes()]),
    { application: app, logger: silentLogger as never, cookieSecure: false },
  );
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  const activeThemeId = app.themeDiscovery?.getThemeId() ?? "reference-theme-v1";

  // Install candidate B through the real HTTP surface — the runtime variant
  // extension lives on that route (no restart, no composition rerun).
  const themeToken = await app.machineIdentity.createAccessToken({
    serviceAccountId: (
      await app.machineIdentity.createServiceAccount({
        name: "theme-installer",
        purpose: "candidate variant regression",
        allowedScopes: ["theme.write", "theme.read", "content.read"],
      })
    ).id,
    scopes: ["theme.write", "theme.read", "content.read"],
    ttlMilliseconds: 3_600_000,
  });
  const bytes = await zipDirOf(candidateThemeDir(stage));
  const installed = await fastify.inject({
    method: "POST",
    url: "/api/v1/themes/install",
    headers: {
      authorization: `Bearer ${themeToken.rawSecret}`,
      "content-type": "application/octet-stream",
    },
    payload: bytes,
  });
  assert.equal(installed.statusCode, 201, installed.body);

  // 1. The candidate's variant passes revision validation (was
  //    BLOCK_VARIANT_UNSUPPORTED in 0.1.144).
  const working = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: {
      fields: { title: "Кандидатская страница" },
      blocks: { schema_version: 1, blocks: [HEADING_BLOCK, GALLERY_BLOCK] },
    },
  });
  const passed = await validateRevision(app, OWNER_CTX(), { revision_id: working.revision_id });
  assert.equal(passed.ok, true, JSON.stringify(passed.issues));

  // 2. Discovery reports the candidate's variants.
  const discovery = await fastify.inject({
    method: "GET",
    url: "/api/v1/discovery/blocks/gallery",
    headers: { authorization: `Bearer ${themeToken.rawSecret}` },
  });
  assert.equal(discovery.statusCode, 200, discovery.body);
  const schema = discovery.json() as { allowedVariants: readonly string[] };
  assert.ok(schema.allowedVariants.includes("admin-proof"), discovery.body);

  // 3. Candidate preview renders EVERY block (allow_draft WORKING render,
  // signed for the candidate theme). Editorial state stays untouched.
  const snapshot = async (): Promise<readonly { id: string; state: string }[]> => {
    const result = await app.pool.query<{ id: string; state: string }>(
      "SELECT id, state FROM revisions WHERE entity_type = 'entry' AND entity_id = $1 ORDER BY revision_no",
      [working.entry_id],
    );
    return result.rows;
  };
  const before = await snapshot();
  assert.ok(app.previewTokens);
  const token = app.previewTokens.issue(
    {
      kind: "revision",
      entityType: "entry",
      entityId: working.entry_id as never,
      revisionId: working.revision_id as never,
    },
    { draft: true, theme: "candidate-b" },
  );
  const page = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(token)}`,
  });
  assert.equal(page.statusCode, 200, page.body.slice(0, 400));
  assert.ok(page.body.includes("Кандидатский заголовок"), page.body.slice(0, 800));
  assert.ok(page.body.includes("block-gallery"), page.body.slice(0, 800));
  assert.ok(
    page.body.includes('data-gallery-variant="admin-proof"'),
    "the candidate's own gallery renderer must handle the variant",
  );
  assert.deepEqual(await snapshot(), before, "preview must not touch revisions");

  // The active theme still is A; the candidate never activated.
  assert.equal(app.themeDiscovery?.getThemeId(), activeThemeId);
  const activeRows = await app.pool.query<{ theme_key: string | null }>(
    "SELECT theme_key FROM admin_theme_state",
  );
  assert.ok(activeRows.rows.every((row) => row.theme_key !== "candidate-b"));

  // 4. The same WORKING revision against the ACTIVE theme A keeps its valid
  // blocks and drops only the variant A cannot render — a reported drop,
  // never a silent blank page (the 0.1.144 behavior dropped EVERYTHING).
  const activeToken = app.previewTokens.issue(
    {
      kind: "revision",
      entityType: "entry",
      entityId: working.entry_id as never,
      revisionId: working.revision_id as never,
    },
    { draft: true },
  );
  const activePage = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(activeToken)}`,
  });
  assert.equal(activePage.statusCode, 200, activePage.body.slice(0, 400));
  assert.ok(activePage.body.includes("Кандидатский заголовок"));
  assert.ok(!activePage.body.includes("block-gallery"));

  // 5. A variant no installed theme declares remains an error.
  const unknown = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: {
      fields: { title: "Неизвестный вариант" },
      blocks: {
        schema_version: 1,
        blocks: [
          {
            ...GALLERY_BLOCK,
            id: "0198c0de-0000-7000-8000-0000000000a3",
            variant: "does-not-exist",
          },
        ],
      },
    },
  });
  const failed = await validateRevision(app, OWNER_CTX(), { revision_id: unknown.revision_id });
  assert.equal(failed.ok, false);
  assert.ok(
    failed.issues.some((issue) => (issue as { code: string }).code === "BLOCK_VARIANT_UNSUPPORTED"),
    JSON.stringify(failed.issues),
  );
});
