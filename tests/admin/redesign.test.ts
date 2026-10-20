// Redesign engine unit checks (ADMIN-UX T020/T021/T013; spec §36.1):
// locale resolution + persistence semantics, dictionary key parity,
// presentation-label fallbacks, icon registry sanity. Node-only, DOM-free.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminIcons } from "../../apps/admin/src/design/icons.js";
import { en, errorText, ru, t } from "../../apps/admin/src/i18n/index.js";
import { getLocale, setLocale } from "../../apps/admin/src/i18n/locale.js";
import {
  fieldLabel,
  repeaterItemLabel,
} from "../../apps/admin/src/screens/content/fields/field-utils.js";
import {
  ancestorChain,
  buildTree,
  canMoveTo,
  filterTreeItems,
  subtreeIds,
} from "../../apps/admin/src/screens/content/tree-model.js";

test("locale defaults to ru and switches explicitly", () => {
  assert.equal(getLocale(), "ru");
  setLocale("en");
  assert.equal(getLocale(), "en");
  assert.equal(t("nav_content"), "Content");
  assert.notEqual(t("nav_content"), "[nav_content]");
  setLocale("ru");
  assert.equal(t("nav_content"), "Материалы");
});

test("product name is never translated", () => {
  for (const dictionary of [ru, en]) {
    for (const [key, value] of Object.entries(dictionary)) {
      if (key.startsWith("product") && value !== "Progressive CMS") {
        assert.fail(`product name translated in ${key}`);
      }
      assert.ok(!value.includes("Прогрессивная"), `old name in ${key}`);
    }
  }
});

test("en dictionary covers every ru key", () => {
  assert.equal(Object.keys(ru).length, Object.keys(en).length);
  for (const key of Object.keys(ru)) {
    assert.ok(key in en, `missing en key: ${key}`);
  }
});

test("t() surfaces unknown keys loudly", () => {
  assert.equal(t("definitely_not_a_key"), "[definitely_not_a_key]");
});

test("error codes localize per active locale", () => {
  setLocale("ru");
  assert.equal(errorText("ROUTE_COLLISION"), "Такой адрес уже занят другой страницей");
  setLocale("en");
  assert.equal(errorText("ROUTE_COLLISION"), "This address is already taken by another page");
  setLocale("ru");
});

test("presentation labels: known ids localized, unknown humanized, repeater item labels", () => {
  setLocale("ru");
  assert.equal(fieldLabel("features"), "Преимущества");
  assert.equal(repeaterItemLabel("features"), "Преимущество");
  assert.equal(fieldLabel("totally_unknown_field"), "Totally unknown field");
  setLocale("en");
  assert.equal(fieldLabel("features"), "Features");
  assert.equal(repeaterItemLabel("features"), "Feature");
  setLocale("ru");
});

test("icon registry values are Font Awesome class-safe", () => {
  for (const [name, fa] of Object.entries(adminIcons)) {
    assert.match(fa, /^[a-z0-9-]+$/, `icon ${name} has unsafe class: ${fa}`);
  }
  for (const required of ["content", "media", "publication", "maintenance", "system"]) {
    assert.ok(required in adminIcons, `missing nav icon: ${required}`);
  }
});

test("tree builder groups children and surfaces orphans as roots", () => {
  const tree = buildTree([
    { entry_id: "root", parent_entry_id: null, title: "Root" },
    { entry_id: "child", parent_entry_id: "root", title: "Child" },
    { entry_id: "orphan", parent_entry_id: "gone", title: "Orphan" },
  ]);
  assert.equal(tree.length, 2);
  const root = tree.find((node) => node.entry_id === "root");
  assert.equal(root?.children.length, 1);
  assert.ok(tree.some((node) => node.entry_id === "orphan"));
});

test("tree search keeps matches plus ancestors", () => {
  const items = [
    { entry_id: "a", parent_entry_id: null, title: "Услуги" },
    { entry_id: "b", parent_entry_id: "a", title: "Кровля" },
    { entry_id: "c", parent_entry_id: null, title: "Контакты" },
  ];
  const filtered = filterTreeItems(items, "кровля");
  assert.deepEqual(filtered.map((item) => item.entry_id).sort(), ["a", "b"]);
});

test("ancestor chain returns the root-first location path", () => {
  const items = [
    { entry_id: "root", parent_entry_id: null, title: "Root" },
    { entry_id: "mid", parent_entry_id: "root", title: "Mid" },
    { entry_id: "leaf", parent_entry_id: "mid", title: "Leaf" },
    { entry_id: "solo", parent_entry_id: null, title: "Solo" },
  ];
  assert.deepEqual(
    ancestorChain(items, "leaf").map((item) => item.entry_id),
    ["root", "mid"],
  );
  assert.deepEqual(ancestorChain(items, "solo"), []);
  // Unknown id and broken chains degrade to the visible part, never throw.
  assert.deepEqual(ancestorChain(items, "gone"), []);
  assert.deepEqual(
    ancestorChain([...items, { entry_id: "x", parent_entry_id: "gone", title: "X" }], "x"),
    [],
  );
});

test("canMoveTo mirrors the server cycle rule for drops and pickers", () => {
  const items = [
    { entry_id: "a", parent_entry_id: null, title: "A" },
    { entry_id: "b", parent_entry_id: "a", title: "B" },
    { entry_id: "c", parent_entry_id: "b", title: "C" },
    { entry_id: "d", parent_entry_id: null, title: "D" },
  ];
  assert.equal(canMoveTo(items, "b", "d"), true);
  assert.equal(canMoveTo(items, "b", null), true);
  assert.equal(canMoveTo(items, "b", "b"), false);
  assert.equal(canMoveTo(items, "b", "c"), false); // own descendant
  assert.equal(canMoveTo(items, "c", "a"), true);
});

test("subtreeIds enumerates the moved branch for picker exclusion", () => {
  const items = [
    { entry_id: "a", parent_entry_id: null, title: "A" },
    { entry_id: "b", parent_entry_id: "a", title: "B" },
    { entry_id: "c", parent_entry_id: "b", title: "C" },
  ];
  assert.deepEqual([...subtreeIds(items, "b")].sort(), ["b", "c"]);
  assert.deepEqual([...subtreeIds(items, "a")].sort(), ["a", "b", "c"]);
});
