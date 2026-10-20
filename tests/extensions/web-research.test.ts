// Web Research extension (PCMS-WEB-RESEARCH, ADR-0015): XMLStock adapter
// (wire contract from IncusHub, verified live 2026-09-18), SSRF admission
// corpus, safe-fetch transport (hops re-validated, bounded bodies), HTML
// extraction quality fixtures, and handler error taxonomy. Server-driven
// tests run against a local http server behind the TEST-ONLY
// allowPrivateTargets escape hatch; production admission blocks these URLs
// before any network activity (asserted in the corpus).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import Ajv from "ajv";
import { ResearchError } from "../../extensions/progressive-web-research/src/errors.js";
import {
  extractHtml,
  extractTextPassthrough,
  looksLikeJsShell,
} from "../../extensions/progressive-web-research/src/extract.js";
import { fetchPage, search } from "../../extensions/progressive-web-research/src/index.js";
import {
  extractPdfText,
  renderPdfPages,
} from "../../extensions/progressive-web-research/src/pdf.js";
import { browserRender } from "../../extensions/progressive-web-research/src/render.js";
import { decodeBody, safeFetch } from "../../extensions/progressive-web-research/src/safe-fetch.js";
import {
  expandIpv6,
  isBlockedIpString,
  parsePublicHttpUrl,
  resolveAndPin,
} from "../../extensions/progressive-web-research/src/url-policy.js";
import {
  type VisionFetch,
  visionTranscribe,
} from "../../extensions/progressive-web-research/src/vision.js";
import {
  normalizeResultUrl,
  registrableDomain,
  textOf,
  xmlstockSearch,
} from "../../extensions/progressive-web-research/src/xmlstock.js";

const manifest = JSON.parse(
  readFileSync("extensions/progressive-web-research/manifest.json", "utf8"),
) as {
  registrations: {
    operations: readonly {
      operation_id: string;
      output_schema: Record<string, unknown>;
    }[];
  };
};

function outputSchemaOf(operationId: string): Record<string, unknown> {
  const operation = manifest.registrations.operations.find(
    (entry) => entry.operation_id === operationId,
  );
  assert.ok(operation !== undefined, `operation ${operationId} in manifest`);
  return operation.output_schema;
}

function expectResearchError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof ResearchError, `expected ResearchError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

// ---- XMLStock fixtures (shapes from the verified wire contract) ----

const YANDEX_PAGE = `<response>
  <results>
    <grouping attr="d" mode="deep">
      <group>
        <doc id="z1">
          <url>https://docs.example.org/guide/page-1</url>
          <domain>docs.example.org</domain>
          <title><![CDATA[Guide <hlword>incus</hlword> part 1]]></title>
          <headline><![CDATA[How to run <hlword>incus</hlword> containers]]></headline>
          <modtime>20260101</modtime>
        </doc>
      </group>
      <group>
        <doc id="z2">
          <url>https://docs.example.org/guide/page-1#section</url>
          <domain>docs.example.org</domain>
          <title>Duplicate of page 1</title>
          <headline>Same URL after normalization</headline>
        </doc>
      </group>
    </grouping>
  </results>
</response>`;

const GOOGLE_PAGE = `<response>
  <results>
    <group>
      <doc>
        <url>https://example.com/a</url>
        <title>Result A</title>
        <passages><passage>Snippet A</passage></passages>
      </doc>
    </group>
  </results>
