// PREPUBLIC-01 §2 — the extension search-source composition seam: phase
// composition from enabled search_sources, page_ids cursor/batch contract,
// graceful vanished phases, fail-closed broken handlers and the ACTIVE-mount
// canonical route on delegated documents (CORE-SHOP-SEO-01).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeployedExtensionArtifact } from "@pcms/extensions/internal";
import type { SearchDocumentSource } from "@pcms/search";
import {
  createExtensionAwareSearchSource,
  type ExtensionSearchSourceDeps,
} from "../../packages/api/src/search-source.js";

const ENTRY_BASE: SearchDocumentSource = {
  async buildDocument(entityType, entityId) {
    return entityType === "entry" && entityId === "e1"
      ? ({
          entity_type: "entry",
          entity_id: "e1",
          context: "default",
          site_id: "default",
          locale: "en",
          content_type: "page",
          revision_id: "rev-e1",
          generation: 1,
          title: "Entry",
          summary: "",
          structured_text: "",
          body_text: "Entry",
          aux_text: "",
          route: "/e1/",
          published_at: new Date("2026-09-01T00:00:00Z"),
          modified_at: null,
        } as never)
      : null;
  },
  async listPhases() {
    return ["entry"];
  },
  async countPhase(phase) {
    if (phase !== "entry") throw new Error(`unknown phase ${phase}`);
    return 1;
  },
  async listPhaseIds(phase, after, limit) {
    if (phase !== "entry") throw new Error(`unknown phase ${phase}`);
    return { ids: after === null ? ["e1"] : [], cursor: null, ...(limit ? {} : {}) };
  },
};

function artifact(
  id: string,
  searchSources: readonly { source_id: string; handler: string; page_ids_handler: string }[],
  module: Record<string, unknown>,
): DeployedExtensionArtifact {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      extension_contract: "2.0",
      cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
      requires: [],
      provides: [],
      permissions: [],
      config_schema: undefined,
      migrations: undefined,
      data_policy: "retain",
      entrypoint: { type: "module" },
      registrations: {
        blocks: [],
        field_types: [],
        routes: [],
        event_subscriptions: [],
        validators: [],
        providers: [],
        operations: [],
        http_routes: [
          {
            method: "GET",
            path: "/widgets/:id",
            visibility: "public",
            view: "widget",
            handler: "page",
            route_id: "widget",
          },
        ],
        views: [],
        sitemap_sources: [],
        search_sources: searchSources,
        media_usage_sources: [],
      },
    } as never,
    module,
    migrationsDir: "/tmp/none",
    extensionsDir: "/tmp/none",
    contentSha256: "0".repeat(64),
  };
}

function deps(overrides: {
  readonly artifacts?: readonly DeployedExtensionArtifact[];
  readonly enabled?: readonly string[];
  readonly mountPath?: string | null;
  readonly withContext?: boolean;
}): { readonly deps: ExtensionSearchSourceDeps; readonly calls: string[] } {
  const calls: string[] = [];
  const artifacts = overrides.artifacts ?? [];
  return {
    calls,
    deps: {
      base: ENTRY_BASE,
      catalog: {
        get: (id) => artifacts.find((candidate) => candidate.manifest.id === id),
        list: () => artifacts,
      },
      enabledIds: async () => overrides.enabled ?? artifacts.map((a) => a.manifest.id),
      sourceContext: (extensionId) => {
        if (overrides.withContext === false) return null;
        calls.push(`ctx:${extensionId}`);
        return { extension: extensionId };
      },
      activeMountPath: async () => overrides.mountPath ?? null,
    },
  };
}

const shopModule = {
  async pageIds(_ctx: unknown, cursor: string | null, limit: number) {
    const all = ["w1", "w2", "w3"];
    const start = cursor === null ? 0 : all.indexOf(cursor) + 1;
    const ids = all.slice(start, start + limit);
    return { ids, cursor: start + limit < all.length ? (ids[ids.length - 1] ?? null) : null };
  },
  async build(_ctx: unknown, id: string) {
    if (id === "w-ghost") return null;
    return {
      entity_type: "shop/item",
      entity_id: id,
      context: "default",
      site_id: "default",
      locale: "en",
      content_type: "shop-item",
      revision_id: `rev-${id}`,
      generation: 1,
      title: `Widget ${id}`,
      summary: "",
      structured_text: "",
      body_text: `Widget ${id}`,
      aux_text: "",
      route: `/widgets/${id}/`,
      published_at: new Date("2026-09-01T00:00:00Z"),
      modified_at: null,
    };
  },
};

function shopArtifact(module: Record<string, unknown> = shopModule): DeployedExtensionArtifact {
  return artifact(
    "shop",
    [{ source_id: "item", handler: "build", page_ids_handler: "pageIds" }],
    module,
  );
}

test("extension source: phases compose entry-first from enabled search_sources", async () => {
  const { deps: d } = deps({
    artifacts: [shopArtifact(), artifact("idle", [], {})],
  });
  const source = createExtensionAwareSearchSource(d);
  assert.deepEqual(await source.listPhases(), ["entry", "shop/item"]);
  // Disabled extension drops out of enumeration.
  const { deps: disabled } = deps({
    artifacts: [shopArtifact()],
    enabled: [],
  });
  assert.deepEqual(await createExtensionAwareSearchSource(disabled).listPhases(), ["entry"]);
});

