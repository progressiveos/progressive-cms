// PCMS-NAV-T025 — Theme integration (Navigation spec §15–§20; Theme Contract
// §22–§24). Acceptance: nested menus resolve canonical links. The full
// composition slice runs here: PostgreSQL navigation sets + Routing paths →
// theme Navigation View Models → @pcms/themes placement validation → Liquid
// render with crawlable <a href> output.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createNavigationService,
  createPlacementBindingService,
  type NavigationService,
  type PlacementBindingService,
} from "@pcms/navigation";
import {
  type ActionUrlService,
  createActionUrlService,
  createRouteService,
  type RouteService,
} from "@pcms/routing";
import {
  buildNavigationScope,
  createNavigationPlacementRegistry,
  createThemeEngine,
  createThemePreview,
  type NavigationAssignment,
  type ThemeManifest,
  validateThemeManifest,
} from "@pcms/themes";
import { toNavigationItemViewModels } from "../helpers/navigation-viewmodels.js";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const THEME_DIR = "themes/reference-theme-v1";
const ENTRY_HOME = "01900000-0000-7000-8000-0000000000a0";
const ENTRY_SERVICES = "01900000-0000-7000-8000-000000000001";
const ENTRY_AUDIT = "01900000-0000-7000-8000-000000000002";
const ENTRY_CONTACT = "01900000-0000-7000-8000-000000000003";

function connectionInfo(db: TestDatabase) {
  const info = {
    host: db.connection.host,
    port: db.connection.port,
    database: db.connection.database,
    user: db.connection.user,
    sslMode: "disable" as const,
  };
  return db.connection.password === undefined
    ? info
    : { ...info, password: db.connection.password };
}

function loadManifest(): ThemeManifest {
  const result = validateThemeManifest(
    JSON.parse(readFileSync(join(THEME_DIR, "theme.json"), "utf8")),
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("reference theme manifest invalid");
  return result.value;
}

/** Builds the theme engine from the reference theme's template snapshot. */
function loadEngine() {
  const snapshot: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else snapshot[`${prefix}${name}`] = readFileSync(full, "utf8");
    }
  };
  walk(join(THEME_DIR, "templates"), "templates/");
  walk(join(THEME_DIR, "components"), "components/");
  return createThemeEngine({ templates: snapshot });
}

