// PCMS-SEO-T019 — sitemap index/split/lastmod semantics (spec §16/§17/§19):
// bounded generation, deterministic chunking, meaningful lastmod only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSitemapFiles, MAX_URLS_PER_SITEMAP, type SitemapCandidate } from "@pcms/seo";

function candidates(n: number): SitemapCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    entryId: `01900000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    path: `/page-${String(i).padStart(6, "0")}/`,
    lastmod: i % 2 === 0 ? `2026-09-1${String(i % 10)}T08:00:00Z` : null,
    noindex: false,
    eligibility: { public: true, http200: true },
  }));
}

const ORIGIN = "https://example.ru";

test("a set within the limit stays a single deterministic sitemap.xml", () => {
  const result = buildSitemapFiles({ origin: ORIGIN, candidates: candidates(3) });
  assert.equal(result.indexXml, null);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.name, "sitemap.xml");
  assert.ok(result.files[0]?.xml.includes("/page-000001/"));
});

test("sets above the limit split into bounded chunks with a deterministic index", () => {
  const result = buildSitemapFiles(
    { origin: ORIGIN, candidates: candidates(25) },
    { maxUrlsPerSitemap: 10, originForIndex: ORIGIN },
  );
  assert.ok(result.indexXml !== null);
  assert.deepEqual(
    result.files.map((f) => f.name),
    ["sitemap-1.xml", "sitemap-2.xml", "sitemap-3.xml"],
  );
  const first = result.files[0]?.xml ?? "";
  const third = result.files[2]?.xml ?? "";
  assert.equal(first.split("<loc>").length - 1, 10);
  assert.equal(third.split("<loc>").length - 1, 5);
  // Order preserved: sitemap-1 holds the lexicographically smallest paths.
  assert.ok(first.includes("/page-000000/"));
  assert.ok(third.includes("/page-000024/"));
  const index = result.indexXml ?? "";
  assert.ok(index.includes("<sitemapindex"));
  for (const f of result.files) assert.ok(index.includes(`<loc>${ORIGIN}/${f.name}</loc>`));
  // Chunking is deterministic.
  const again = buildSitemapFiles(
    { origin: ORIGIN, candidates: candidates(25) },
    { maxUrlsPerSitemap: 10, originForIndex: ORIGIN },
  );
  assert.deepEqual(
    result.files.map((f) => f.xml),
    again.files.map((f) => f.xml),
  );
});

test("the default bound is the conservative 10k protocol baseline (§16)", () => {
  assert.equal(MAX_URLS_PER_SITEMAP, 10_000);
});

test("lastmod appears only for candidates that declare a public modification time", () => {
  const result = buildSitemapFiles({ origin: ORIGIN, candidates: candidates(4) });
  const xml = result.files[0]?.xml ?? "";
  // Half of the fixtures carry no lastmod — those urls have no lastmod child.
  const urlBlocks = xml.split("<url>").length - 1;
  const lastmods = xml.split("<lastmod>").length - 1;
  assert.equal(urlBlocks, 4);
  assert.equal(lastmods, 2);
});
