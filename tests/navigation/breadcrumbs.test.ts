// PCMS-NAV-T020 — breadcrumb derivation strategies (Navigation spec §50–§52).
// Acceptance: content-tree / navigation-trail / explicit fixtures. Entry in
// several sets → the trail set must be explicit; no "first found" guessing.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BreadcrumbItem,
  type BreadcrumbLookups,
  deriveBreadcrumbs,
  type NavigationError,
  type NavigationItemNode,
} from "@pcms/navigation";

const ENTRY_HOME = "01900000-0000-7000-8000-0000000000a0";
const ENTRY_SERVICES = "01900000-0000-7000-8000-000000000001";
const ENTRY_AUDIT = "01900000-0000-7000-8000-000000000002";
const ENTRY_NEWS = "01900000-0000-7000-8000-000000000003";

/** Fake composition layer: content tree + hrefs + two navigation sets. */
function makeLookups(): { lookups: BreadcrumbLookups; trees: Map<string, NavigationItemNode[]> } {
  const parents = new Map<string, string | null>([
    [ENTRY_AUDIT, ENTRY_SERVICES],
    [ENTRY_SERVICES, ENTRY_HOME],
    [ENTRY_HOME, null],
    [ENTRY_NEWS, ENTRY_HOME],
  ]);
  const titles = new Map<string, string>([
    [ENTRY_HOME, "Главная"],
    [ENTRY_SERVICES, "Услуги"],
    [ENTRY_AUDIT, "Аудит"],
    [ENTRY_NEWS, "Новости"],
  ]);
  const hrefs = new Map<string, string>([
    [ENTRY_HOME, "/"],
    [ENTRY_SERVICES, "/services/"],
    [ENTRY_AUDIT, "/services/audit/"],
    [ENTRY_NEWS, "/news/"],
  ]);
  const node = (
    id: string,
    type: NavigationItemNode["type"],
    label: string | null,
    entryId: string | null,
    children: readonly NavigationItemNode[] = [],
  ): NavigationItemNode =>
    ({
      id,
      type,
      label,
      target: type === "internal_entry" && entryId !== null ? { entry_id: entryId } : null,
      visibility: "always",
      uiIntent: null,
      children,
    }) as NavigationItemNode;

  const trees = new Map<string, NavigationItemNode[]>([
    // main set: Home / Services(group+entry) / Audit
    [
      "main",
      [
        node("n-home", "internal_entry", "Home", ENTRY_HOME),
        node("n-services", "group", "Services", null, [
          node("n-audit", "internal_entry", "Audit", ENTRY_AUDIT),
        ]),
        node("n-news", "internal_entry", "News", ENTRY_NEWS),
      ],
    ],
    // legal set does NOT contain ENTRY_AUDIT (the multi-trail case)
    ["legal", [node("n-legal-home", "internal_entry", "Home", ENTRY_HOME)]],
  ]);

  return {
    trees,
    lookups: {
      async getParentEntryId(entryId) {
        return parents.get(entryId) ?? null;
      },
      async getTitle(entryId) {
        return titles.get(entryId) ?? null;
      },
      async getEntryHref(entryId) {
        return hrefs.get(entryId) ?? null;
      },
      async getNavigationTree(setId) {
        return trees.get(setId) ?? [];
      },
    },
  };
}

test("content-tree strategy walks Content Tree ancestors root → current", async () => {
  const { lookups } = makeLookups();
  const crumbs = await deriveBreadcrumbs(
    { type: "content-tree" },
    { entryId: ENTRY_AUDIT },
    lookups,
  );
  assert.deepEqual(
    crumbs.map((c: BreadcrumbItem) => [c.label, c.href, c.isCurrent]),
    [
      ["Главная", "/", false],
      ["Услуги", "/services/", false],
      ["Аудит", "/services/audit/", true],
    ],
  );
});

test("navigation-trail strategy follows the explicitly chosen set", async () => {
  const { lookups } = makeLookups();
  const crumbs = await deriveBreadcrumbs(
    { type: "navigation-trail", setId: "main" },
    { entryId: ENTRY_AUDIT },
    lookups,
  );
  // The trail is the tree path to the item: the group heading is a real,
  // linkless crumb (spec §9/§51); "Home" is a sibling, not an ancestor.
  assert.deepEqual(
    crumbs.map((c) => [c.label, c.href, c.isCurrent]),
    [
      ["Services", null, false],
      ["Audit", "/services/audit/", true],
    ],
  );
});

test("an entry absent from the chosen set is an explicit error, not a guess", async () => {
  const { lookups } = makeLookups();
  await assert.rejects(
    () =>
      deriveBreadcrumbs(
        { type: "navigation-trail", setId: "legal" },
        { entryId: ENTRY_AUDIT },
        lookups,
      ),
    (err: NavigationError) => {
      assert.equal(err.code, "NAV_BREADCRUMB_TRAIL_MISSING");
      assert.equal(err.details.set_id, "legal");
      return true;
    },
  );
});

test("unknown navigation sets fail with a stable code", async () => {
  const { lookups } = makeLookups();
  await assert.rejects(
    () =>
      deriveBreadcrumbs(
        { type: "navigation-trail", setId: "nope" },
        { entryId: ENTRY_AUDIT },
        lookups,
      ),
    (err: NavigationError) => err.code === "NAV_BREADCRUMB_TRAIL_MISSING",
  );
});

test("explicit strategy renders verbatim and marks the last crumb current", async () => {
  const { lookups } = makeLookups();
  const crumbs = await deriveBreadcrumbs(
    {
      type: "explicit",
      items: [
        { label: "Главная", entryId: ENTRY_HOME, href: "/" },
        { label: "Наши работы", href: "/cases/" },
        { label: "Модернизация" },
      ],
    },
    { entryId: ENTRY_AUDIT },
    lookups,
  );
  assert.deepEqual(
    crumbs.map((c) => [c.label, c.isCurrent]),
    [
      ["Главная", false],
      ["Наши работы", false],
      ["Модернизация", true],
    ],
  );
});

test("unrouted entries produce linkless crumbs instead of URLs", async () => {
  const parents = new Map<string, string | null>([
    [ENTRY_AUDIT, ENTRY_SERVICES],
    [ENTRY_SERVICES, null],
  ]);
  const lookups: BreadcrumbLookups = {
    async getParentEntryId(entryId) {
      return parents.get(entryId) ?? null;
    },
    async getTitle() {
      return "Title";
    },
    async getEntryHref() {
      return null; // e.g. draft entry without a route
    },
    async getNavigationTree() {
      return [];
    },
  };
  const crumbs = await deriveBreadcrumbs(
    { type: "content-tree" },
    { entryId: ENTRY_AUDIT },
    lookups,
  );
  assert.deepEqual(
    crumbs.map((c) => [c.label, c.href, c.isCurrent]),
    [
      ["Title", null, false],
      ["Title", null, true],
    ],
  );
});