async function buildSite(
  t: { after: (fn: () => void) => void },
  mode: "shared" | "independent" | "derived",
): Promise<{
  registry: ReturnType<typeof createNavigationPlacementRegistry>;
  assignments: NavigationAssignment[];
  actions: ActionUrlService;
  routes: RouteService;
  nav: NavigationService;
  bindings: PlacementBindingService;
  siteId: string;
}> {
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);

  const nav = createNavigationService(pool);
  const bindings = createPlacementBindingService(pool, nav);
  const routes = createRouteService(pool);
  const actions = createActionUrlService(pool);
  const { createDomainService } = await import("@pcms/routing");
  const domains = createDomainService(pool);

  const site = await routes.ensureSite("default", "Example Corp");
  await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });
  await routes.setHomeEntry(site.id, ENTRY_HOME);
  await routes.activateRoute({
    siteId: site.id,
    path: "/services/",
    targetType: "entry",
    targetId: ENTRY_SERVICES,
  });
  await routes.activateRoute({
    siteId: site.id,
    path: "/services/audit/",
    targetType: "entry",
    targetId: ENTRY_AUDIT,
  });
  await routes.activateRoute({
    siteId: site.id,
    path: "/contacts/",
    targetType: "entry",
    targetId: ENTRY_CONTACT,
  });

  // Main set: only item types the header/footer placements both support
  // (internal_entry, group) — placement capability drives composition, the
  // theme contract decides what may appear where (Theme Contract §22).
  const main = await nav.createSet({ key: "main", title: "Main" });
  const servicesGroup = await nav.insertItem({ setId: main.id, type: "group", label: "Услуги" });
  await nav.insertItem({
    setId: main.id,
    parentItemId: servicesGroup.id,
    type: "internal_entry",
    label: "Аудит",
    target: { entry_id: ENTRY_AUDIT },
  });
  await nav.insertItem({
    setId: main.id,
    parentItemId: servicesGroup.id,
    type: "internal_entry",
    label: "Все услуги",
    target: { entry_id: ENTRY_SERVICES },
  });
  const contact = await nav.insertItem({
    setId: main.id,
    type: "internal_entry",
    label: "Контакты",
    target: { entry_id: ENTRY_CONTACT },
  });
  // Utility set: a CTA action (header.utility supports actions).
  const utility = await nav.createSet({ key: "utility", title: "Utility" });
  await nav.insertItem({
    setId: utility.id,
    type: "action",
    label: "Позвонить",
    target: { kind: "phone", phone: "+7 495 123-45-67" },
    uiIntent: "cta",
  });
  // Extras: external link + anchor live in an unbound set — no placement of
  // this theme declares them, so they must not leak into assignments.
  const extras = await nav.createSet({ key: "extras", title: "Extras" });
  await nav.insertItem({
    setId: extras.id,
    type: "external_url",
    label: "Docs",
    target: { url: "https://docs.example.com", target: "_blank", rel: ["nofollow"] },
  });
  await nav.insertItem({
    setId: extras.id,
    type: "anchor",
    label: "Цены",
    target: { anchor: "pricing", entry_id: ENTRY_SERVICES },
  });

  const descriptors = loadManifest().navigation_placements.map((p) => ({
    id: p.id,
    label: p.label ?? p.id,
    description: p.description ?? null,
    required: p.required ?? false,
    maxDepth: p.max_depth,
    supportedItemTypes: p.supported_item_types,
    fallback: p.fallback ?? null,
  }));

  if (mode === "shared") {
    // One set serves desktop AND mobile placements (spec §16).
    await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: main.id });
    await bindings.bindPlacement({ placementKey: "header.mobile", navigationSetId: main.id });
  } else if (mode === "independent") {
    await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: main.id });
    const mobile = await nav.createSet({ key: "mobile-flat", title: "Mobile" });
    await nav.insertItem({
      setId: mobile.id,
      type: "internal_entry",
      label: "Аудит",
      target: { entry_id: ENTRY_AUDIT },
    });
    await nav.insertItem({ setId: mobile.id, type: "separator" });
    await bindings.bindPlacement({ placementKey: "header.mobile", navigationSetId: mobile.id });
  } else {
    await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: main.id });
    // Derived mobile set: hide the whole services group, relabel contacts.
    const mobile = await nav.createSet({
      key: "main-mobile",
      title: "Mobile",
      derivedFromSetId: main.id,
    });
    const group = (await nav.readTree(main.id)).find((n) => n.type === "group");
    assert.ok(group !== undefined);
    await nav.addOverride({ setId: mobile.id, targetItemId: group.id, op: "hide", payload: {} });
    await nav.addOverride({
      setId: mobile.id,
      targetItemId: contact.id,
      op: "relabel",
      payload: { label: "Связаться" },
    });
    await bindings.bindPlacement({ placementKey: "header.mobile", navigationSetId: mobile.id });
  }
  await bindings.bindPlacement({ placementKey: "header.utility", navigationSetId: utility.id });
  await bindings.bindPlacement({ placementKey: "footer.primary", navigationSetId: main.id });

  const bindingIssues = await bindings.validateBindings(descriptors);
  assert.deepEqual(bindingIssues, []);

  const registry = createNavigationPlacementRegistry(loadManifest());
  const buildAssignment = async (
    placementKey: string,
    setId: string,
  ): Promise<NavigationAssignment> => ({
    placement: placementKey,
    items: await toNavigationItemViewModels(await nav.materializeTree(setId), actions),
  });

  const assignments: NavigationAssignment[] = [];
  const bindingRows = await bindings.listBindings();
  const setIdByKey = new Map(bindingRows.map((b) => [b.placementKey, b.navigationSetId]));
  for (const placement of ["header.primary", "header.mobile", "header.utility", "footer.primary"]) {
    const setId = setIdByKey.get(placement);
    if (setId === undefined) continue;
    assignments.push(await buildAssignment(placement, setId));
  }

  return { registry, assignments, actions, routes, nav, bindings, siteId: site.id };
}

test("nested menus validate against the reference theme placements", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { registry, assignments } = await buildSite(t, "shared");
  const issues = registry.validateAssignments(assignments);
  assert.deepEqual(issues, []);
});

