// PCMS-MEDIA-T021/T022 — remote import SSRF protection and bounded
// redirects: loopback/link-local/private/metadata targets are blocked by
// default, every redirect hop is revalidated, bytes/time are capped, and
// the successful path feeds the same upload pipeline.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

type AddressInfo = { address: string; family: string; port: number };

import {
  DEFAULT_REMOTE_IMPORT_LIMITS,
  fetchRemoteMedia,
  InMemoryMediaStorage,
  MediaError,
  type RemoteFetchDependencies,
  type RemoteImportLimits,
  uploadMedia,
} from "@pcms/media";
import sharp from "sharp";

const LIMITS: RemoteImportLimits = { ...DEFAULT_REMOTE_IMPORT_LIMITS, timeoutMs: 2000 };

function blockedLookup(address: string): RemoteFetchDependencies {
  // Pretend DNS resolved the hostname to the target address — validation
  // must still catch it (this is also the DNS-rebinding simulation).
  const family = address.includes(":") ? 6 : 4;
  return { lookup: async () => [{ address, family }] };
}

async function expectBlocked(
  url: string,
  deps: RemoteFetchDependencies = {},
  why?: string,
): Promise<void> {
  await assert.rejects(
    fetchRemoteMedia(url, LIMITS, deps),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_IMPORT_SSRF_BLOCKED",
    why ?? url,
  );
}

test("loopback, link-local, metadata, private and reserved targets are blocked", async () => {
  await expectBlocked("http://127.0.0.1/media/secret.jpg", undefined, "loopback IPv4");
  await expectBlocked("http://127.3.4.5/x", blockedLookup("127.3.4.5"), "loopback range");
  await expectBlocked(
    "http://169.254.169.254/latest/meta-data/",
    blockedLookup("169.254.169.254"),
    "cloud metadata",
  );
  await expectBlocked("http://10.1.2.3/x", blockedLookup("10.1.2.3"), "RFC1918 10/8");
  await expectBlocked("http://192.168.0.10/x", blockedLookup("192.168.0.10"), "RFC1918 192.168");
  await expectBlocked("http://172.16.5.5/x", blockedLookup("172.16.5.5"), "RFC1918 172.16/12");
  await expectBlocked("http://100.64.0.1/x", blockedLookup("100.64.0.1"), "CGNAT");
  await expectBlocked("http://0.0.0.0/x", blockedLookup("0.0.0.0"), "unspecified");
  await expectBlocked("http://224.0.0.1/x", blockedLookup("224.0.0.1"), "multicast");
  await expectBlocked("http://[::1]/x", blockedLookup("::1"), "loopback IPv6");
  await expectBlocked("http://[fe80::1]/x", blockedLookup("fe80::1"), "link-local IPv6");
  await expectBlocked("http://[fd00::5]/x", blockedLookup("fd00::5"), "unique local IPv6");
  await expectBlocked(
    "http://[::ffff:10.0.0.7]/x",
    blockedLookup("::ffff:10.0.0.7"),
    "IPv4-mapped private",
  );
});

test("non-http schemes and credential URLs are rejected", async () => {
  await assert.rejects(
    fetchRemoteMedia("ftp://cdn.example.com/a.png", LIMITS),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_IMPORT_URL_INVALID",
  );
  await assert.rejects(
    fetchRemoteMedia("file:///etc/passwd", LIMITS),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_IMPORT_URL_INVALID",
  );
  await assert.rejects(
    fetchRemoteMedia("https://user:pass@example.com/a.png", LIMITS),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_IMPORT_URL_INVALID",
  );
  await assert.rejects(
    fetchRemoteMedia("not a url", LIMITS),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_IMPORT_URL_INVALID",
  );
});

test("redirects are bounded and every hop is revalidated (redirect SSRF)", async (t) => {
  const server = await startServer(t, (req, res) => {
    // Bounce toward the cloud metadata endpoint — must be blocked at hop 2.
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });
  await assert.rejects(
    fetchRemoteMedia(`http://127.0.0.1:${port(server)}/hop`, LIMITS, {
      // First hop: pretend the test server is a public host; IP-literal
      // hostnames resolve to themselves so the metadata hop is validated.
      lookup: async (hostname) => {
        if (hostname === "rebind.test") return [{ address: "127.0.0.1", family: 4 }];
        if (hostname.includes(":")) return [{ address: hostname, family: 6 }];
        if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return [{ address: hostname, family: 4 }];
        return [{ address: "93.184.216.34", family: 4 }];
      },
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_IMPORT_SSRF_BLOCKED",
    "redirect to a blocked address must fail",
  );

  const loop = await startServer(t, (req, res) => {
    res.writeHead(302, { location: "/hop-again" });
    res.end();
  });
  await assert.rejects(
    fetchRemoteMedia(
      `http://rebind.test:${port(loop)}/start`,
      { ...LIMITS, maxRedirects: 2 },
      {
        fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
          const target =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          return fetch(target.replace("rebind.test", "127.0.0.1"), init);
        }) as typeof fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    ),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_IMPORT_REDIRECT_LIMIT",
    "redirect loops hit the bound",
  );
});

test("response byte cap and timeout are enforced", async (t) => {
  const big = await startServer(t, (req, res) => {
    res.writeHead(200, { "content-length": String(10 * 1024 * 1024) });
    res.write(Buffer.alloc(1024, 1));
    // keep the response open — the cap must fire while streaming
  });
  await assert.rejects(
    fetchRemoteMedia(`http://127.0.0.1:${port(big)}/big`, {
      ...LIMITS,
      maxBytes: 512,
      allowPrivateAddresses: true,
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TOO_LARGE",
  );

  const slow = await startServer(t, (req, res) => {
    // never respond
    req.on("close", () => res.destroy());
  });
  await assert.rejects(
    fetchRemoteMedia(`http://127.0.0.1:${port(slow)}/slow`, {
      ...LIMITS,
      timeoutMs: 120,
      allowPrivateAddresses: true,
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_IMPORT_TIMEOUT",
  );
});

test("successful import flows through the upload pipeline (trusted policy)", async (t) => {
  const bytes = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 20, g: 120, b: 220 } },
  })
    .png()
    .toBuffer();
  const server = await startServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(bytes);
  });
  const fetched = await fetchRemoteMedia(`http://127.0.0.1:${port(server)}/logo.png`, {
    ...LIMITS,
    allowPrivateAddresses: true,
  });
  assert.equal(fetched.contentType, "image/png");

  const { createDbPool, loadMigrations, migrateDatabase } = await import("@pcms/core");
  const { assertBaseReachable, connectionInfo, createTestDatabase, testDatabaseConfigured } =
    await import("../helpers/testdb.js");
  if (!testDatabaseConfigured()) return;
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const accepted = await uploadMedia(
    {
      pool,
      storage: new InMemoryMediaStorage(),
      quarantine: new InMemoryMediaStorage(),
      limits: {
        maxUploadBytes: LIMITS.maxBytes,
        maxImagePixels: 64_000_000,
        maxImageDimension: 16_384,
      },
    },
    {
      bytes: fetched.body,
      filename: "logo.png",
      declaredMimeType: fetched.contentType ?? undefined,
      createdBy: "import-agent",
    },
  );
  assert.equal(accepted.asset.kind, "image");
  assert.equal(accepted.asset.width, 40);
});

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

async function startServer(
  t: { after: (fn: () => void) => void },
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
  });
  return server;
}
