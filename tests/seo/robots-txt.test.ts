// PCMS-SEO-T020 — generated robots.txt + Sitemap directive (spec §14).
// Typed policy only: no arbitrary syntax injection, CRLF cannot enter,
// reserved namespaces baseline, Sitemap directive derived from the sitemap.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultRobotsTxtPolicy,
  parseRobotsTxtPolicy,
  RESERVED_ROBOTS_PATHS,
  renderRobotsTxt,
  SeoError,
} from "@pcms/seo";

test("baseline policy disallows reserved namespaces and declares the sitemap", () => {
  const policy = defaultRobotsTxtPolicy({ sitemapUrl: "https://example.ru/sitemap.xml" });
  const txt = renderRobotsTxt(policy);
  assert.equal(
    txt,
    "User-agent: *\n" +
      RESERVED_ROBOTS_PATHS.map((p) => `Disallow: ${p}`).join("\n") +
      "\n\nSitemap: https://example.ru/sitemap.xml\n",
  );
  assert.ok(txt.includes("Disallow: /admin/"));
  assert.ok(txt.includes("Sitemap: https://example.ru/sitemap.xml"));
});

test("rendering is deterministic and rules keep their declared order", () => {
  const policy = parseRobotsTxtPolicy({
    rules: [
      { user_agent: "Googlebot", disallow: ["/search/"] },
      { user_agent: "Yandex", allow: ["/public/"], disallow: ["/private/"] },
    ],
    sitemap_url: null,
  });
  const txt = renderRobotsTxt(policy);
  assert.equal(
    txt,
    "User-agent: Googlebot\nDisallow: /search/\n\nUser-agent: Yandex\nAllow: /public/\nDisallow: /private/\n\n",
  );
  assert.equal(txt, renderRobotsTxt(parseRobotsTxtPolicy(policy)));
});

test("hostile directives are rejected — wildcards ok, injection paths not", () => {
  assert.ok(
    parseRobotsTxtPolicy({ rules: [{ user_agent: "*", disallow: ["/x*$"] }], sitemap_url: null }),
  );
  const badPaths = [
    "/a\r\nUser-agent: *",
    "/a\nDisallow: /evil",
    "relative/path",
    "/a b",
    "<script>",
  ];
  for (const path of badPaths) {
    assert.throws(
      () =>
        parseRobotsTxtPolicy({ rules: [{ user_agent: "*", disallow: [path] }], sitemap_url: null }),
      (err: unknown) => err instanceof SeoError && err.code === "SEO_ROBOTS_TXT_INVALID",
      path,
    );
  }
  assert.throws(
    () =>
      parseRobotsTxtPolicy({
        rules: [{ user_agent: "*\rDisallow: /", disallow: ["/x/"] }],
        sitemap_url: null,
      }),
    (err: unknown) => err instanceof SeoError,
  );
  assert.throws(
    () =>
      parseRobotsTxtPolicy({
        rules: [{ user_agent: "*", disallow: [] }],
        sitemap_url: "not-a-url",
      }),
    (err: unknown) => err instanceof SeoError,
  );
});

test("no sitemap → no Sitemap line; crawling policy stays separate from noindex", () => {
  const txt = renderRobotsTxt(defaultRobotsTxtPolicy({ sitemapUrl: null }));
  assert.ok(!txt.includes("Sitemap:"));
  // Disallow is crawling, robots meta is indexing — different mechanisms.
  const meta = renderRobotsTxt(
    defaultRobotsTxtPolicy({ sitemapUrl: "https://example.ru/sitemap.xml" }),
  );
  assert.ok(meta.includes("Disallow: /"));
  assert.ok(!meta.includes("noindex"));
});