</response>`;

function stubFetch(pages: Record<number, string>): {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
  requests: string[];
} {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (url: string) => {
      requests.push(url);
      const page = /page=(\d+)/.exec(url)?.[1] ?? "0";
      const body = pages[Number(page)];
      if (body === undefined) throw new Error(`unexpected page ${page}`);
      return { ok: true, status: 200, text: async () => body };
    },
  };
}

const BASE_SETTINGS = {
  userId: "u",
  apiKey: "k",
  engine: "yandex" as const,
  limit: 20,
  region: "",
  language: "",
  device: "desktop" as const,
  timeoutMs: 5000,
};

describe("xmlstock adapter", () => {
  test("yandex: strips hlword/CDATA, dedups normalized URLs, single request covers limit", async () => {
    const stub = stubFetch({ 1: YANDEX_PAGE });
    const results = await xmlstockSearch(BASE_SETTINGS, { query: "incus", limit: 1 }, stub.fetch);
    assert.equal(stub.requests.length, 1, "one provider request when one page fills the window");
    assert.equal(results.length, 1, "exact-duplicate normalized URL dropped");
    const first = results[0];
    assert.ok(first !== undefined);
    assert.equal(first.rank, 1);
    assert.equal(first.title, "Guide incus part 1");
    assert.equal(first.snippet, "How to run incus containers");
    assert.equal(first.domain, "docs.example.org");
    assert.equal(first.published_hint, "2026-01-01");
    assert.equal(first.normalized_url, "https://docs.example.org/guide/page-1");
    const ajv = new Ajv();
    assert.equal(
      ajv.compile(outputSchemaOf("search"))({
        provider: "xmlstock",
        engine: "yandex",
        query: "incus",
        count: results.length,
        trust: "untrusted_external",
        results,
      }),
      true,
    );
  });

  test("google: passages shape, no domain → derived from URL; pages are 0-based", async () => {
    const stub = stubFetch({
      0: GOOGLE_PAGE,
      1: GOOGLE_PAGE.replace("example.com/a", "example.com/b"),
    });
    const results = await xmlstockSearch(
      { ...BASE_SETTINGS, engine: "google" },
      { query: "test", limit: 2 },
      stub.fetch,
    );
    assert.deepEqual(
      stub.requests.map((url) => /page=(\d+)/.exec(url)?.[1]),
      ["0", "1"],
    );
    assert.equal(results.length, 2);
    assert.equal(results[1]?.domain, "example.com");
  });

  test("in-document provider errors map to typed families", async () => {
    const captcha = stubFetch({
      1: '<response><error code="15">captcha required</error></response>',
    });
    await assert.rejects(
      xmlstockSearch(BASE_SETTINGS, { query: "captcha query" }, captcha.fetch),
      expectResearchError("RESEARCH_SEARCH_PROVIDER_ERROR"),
    );
    const balance = stubFetch({
      1: '<response><error code="97">account balance exceeded</error></response>',
    });
    await assert.rejects(
      xmlstockSearch(BASE_SETTINGS, { query: "balance query" }, balance.fetch),
      expectResearchError("RESEARCH_SEARCH_BALANCE_OR_QUOTA"),
    );
  });

  test("HTTP auth rejection and invalid query", async () => {
    const unauthorized = {
      requests: [] as string[],
      fetch: async () => ({ ok: false, status: 401, text: async () => "" }),
    };
    await assert.rejects(
      xmlstockSearch(BASE_SETTINGS, { query: "auth query" }, unauthorized.fetch),
      expectResearchError("RESEARCH_SEARCH_AUTH_FAILED"),
    );
    await assert.rejects(
      xmlstockSearch(BASE_SETTINGS, { query: "x" }, stubFetch({ 1: YANDEX_PAGE }).fetch),
      expectResearchError("RESEARCH_SEARCH_QUERY_INVALID"),
    );
  });

  test("normalization helpers", () => {
    assert.equal(
      normalizeResultUrl("HTTP://Example.com:80/a?b=1#frag"),
      "http://example.com/a?b=1",
    );
    assert.equal(normalizeResultUrl("ftp://example.com/"), null);
    assert.equal(registrableDomain("www.example.co.uk"), "example.co.uk");
    assert.equal(registrableDomain("docs.example.org"), "example.org");
    assert.equal(textOf({ "#text": "a", __cdata: "b" }).length > 0, true);
  });
});

describe("SSRF admission corpus", () => {
  const allowedPorts = [80, 443];

  test("rejects forbidden URLs before any network activity", () => {
    const rejected: readonly [string, string][] = [
      ["file:///etc/passwd", "RESEARCH_FETCH_URL_SCHEME"],
      ["ftp://example.com/", "RESEARCH_FETCH_URL_SCHEME"],
      ["https://user:pass@example.com/", "RESEARCH_FETCH_URL_CREDENTIALS"],
      ["https://example.com:8443/", "RESEARCH_FETCH_URL_PORT"],
      ["http://localhost/", "RESEARCH_FETCH_URL_HOST"],
      ["http://nas.local/", "RESEARCH_FETCH_URL_HOST"],
      ["http://127.0.0.1/", "RESEARCH_FETCH_SSRF_BLOCKED"],
      ["http://10.0.0.1/", "RESEARCH_FETCH_SSRF_BLOCKED"],
      ["http://169.254.169.254/latest/meta-data/", "RESEARCH_FETCH_SSRF_BLOCKED"],
      ["http://[::1]/", "RESEARCH_FETCH_SSRF_BLOCKED"],
      ["http://[fc00::1]/", "RESEARCH_FETCH_SSRF_BLOCKED"],
      ["http://[::ffff:10.0.0.1]/", "RESEARCH_FETCH_SSRF_BLOCKED"],
    ];
    for (const [url, code] of rejected) {
      assert.throws(
        () => parsePublicHttpUrl(url, allowedPorts),
        (error: unknown) => error instanceof ResearchError && error.code === code,
        `expected ${code} for ${url}`,
      );
    }
    for (const url of ["http://example.com/", "https://example.com/x?y=1"]) {
      assert.doesNotThrow(() => parsePublicHttpUrl(url, allowedPorts));
    }
  });

  test("IP byte checks (no string prefixes)", () => {
    const blocked = [
      "127.0.0.1",
      "127.8.8.8",
      "10.1.2.3",
      "172.16.0.9",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.1.1",
      "0.0.0.0",
      "100.64.0.1",
      "100.127.255.255",
      "224.0.0.1",
      "240.0.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:192.168.0.1",
      "::",
    ];
    for (const ip of blocked) assert.equal(isBlockedIpString(ip), true, ip);
    // DNS names are NOT address literals — never "blocked" by the byte check
    // (regression: true-for-non-IP made cloud vision endpoints look local).
    assert.equal(isBlockedIpString("openrouter.ai"), false);
    assert.equal(isBlockedIpString("example.com"), false);
    const allowed = ["1.1.1.1", "93.184.216.34", "100.128.0.1", "172.32.0.1", "2606:4700::1111"];
    for (const ip of allowed) assert.equal(isBlockedIpString(ip), false, ip);
    assert.deepEqual(expandIpv6("fe80::1").slice(0, 2), [0xfe, 0x80]);
  });

  test("resolveAndPin: rejects when ANY resolved address is private, pins the first public one", async () => {
    const lookup = async (
      _host: string,
    ): Promise<readonly { address: string; family: number }[]> => [
      { address: "1.2.3.4", family: 4 },
      { address: "192.168.0.5", family: 4 },
    ];
    await assert.rejects(
      resolveAndPin("rebind.example.org", lookup),
      expectResearchError("RESEARCH_FETCH_SSRF_BLOCKED"),
    );
    const pinned = await resolveAndPin("ok.example.org", async () => [
      { address: "1.2.3.4", family: 4 },
      { address: "5.6.7.8", family: 4 },
    ]);
    assert.equal(pinned.host, "1.2.3.4");
  });
});

describe("safe fetch transport", () => {
  let server: Server;
  let baseUrl: string;
  const testTargets = { allowPrivateTargets: true };

  const settings = {
    redirectLimit: 5,
    maxResponseBytes: 64 * 1024,
    maxDecompressedBytes: 64 * 1024,
    totalTimeoutMs: 5000,
    allowedPorts: [80, 443] as number[],
  };
  const directPolicy = { mode: "direct" as const };
  const fallbackPolicy = { mode: "direct_then_socks5" as const };

  before(async () => {
    server = createServer((request, response) => {
      const url = request.url ?? "/";
      if (url === "/html") {
        response.writeHead(200, { "content-type": "text/html; charset=windows-1251" });
        // "привет" as windows-1251 bytes (Buffer cannot encode it directly).
        response.end(Buffer.from([0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
        return;
      }
      if (url === "/redirect") {
        response.writeHead(302, { location: "/target" });
        response.end();
        return;
      }
      if (url === "/target") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("target reached");
        return;
      }
      if (url === "/scheme-hop") {
        response.writeHead(302, { location: "ftp://example.com/x" });
        response.end();
        return;
      }
      if (url === "/big-header") {
        response.writeHead(200, { "content-length": String(10 * 1024 * 1024) });
        response.end("x");
        return;
      }
      if (url === "/big-stream") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("y".repeat(200 * 1024));
        return;
      }
      if (url === "/unauthorized") {
        response.writeHead(401).end();
        return;
      }
      if (url === "/missing") {
        response.writeHead(404).end();
        return;
      }
      if (url === "/limited") {
        response.writeHead(429).end();
        return;
      }
      if (url === "/broken") {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    settings.allowedPorts.push(Number(new URL(baseUrl).port));
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test("happy path: status/content-type/bytes/final_url", async () => {
    const result = await safeFetch(`${baseUrl}/html`, settings, directPolicy, testTargets);
    assert.equal(result.status, 200);
    assert.match(result.contentType, /text\/html/);
    assert.match(decodeBody(result.bytes, result.contentType).text, /привет/);
    assert.equal(decodeBody(result.bytes, result.contentType).charset, "windows-1251");
    assert.equal(result.finalUrl, `${baseUrl}/html`);
    assert.equal(result.networkPath, "direct");
  });

  test("redirect hop followed with re-admission; scheme downgrade hop rejected", async () => {
    const followed = await safeFetch(`${baseUrl}/redirect`, settings, directPolicy, testTargets);
    assert.equal(followed.finalUrl, `${baseUrl}/target`);
    await assert.rejects(
      safeFetch(`${baseUrl}/scheme-hop`, settings, directPolicy, testTargets),
      expectResearchError("RESEARCH_FETCH_URL_SCHEME"),
    );
  });

  test("size caps: Content-Length is a hint, streaming is enforced", async () => {
    await assert.rejects(
      safeFetch(`${baseUrl}/big-header`, settings, directPolicy, testTargets),
      expectResearchError("RESEARCH_FETCH_CONTENT_TOO_LARGE"),
    );
    await assert.rejects(
      safeFetch(`${baseUrl}/big-stream`, settings, directPolicy, testTargets),
      expectResearchError("RESEARCH_FETCH_CONTENT_TOO_LARGE"),
    );
  });

  test("HTTP status policy is semantic, not transport", async () => {
    const cases: readonly [string, string][] = [
      ["/unauthorized", "RESEARCH_FETCH_HTTP_BLOCKED"],
      ["/missing", "RESEARCH_FETCH_HTTP_NOT_FOUND"],
      ["/limited", "RESEARCH_FETCH_HTTP_RATE_LIMITED"],
      ["/broken", "RESEARCH_FETCH_HTTP_UPSTREAM_ERROR"],
    ];
    for (const [path, code] of cases) {
      await assert.rejects(
        safeFetch(`${baseUrl}${path}`, settings, directPolicy, testTargets),
        expectResearchError(code),
      );
    }
  });

  test("direct_then_socks5 serves a reachable target directly (no hidden proxy need)", async () => {
    const result = await safeFetch(`${baseUrl}/target`, settings, fallbackPolicy, testTargets);
    assert.equal(result.networkPath, "direct_then_socks5");
    assert.equal(result.bytes.toString(), "target reached");
  });
});

describe("HTML extraction", () => {
  const ARTICLE = `<html><head><title>Site title</title>
    <meta name="description" content="About incus">
    <link rel="canonical" href="https://example.com/canonical">
    <meta property="article:published_time" content="2026-01-02T00:00:00Z"></head>
  <body>
    <nav><a href="/nav">Nav</a></nav>
    <article>
      <h1>Incus containers</h1>
      <p>Первая абзац про Incus и системные контейнеры для малого бизнеса.</p>
      <p>Incus позволяет запускать контейнеры и виртуальные машины через простой интерфейс командной строки на любом Linux сервере.</p>
      <p>Администраторы экономят ресурсы и получают изоляцию окружений.</p>
      <h2>Возможности</h2>
      <ul><li>Контейнеры</li><li>Виртуальные машины</li></ul>
      <table><tr><th>Ключ</th><th>Значение</th></tr><tr><td>a</td><td>b</td></tr></table>
      <pre><code>incus launch images:ubuntu</code></pre>
      <p>Read <a href="https://other.example.org/docs">docs</a>.</p>
    </article>
    <div class="cookie">We use cookies</div>
    <script>alert(1)</script>
    <noscript>Enable JavaScript</noscript>
    <form><input name="q"></form>
  </body></html>`;

  test("article extraction: headings/lists/tables/code survive; chrome removed", () => {
    const result = extractHtml(ARTICLE, {
      baseUrl: "https://example.com/article",
      maxChars: 60_000,
      includeLinks: true,
    });
    assert.match(result.markdown, /#{1,3} Incus containers/);
    assert.match(result.markdown, /## Возможности/);
    assert.match(result.markdown, /-\s+Контейнеры/);
    assert.match(result.markdown, /\|\s*Ключ\s*\|/i);
    assert.match(result.markdown, /incus launch images:ubuntu/);
    assert.match(result.markdown, /\[docs\]\(https:\/\/other\.example\.org\/docs\)/);
    assert.doesNotMatch(result.markdown, /cookies|Nav|alert\(1\)|Enable JavaScript/);
    assert.equal(result.title, "Site title"); // Readability's scored pick
    assert.equal(result.description, "About incus");
    assert.equal(result.canonicalUrl, "https://example.com/canonical");
    assert.equal(result.publishedAtHint, "2026-01-02T00:00:00Z");
    assert.ok(result.wordCount > 5);
    assert.equal(result.quality, "good");
    assert.equal(result.truncated, false);
    assert.ok(result.links?.some((link) => link.url === "https://other.example.org/docs"));
  });

  test("JS shell heuristics trigger only on real insufficiency", () => {
    const shell = extractHtml(
      "<html><body><div id=root></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>",
      { baseUrl: "https://spa.example.org/", maxChars: 60_000, includeLinks: false },
    );
    assert.equal(looksLikeJsShell(shell), true);
    const article = extractHtml(ARTICLE, {
      baseUrl: "https://example.com/article",
      maxChars: 60_000,
      includeLinks: false,
    });
    assert.equal(looksLikeJsShell(article), false);
  });

  test("malformed HTML and tiny pages degrade honestly", () => {
    const malformed = extractHtml("<html><body><p>Незакрытый текст<p>ещё", {
      baseUrl: "https://example.com/x",
      maxChars: 60_000,
      includeLinks: false,
    });
    assert.ok(malformed.markdown.length > 0);
    const tiny = extractHtml("<html><body><p>ok</p></body></html>", {
      baseUrl: "https://example.com/y",
      maxChars: 60_000,
      includeLinks: false,
    });
    assert.notEqual(tiny.quality, "good");
  });

  test("truncation is bounded and flagged", () => {
    const result = extractHtml(ARTICLE, {
      baseUrl: "https://example.com/article",
      maxChars: 50,
      includeLinks: false,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.charCount, 50);
  });

  test("text passthrough for json/xml without article pretense", () => {
    const json = extractTextPassthrough('{"a": 1}', {
      baseUrl: "https://api.example.org/x",
      maxChars: 60_000,
      includeLinks: false,
    });
    assert.equal(json.markdown, '{"a": 1}');
    assert.equal(json.headings.length, 0);
  });
});

// ---- Real PDF fixtures (generated once via Chromium, committed) ----

function fixtureBytes(name: string): Buffer {
  return readFileSync(`tests/extensions/fixtures/${name}`);
}

describe("PDF pipeline", () => {
  const visionSettings = {
    enabled: true,
    baseUrl: "https://vision.example.org/v1",
    model: "vision-test",
    apiKey: "k",
    timeoutMs: 5000,
    maxPages: 4,
  };

  test("native text layer: per-page markers, sufficient gate", async () => {
    const result = await extractPdfText(fixtureBytes("sample-text.pdf"));
    assert.ok(result.pageCount >= 1);
    assert.equal(result.textSufficient, true);
    assert.match(result.markdown, /## Page 1/);
    assert.match(result.markdown, /Incus provides system containers/i);
  });

  test("scanned PDF (no text) fails the gate; pages render to bounded images", async () => {
    const pdf = fixtureBytes("sample-scanned.pdf");
    const result = await extractPdfText(pdf);
    assert.equal(result.textSufficient, false);
    const images = await renderPdfPages(pdf, { maxPages: 2 });
    assert.equal(images.length, 1);
    assert.equal(images[0]?.mime, "image/jpeg");
    assert.ok((images[0]?.data.length ?? 0) > 1000, "rendered page carries visible bytes");
  });

  test("vision transcriber: data-URL request shape and markdown extraction", async () => {
    let capturedBody: unknown = null;
    const doFetch: VisionFetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body) as unknown;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "# Transcribed page\n\nVisible text here" } }],
        }),
      };
    };
    const markdown = await visionTranscribe(
      [{ mime: "image/jpeg", data: Buffer.from("fakejpeg"), locator: "page 1 of 2" }],
      { url: "https://example.org/scan.pdf", kind: "scanned PDF document (2 pages)" },
      visionSettings,
      doFetch,
    );
    assert.match(markdown, /Transcribed page/);
    const messages = (capturedBody as { messages?: unknown }).messages as unknown[];
    assert.equal(messages?.length, 2);
    const user = messages?.[1] as { content: { type: string; image_url?: { url: string } }[] };
    const image = user.content.find((part) => part.type === "image_url");
    assert.match(image?.image_url?.url ?? "", /^data:image\/jpeg;base64,/);
  });

  test("vision failure surfaces typed errors (auth, empty content)", async () => {
    const unauthorized: VisionFetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    await assert.rejects(
      visionTranscribe(
        [{ mime: "image/png", data: Buffer.from("x"), locator: "p1" }],
        { url: "https://example.org/", kind: "page" },
        visionSettings,
        unauthorized,
      ),
      expectResearchError("RESEARCH_FETCH_VISION_FAILED"),
    );
    const empty: VisionFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "" } }] }),
    });
    await assert.rejects(
      visionTranscribe(
        [{ mime: "image/png", data: Buffer.from("x"), locator: "p1" }],
        { url: "https://example.org/", kind: "page" },
        visionSettings,
        empty,
      ),
      expectResearchError("RESEARCH_FETCH_VISION_FAILED"),
    );
  });
});

describe("browser render fallback (skips when no browser binary)", () => {
  test("JS shell renders, screenshot captured, subresource policy active", async (t) => {
    const { browserIsAvailable } = await import(
      "../../extensions/progressive-web-research/src/render.js"
    );
    if (!(await browserIsAvailable())) return t.skip("no Playwright browser at this host");
    let server: Server | null = null;
    try {
      server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<html><body><div id="root"></div><script>' +
            'document.getElementById("root").textContent = "client side rendered body text";' +
            "</script></body></html>",
        );
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server!.address() as AddressInfo).port;
      const result = await browserRender({
        url: `http://127.0.0.1:${String(port)}/`,
        timeoutMs: 15_000,
        captureScreenshot: true,
        allowPrivateTargets: true, // test-only local fixture target
      });
      assert.match(result.html, /client side rendered body text/);
      assert.ok(result.screenshot !== undefined, "screenshot captured for vision");
      assert.equal(result.blockedChallenge, false);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });
});

describe("operation handlers", () => {
  test("search: config missing fails typed; adapter output passes manifest schema", async () => {
    await assert.rejects(
      search({
        input: { query: "test" },
        actor: { id: "a", type: "service" },
        requestId: "r",
        extension: { id: "progressive.web-research", config: null },
      }),
      expectResearchError("RESEARCH_SEARCH_CONFIG_MISSING"),
    );
    await assert.rejects(
      search({
        input: { query: "test" },
        actor: { id: "a", type: "service" },
        requestId: "r",
        extension: { id: "progressive.web-research", config: {} },
      }),
      expectResearchError("RESEARCH_SEARCH_CONFIG_MISSING"),
    );
  });

  test("fetch: private URL rejected at the operation boundary before network", async () => {
    await assert.rejects(
      fetchPage({
        input: { url: "http://169.254.169.254/latest/meta-data/" },
        actor: { id: "a", type: "service" },
        requestId: "r",
        extension: { id: "progressive.web-research", config: {} },
      }),
      expectResearchError("RESEARCH_FETCH_SSRF_BLOCKED"),
    );
  });
});