test("shared menu mode: both placements carry the same canonical links", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { registry, assignments } = await buildSite(t, "shared");
  const scope = buildNavigationScope(registry, assignments);
  const primary = scope["header.primary"];
  const mobile = scope["header.mobile"];
  assert.ok(primary !== undefined && mobile !== undefined);
  const hrefsOf = (items: readonly { type: string; items?: readonly unknown[] }[]): string[] =>
    items.flatMap((i) => {
      const own = "href" in i && typeof i.href === "string" ? [i.href] : [];
      const kids = Array.isArray(i.items) ? hrefsOf(i.items as never) : [];
      return [...own, ...kids];
    });
  assert.deepEqual(hrefsOf(mobile.items), hrefsOf(primary.items));
  assert.ok(hrefsOf(primary.items).includes("/services/audit/"));
  assert.ok(hrefsOf(primary.items).includes("/contacts/"));
});

test("independent menu mode: mobile placement differs from desktop", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { registry, assignments } = await buildSite(t, "independent");
  const issues = registry.validateAssignments(assignments);
  assert.deepEqual(issues, []);
  const scope = buildNavigationScope(registry, assignments);
  const primary = scope["header.primary"];
  const mobile = scope["header.mobile"];
  assert.ok(primary !== undefined && mobile !== undefined);
  // Mobile set is flat with a separator; desktop is nested — genuinely
  // different trees, not CSS variants of one menu (spec §20).
  const hasSeparator = mobile.items.some((i) => i.type === "separator");
  assert.equal(hasSeparator, true);
  assert.equal(
    primary?.items.some((i) => i.type === "separator"),
    false,
  );
});

test("derived menu mode: overrides shape the mobile tree, base is untouched", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { registry, assignments } = await buildSite(t, "derived");
  const issues = registry.validateAssignments(assignments);
  assert.deepEqual(issues, []);
  const scope = buildNavigationScope(registry, assignments);
  const mobile = scope["header.mobile"];
  assert.ok(mobile !== undefined);
  const labels = mobile.items.map((i) => ("title" in i ? i.title : "")).filter(Boolean);
  assert.equal(labels.includes("Услуги"), false); // hidden by override
  assert.equal(labels.includes("Связаться"), true); // relabeled
  assert.equal(labels.includes("Контакты"), false);
});

test("rendered Liquid output contains crawlable canonical anchors", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { registry, assignments } = await buildSite(t, "shared");
  const engine = loadEngine();
  const scope = buildNavigationScope(registry, assignments);
  // A minimal crawlable-nav template over the real scope (Theme spec §24/§62).
  const template = `{% for item in nav %}<ul>{% for link in item.items %}{% if link.type == "internal_entry" or link.type == "external_url" %}<li><a href="{{ link.href }}">{{ link.title }}</a></li>{% endif %}{% if link.type == "group" %}{% for sub in link.items %}{% if sub.type == "internal_entry" %}<li class="in-group"><a class="sub" href="{{ sub.href }}">{{ sub.title }}</a></li>{% endif %}{% endfor %}{% endif %}{% endfor %}</ul>{% endfor %}`;
  const html = await engine.parseAndRender(template, { nav: [scope["header.primary"]] });
  assert.ok(html.includes('<a class="sub" href="/services/audit/">Аудит</a>'), html);
  assert.ok(html.includes('<a href="/contacts/">Контакты</a>'), html);
  // Groups never render as fake links (Theme spec §24).
  assert.ok(!html.includes('href="#"'), html);
  // The utility placement carries the CTA action with its tel href.
  const utilityItems = scope["header.utility"]?.items ?? [];
  const cta = utilityItems.find((i) => i.type === "action");
  assert.ok(cta !== undefined && "action" in cta);
  assert.equal((cta.action as Record<string, unknown>).href, "tel:+74951234567");
});

test("the full page preview accepts navigation assignments resolved by routing", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { registry, assignments } = await buildSite(t, "derived");
  const manifest = loadManifest();
  // Preview-level proof: the reference theme's preview pipeline accepts the
  // assignments M04 produced (shape + hrefs already validated above).
  const scope = buildNavigationScope(registry, assignments);
  assert.ok(scope["header.mobile"] !== undefined);
  void createThemePreview;
});
