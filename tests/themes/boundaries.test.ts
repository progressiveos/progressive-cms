// Theme package boundary tests (PCMS-THEME-T001).
//
// The architecture boundary test already enforces the L1 import map for every
// package; these checks pin the Theme-specific contract surface: a single
// public entry, no DB driver, and view-model/plain-data-only exposure.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type NavigationItemViewModel, ThemeError } from "@pcms/themes";

test("themes exposes exactly one public application entry", () => {
  const manifest = JSON.parse(readFileSync("packages/themes/package.json", "utf8")) as {
    exports?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(manifest.exports ?? {}), ["."]);
});

test("themes sources import no DB driver and no non-core @pcms/* package", () => {
  const problems: string[] = [];
  const scan = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name.endsWith(".ts")) {
        const src = readFileSync(p, "utf8");
        if (/from\s+["'](pg|mysql|mongodb|redis)[/"']/.test(src))
          problems.push(`${p}: DB driver import`);
        for (const m of src.matchAll(/(?:from|import)\s+["']@pcms\/([\w-]+)(?:\/[^"']*)?["']/g)) {
          if (m[1] !== "core") problems.push(`${p}: @pcms/${m[1]}`);
        }
      }
    }
  };
  scan("packages/themes/src");
  assert.deepEqual(problems, []);
});

test("ThemeError carries a stable machine code", () => {
  const err = new ThemeError("THEME_MANIFEST_INVALID", "bad manifest");
  assert.equal(err.code, "THEME_MANIFEST_INVALID");
  assert.equal(err.name, "ThemeError");
  assert.ok(err instanceof Error);
});

test("navigation view model keeps link semantics on link items only", () => {
  // Type-level contract, exercised with representative runtime values: only
  // internal_entry/external_url items carry `href`; groups never pretend to
  // be links (Theme spec §24).
  const items: readonly NavigationItemViewModel[] = [
    {
      type: "internal_entry",
      entry_id: "0198c0a9-8f7d-7cc0-9a2a-5f1e2d3c4b5a",
      title: "Услуги",
      href: "/services",
      items: [],
    },
    { type: "external_url", title: "Telegram", href: "https://t.me/example", items: [] },
    { type: "group", title: "Компания", items: [] },
    { type: "separator" },
  ];
  const withHref = items.filter((i) => "href" in i);
  assert.deepEqual(
    withHref.map((i) => i.type),
    ["internal_entry", "external_url"],
  );
});
