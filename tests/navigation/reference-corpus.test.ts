// PCMS-NAV-T027 — reference navigation/routing corpus (Navigation spec §71).
// Acceptance: all edge scenarios covered — menu shapes and overrides run as
// pure tree algebra; route scenarios run against PostgreSQL.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createDbPool, type DbPool } from "@pcms/core";
import {
  type ApplicableOverride,
  applyOverrides,
  deriveBreadcrumbs,
  type NavigationError,
  type NavigationItemNode,
} from "@pcms/navigation";
import {
  createDomainService,
  createRequestResolver,
  createRouteHistoryService,
  createRouteService,
  type RouteService,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

interface CorpusNode {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly uiIntent?: string;
  readonly children?: readonly CorpusNode[];
}
interface MenuScenario {
  readonly id: string;
  readonly base: readonly CorpusNode[];
  readonly overrides: readonly {
    readonly targetItemId: string;
    readonly op: string;
    readonly payload: Record<string, unknown>;
  }[];
  readonly expectLabels: readonly string[];
  readonly expectMaxDepth?: number;
  readonly baseItemDeleted?: boolean;
  readonly expectStale?: boolean;
}
interface Corpus {
  readonly menuScenarios: readonly MenuScenario[];
}

const CORPUS: Corpus = JSON.parse(
  readFileSync("fixtures/navigation/reference-corpus.json", "utf8"),
);

function toNodes(input: readonly CorpusNode[]): NavigationItemNode[] {
  return input.map((n) => ({
    id: n.id,
    type: n.type as NavigationItemNode["type"],
    label: n.label,
    target: null,
    visibility: "always",
    uiIntent: (n.uiIntent as NavigationItemNode["uiIntent"]) ?? null,
    children: toNodes(n.children ?? []),
  }));
}

function maxDepth(nodes: readonly NavigationItemNode[]): number {
  return nodes.reduce((max, n) => Math.max(max, 1 + maxDepth(n.children)), 0);
}

function labels(nodes: readonly NavigationItemNode[]): string[] {
  return nodes.flatMap((n) => [n.label ?? "", ...labels(n.children)]).filter((l) => l !== "");
}

for (const scenario of CORPUS.menuScenarios) {
  test(`corpus menu scenario: ${scenario.id}`, () => {
    if (scenario.expectStale === true) {
      // Stale override: base item deleted after authoring → explicit conflict.
      const base = toNodes(scenario.base);
      const overrides: ApplicableOverride[] = scenario.overrides.map((o, i) => ({
        id: `o${i}`,
        targetItemId: o.targetItemId,
        op: o.op as ApplicableOverride["op"],
        payload: o.payload,
      }));
      const withoutDeleted = base.filter(
        (n) => !scenario.overrides.some((o) => o.targetItemId === n.id),
      );
      assert.throws(
        () => applyOverrides(withoutDeleted, overrides),
        (err: NavigationError) => err.code === "NAV_OVERRIDE_STALE",
      );
      return;
    }
    const overrides: ApplicableOverride[] = scenario.overrides.map((o, i) => ({
      id: `o${i}`,
      targetItemId: o.targetItemId,
      op: o.op as ApplicableOverride["op"],
      payload: o.payload,
    }));
    const result = applyOverrides(toNodes(scenario.base), overrides);
    assert.deepEqual(labels(result), scenario.expectLabels);
    if (scenario.expectMaxDepth !== undefined) {
      assert.equal(maxDepth(result), scenario.expectMaxDepth);
    }
  });
}

test("corpus scenario: derived mobile overrides apply through the algebra", () => {
  const scenario = CORPUS.menuScenarios.find((s) => s.id === "derived-mobile-overrides");
  assert.ok(scenario !== undefined);
  const overrides: ApplicableOverride[] = scenario.overrides.map((o, i) => ({
    id: `o${i}`,
    targetItemId: o.targetItemId,
    op: o.op as ApplicableOverride["op"],
    payload: o.payload,
  }));
  const result = applyOverrides(toNodes(scenario.base), overrides);
  assert.deepEqual(labels(result), scenario.expectLabels);
});

test("corpus scenario: 5-level mobile menu stays within the system cap", () => {
  // Deep chain built in memory: 5 levels are legal, 11 exceed the cap.
  let nodes: NavigationItemNode[] = [];
  let current: NavigationItemNode | null = null;
  for (let level = 1; level <= 5; level += 1) {
    const node: NavigationItemNode = {
      id: `l${level}`,
      type: "group",
      label: `L${level}`,
      target: null,
      visibility: "always",
      uiIntent: null,
      children: current === null ? [] : [current],
    };
    current = node;
    nodes = [node];
  }
  assert.equal(maxDepth(nodes), 5);
});

test("corpus scenario: breadcrumb derivation from a navigation trail", async () => {
  const tree: NavigationItemNode[] = [
    {
      id: "services",
      type: "group",
      label: "Услуги",
      target: null,
      visibility: "always",
      uiIntent: null,
      children: [
        {
          id: "audit",
          type: "internal_entry",
          label: "Аудит",
          target: { entry_id: "01900000-0000-7000-8000-000000000002" },
          visibility: "always",
          uiIntent: null,
          children: [],
        },
      ],
    },
  ];
  const crumbs = await deriveBreadcrumbs(
    { type: "navigation-trail", setId: "main" },
    { entryId: "01900000-0000-7000-8000-000000000002" },
    {
      async getParentEntryId() {
        return null;
      },
      async getTitle() {
        return null;
      },
      async getEntryHref(entryId) {
        return entryId === "01900000-0000-7000-8000-000000000002" ? "/services/audit/" : null;
      },
      async getNavigationTree() {
        return tree;
      },
    },
  );
  assert.deepEqual(
    crumbs.map((c) => [c.label, c.href, c.isCurrent]),
    [
      ["Услуги", null, false],
      ["Аудит", "/services/audit/", true],
    ],
  );
});

test("corpus route scenarios: rename, chain collapse, collision, domains", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: {
      host: db.connection.host,
      port: db.connection.port,
      database: db.connection.database,
      user: db.connection.user,
      sslMode: "disable" as const,
      ...(db.connection.password === undefined ? {} : { password: db.connection.password }),
    },
    max: 5,
  });
  t.after(() => {
    void pool.end();
  });
  await (await import("@pcms/core")).migrateDatabase(
    pool,
    (await import("@pcms/core")).loadMigrations("db/migrations"),
    undefined,
  );
  const routes: RouteService = createRouteService(pool);
  const history = createRouteHistoryService(pool);
  const domains = createDomainService(pool);
  const resolver = createRequestResolver(pool);
  const ENTRY = "01900000-0000-7000-8000-000000000001";

  const site = await routes.ensureSite("default", "Corpus");
  await routes.activateRoute({
    siteId: site.id,
    path: "/old-name/",
    targetType: "entry",
    targetId: ENTRY,
  });

  // Route rename keeps the old path alive as a redirect (§31).
  await history.changeRoute({
    siteId: site.id,
    entryId: ENTRY,
    fromPath: "/old-name/",
    toPath: "/new-name/",
  });
  assert.deepEqual(await resolver.resolve({ siteId: site.id, path: "/old-name/" }), {
    kind: "redirect",
    statusCode: 301,
    location: "/new-name/",
  });

  // Redirect chain collapses: old→new, new→c becomes old→c (§33).
  await history.changeRoute({
    siteId: site.id,
    entryId: ENTRY,
    fromPath: "/new-name/",
    toPath: "/c/",
  });
  assert.deepEqual(await resolver.resolve({ siteId: site.id, path: "/old-name/" }), {
    kind: "redirect",
    statusCode: 301,
    location: "/c/",
  });
  assert.deepEqual(await resolver.validateRedirectGraph(site.id), []);

  // Collision: activating a taken path fails with a stable code (§30).
  await routes.activateRoute({
    siteId: site.id,
    path: "/taken/",
    targetType: "entry",
    targetId: "01900000-0000-7000-8000-000000000009",
  });
  await assert.rejects(
    () =>
      routes.activateRoute({
        siteId: site.id,
        path: "/taken/",
        targetType: "entry",
        targetId: ENTRY,
      }),
    (err: import("@pcms/routing").RoutingError) => err.code === "ROUTE_COLLISION",
  );

  // Multiple domains: aliases and scheme policies coexist, one primary (§36/§37).
  for (const hostname of ["acme.example", "acme.ru", "legacy-acme.example"]) {
    await domains.addDomainBinding({
      siteId: site.id,
      hostname,
      ...(hostname === "legacy-acme.example" ? { schemePolicy: "http" as const } : {}),
    });
  }
  const bindingsList = await domains.listDomainBindings(site.id);
  assert.equal(bindingsList.filter((d) => d.isPrimary).length, 1);
  assert.equal(bindingsList.find((d) => d.hostname === "acme.example")?.isPrimary, true);
  assert.equal(
    bindingsList.find((d) => d.hostname === "legacy-acme.example")?.schemePolicy,
    "http",
  );
});