test("extension source: page_ids walks cursor/batch; count sums to the end", async () => {
  const { deps: d } = deps({ artifacts: [shopArtifact()] });
  const source = createExtensionAwareSearchSource(d);
  assert.equal(await source.countPhase("shop/item"), 3);
  const page = await source.listPhaseIds("shop/item", null, 2);
  assert.deepEqual(page.ids, ["w1", "w2"]);
  assert.equal(page.cursor, "w2");
  const tail = await source.listPhaseIds("shop/item", page.cursor, 2);
  assert.deepEqual(tail.ids, ["w3"]);
  assert.equal(tail.cursor, null);
});

test("extension source: vanished phase exhausts gracefully, broken handler fails closed", async () => {
  const artifactDisabled = shopArtifact();
  const { deps: d } = deps({ artifacts: [artifactDisabled], enabled: [], withContext: true });
  const source = createExtensionAwareSearchSource(d);
  // Phase disabled mid-rebuild: exhausted, no throw — finalize purges docs.
  assert.deepEqual(await source.listPhaseIds("shop/item", null, 10), { ids: [], cursor: null });
  assert.equal(await source.buildDocument("shop/item", "w1"), null);

  const broken = shopArtifact({ build: 42 }); // handler export not a function
  const { deps: brokenDeps } = deps({ artifacts: [broken] });
  await assert.rejects(
    () => createExtensionAwareSearchSource(brokenDeps).buildDocument("shop/item", "w1"),
    (error: unknown) => (error as { code?: string }).code === "EXTENSION_HANDLER_UNRESOLVED",
  );

  const malformed = shopArtifact({
    async pageIds() {
      return { items: ["x"] }; // wrong shape (legacy contract)
    },
    build: shopModule.build,
  });
  const { deps: malformedDeps } = deps({ artifacts: [malformed] });
  await assert.rejects(
    () => createExtensionAwareSearchSource(malformedDeps).listPhaseIds("shop/item", null, 10),
    (error: unknown) => (error as { code?: string }).code === "SEARCH_SOURCE_UNAVAILABLE",
  );
});

test("extension source: buildDocument delegates with the ACTIVE-mount canonical route", async () => {
  const { deps: mounted } = deps({ artifacts: [shopArtifact()], mountPath: "/shop" });
  const document = await createExtensionAwareSearchSource(mounted).buildDocument("shop/item", "w1");
  // The fixture declares a non-default locale, which prefixes the complete
  // mounted route like Core entry routes (PREPUBLIC §3).
  assert.equal((document as { route?: string }).route, "/en/shop/widgets/w1/");
  const { deps: unmounted } = deps({ artifacts: [shopArtifact()], mountPath: null });
  const technical = await createExtensionAwareSearchSource(unmounted).buildDocument(
    "shop/item",
    "w1",
  );
  assert.equal(technical, null);
  // Entry passthrough and null-derivation.
  assert.notEqual(
    await createExtensionAwareSearchSource(mounted).buildDocument("entry", "e1"),
    null,
  );
  assert.equal(
    await createExtensionAwareSearchSource(mounted).buildDocument("shop/item", "w-ghost"),
    null,
  );
  assert.equal(
    await createExtensionAwareSearchSource(mounted).buildDocument("unknown/type", "x"),
    null,
  );
});

test("extension source: real default locale, secondary locale and public-page eligibility", async () => {
  const { deps: d } = deps({ artifacts: [shopArtifact()], mountPath: "/shop" });
  const source = createExtensionAwareSearchSource({
    ...d,
    getLocalization: async () => ({ defaultLocale: "en", enabledLocales: ["en", "ru-RU"] }),
  });
  assert.equal((await source.buildDocument("shop/item", "w1"))?.route, "/shop/widgets/w1/");
  const localized = shopArtifact({
    ...shopModule,
    build: async (...args: Parameters<typeof shopModule.build>) => ({
      ...(await shopModule.build(...args)),
      locale: "ru-RU",
    }),
  });
  const { deps: ru } = deps({ artifacts: [localized], mountPath: "/shop" });
  assert.equal(
    (
      await createExtensionAwareSearchSource({
        ...ru,
        getLocalization:
          d.getLocalization ??
          (async () => ({ defaultLocale: "en", enabledLocales: ["en", "ru-RU"] })),
      }).buildDocument("shop/item", "w1")
    )?.route,
    "/ru/shop/widgets/w1/",
  );
  for (const route of ["/private/1", "/../admin", "//evil.example/a", "/widgets/%2e%2e"]) {
    const bad = shopArtifact({
      ...shopModule,
      build: async () => ({ ...(await shopModule.build(null, "w1")), route }),
    });
    const { deps: badDeps } = deps({ artifacts: [bad], mountPath: "/shop" });
    assert.equal(
      await createExtensionAwareSearchSource(badDeps).buildDocument("shop/item", "w1"),
      null,
    );
  }
});
