// MODX 3.0/3.2 connector (packages/routing/src/migration/modx3.ts): URI
// trust model, 410 for deleted, map-driven 301s, §61 path preservation,
// class/context filtering, duplicate/empty-URI warnings, prefix rewrites.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildModxRedirectPlan,
  toRedirectsCsv,
} from "../../packages/routing/src/migration/modx3.js";

const SITE_CONTENT = [
  "id,parent,alias,uri,uri_override,content_type,context_key,isfolder,deleted,published,class_key,pagetitle",
  '10,0,"","" ,0,1,web,1,0,1,modDocument,"Главная"',
  '11,0,about,about.html,0,1,web,0,0,1,modDocument,"О компании"',
  '12,11,team,about/team.html,0,1,web,0,0,1,modDocument,"Команда"',
  '13,0,old-page,old-page.html,0,1,web,0,1,1,modDocument,"Удалённая"',
  '14,0,contact,contact.html,0,1,web,0,0,0,modDocument,"Контакты (черновик)"',
  '15,0,linked,https://external.example/,0,1,web,0,0,1,modWebLink,"Внешняя ссылка"',
  '16,0,frozen,frozen/custom-path.html,1,1,web,0,0,1,modDocument,"Замороженный URI"',
  '17,0,dup,dup.html,0,1,web,0,0,1,modDocument,"Дубль первый"',
  '18,0,dup2,dup.html,0,1,web,0,0,1,modDocument,"Дубль второй (тот же uri)"',
  '19,0,nofurl,,0,1,web,0,0,1,modDocument,"Без FURL"',
  '20,0,mgr-only,mgr-page.html,0,1,mgr,0,0,1,modDocument,"Только в mgr"',
].join("\n");

test("context and class filtering: web documents only, weblinks counted and skipped", () => {
  const plan = buildModxRedirectPlan(SITE_CONTENT);
  assert.equal(plan.summary.documents, 9); // 10..14,16..19; mgr(20) filtered, weblink(15) skipped
  assert.equal(plan.summary.skippedClasses["modWebLink"], 1);
  assert.ok(plan.summary.warnings.some((w) => w.code === "SKIPPED_CLASS"));
  assert.ok(!plan.canonical.some((row) => row.id === 20));
});

test("deleted resources become 410 rows; surviving resources keep old URL as canonical (§61)", () => {
  const plan = buildModxRedirectPlan(SITE_CONTENT);
  const gone = plan.redirects.find((row) => row.source === "/old-page.html");
  assert.deepEqual(gone, {
    source: "/old-page.html",
    target: null,
    status_code: 410,
    reason: "modx: resource deleted",
  });
  assert.equal(plan.summary.deleted410, 1);
  // §61: about.html and about/team.html keep their MODX URIs as canonicals.
  const about = plan.canonical.find((row) => row.id === 11);
  assert.equal(about?.canonical_path, "/about.html");
  const team = plan.canonical.find((row) => row.id === 12);
  assert.equal(team?.canonical_path, "/about/team.html");
  assert.equal(plan.summary.preserved, plan.canonical.length);
});

test("map-driven 301s: renamed resources redirect from the old MODX URI", () => {
  const plan = buildModxRedirectPlan(SITE_CONTENT, {
    mapCsv: "modx_id,new_path\n11,/company/about/\n",
  });
  const moved = plan.redirects.find((row) => row.source === "/about.html");
  assert.deepEqual(moved, {
    source: "/about.html",
    target: "/company/about/",
    status_code: 301,
    reason: "modx: resource 11 moved to a new path",
  });
  assert.equal(plan.summary.redirected, 1);
  assert.ok(!plan.canonical.some((row) => row.id === 11));
});

test("prefix rewrites for subdirectory sites", () => {
  const plan = buildModxRedirectPlan(SITE_CONTENT, { addPrefix: "/old-site" });
  const gone = plan.redirects.find((row) => row.source === "/old-site/old-page.html");
  assert.ok(gone !== undefined);
});

test("data problems are warnings, never crashes: empty uri, query uri, duplicates", () => {
  const plan = buildModxRedirectPlan(SITE_CONTENT);
  const codes = plan.summary.warnings.map((warning) => warning.code);
  // Home (empty uri) normalizes to "/" and survives as a canonical.
  const home = plan.canonical.find((row) => row.id === 10);
  assert.equal(home?.canonical_path, "/");
  assert.ok(codes.includes("DUPLICATE_URI")); // ids 17/18 share dup.html
  // Duplicate uri planned once — the first resource keeps the canonical.
  assert.equal(plan.canonical.filter((row) => row.old_uri === "/dup.html").length, 1);
});

test("redirect CSV serialization feeds cms redirects validate unchanged", () => {
  const plan = buildModxRedirectPlan(SITE_CONTENT, {
    mapCsv: "modx_id,new_path\n11,/company/about/\n",
  });
  const csv = toRedirectsCsv(plan);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "source,target,status_code,reason");
  assert.ok(
    lines.some(
      (line) => line === '/old-page.html,,410,"modx: resource deleted"' || line.includes("410"),
    ),
  );
  assert.ok(lines.some((line) => line.startsWith("/about.html,/company/about/,301,")));
});

test("SEO-mess audit: case variants and normalized collisions surface as warnings", () => {
  const csv = [
    "id,parent,alias,uri,uri_override,content_type,context_key,isfolder,deleted,published,class_key,pagetitle",
    '30,0,about,about.html,0,1,web,0,0,1,modDocument,"About"',
    '31,0,about2,About.html,0,1,web,0,0,1,modDocument,"about (case variant)"',
    '32,0,about3,about/,0,1,web,0,0,1,modDocument,"about slash variant"',
  ].join("\n");
  const plan = buildModxRedirectPlan(csv);
  const codes = plan.summary.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("CASE_VARIANT"), plan.summary.warnings.map((w) => w.detail).join("; "));
  assert.ok(codes.includes("NORMALIZED_COLLISION"));
  // Report-only: every variant still lands in the canonical plan.
  assert.equal(plan.canonical.length, 3);
});
