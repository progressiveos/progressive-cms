// PCMS-INT-T011 — SSRF bypass attack corpus (security-critical P0).
// Deterministic: DNS is injected, so every "resolution" is scripted — no
// packet leaves the machine. Proves the guard neutralizes the standard
// bypass families plus redirect re-evaluation on a real socket loop.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  createGuardedHttp,
  createSsrfGuard,
  isBlockedAddress,
  type ResolvedAddress,
  SsrfBlockedError,
  type SsrfPolicy,
} from "@pcms/integrations";

/** example.com's well-known public documentation address. */
const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC6: ResolvedAddress = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };

function policyWith(
  answers: Record<string, readonly ResolvedAddress[]>,
  extra?: Partial<SsrfPolicy>,
): SsrfPolicy {
  return {
    resolve: async (hostname) => {
      const hit = answers[hostname];
      if (hit === undefined) throw new Error("NXDOMAIN");
      return hit;
    },
    ...extra,
  };
}

async function blockedBy(policy: SsrfPolicy, url: string, messageIncludes?: string) {
  const guard = createSsrfGuard(policy);
  await assert.rejects(guard.assertAllowed(url, "none"), (error: unknown) => {
    assert.ok(error instanceof SsrfBlockedError, `${url} must be blocked`);
    if (messageIncludes !== undefined) {
      assert.ok(error.message.includes(messageIncludes), `${url}: ${error.message}`);
    }
    return true;
  });
}

test("literal and range blocks: loopback, private, link-local, metadata, CGNAT, v6", async () => {
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://127.0.0.1/x");
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://10.1.2.3/x");
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://172.16.0.9/x");
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://192.168.1.1/x");
  await blockedBy(
    policyWith({ "x.example": [PUBLIC] }),
    "http://169.254.169.254/latest/meta-data/",
  );
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://100.64.0.1/x");
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://0.0.0.0/x");
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://[::1]/x");
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://[fe80::1]/x");
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://[fd00::1]/x");
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://[::ffff:10.0.0.1]/x");
});

test("alternate IP spellings resolve into blocked addresses, not trusted strings", async () => {
  // Decimal, hex, octal forms of 127.0.0.1 — resolution lands on loopback.
  await blockedBy(
    policyWith({ "2130706433": [{ address: "127.0.0.1", family: 4 }] }),
    "http://2130706433/",
  );
  await blockedBy(
    policyWith({ "0x7f.0.0.1": [{ address: "127.0.0.1", family: 4 }] }),
    "http://0x7f.0.0.1/",
  );
});

test("DNS attacks: attacker host -> private IP; mixed answers fail secure", async () => {
  // Hostname→private-IP rebinding primitive.
  await blockedBy(
    policyWith({ "attacker.example": [{ address: "10.0.0.5", family: 4 }] }),
    "https://attacker.example/",
  );
  // One public + one private answer: blocked (fail-secure).
  await blockedBy(
    policyWith({ "mixed.example": [PUBLIC, { address: "192.168.0.20", family: 4 }] }),
    "https://mixed.example/",
  );
});

test("scheme and credential hardening", async () => {
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "file:///etc/passwd");
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "gopher://x.example/");
  await blockedBy(policyWith({ "x.example": [PUBLIC] }), "http://user:pw@x.example/");
});

test("redirect chain: every hop revalidated; loop beyond the bound refused", async () => {
  await new Promise<void>((resolveTest, rejectTest) => {
    const server = createServer((request, response) => {
      if (request.url === "/hop1") {
        // Hop 2 targets the metadata endpoint — must be refused even though
        // hop 1 was a perfectly public host.
        response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        response.end();
        return;
      }
      if (request.url === "/loop") {
        response.writeHead(302, { location: "/loop" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      // Allow the loopback TEST SERVER only (privileged allowlist) so the
      // guard exercises redirect logic on real sockets without touching a
      // public network.
      const fetch = createGuardedHttp({
        allowedHosts: ["127.0.0.1"],
        maxRedirects: 3,
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      });
      (async () => {
        try {
          const ok = await fetch({ method: "GET", url: `http://127.0.0.1:${port}/ok` });
          assert.equal(ok.status, 200);
          assert.equal(ok.body, '{"ok":true}');
          // Hop 2 → metadata range: blocked at revalidation.
          await assert.rejects(
            fetch({ method: "GET", url: `http://127.0.0.1:${port}/hop1` }),
            (error: unknown) => error instanceof SsrfBlockedError,
          );
          // Self-loop exceeds the hop bound.
          await assert.rejects(
            fetch({ method: "GET", url: `http://127.0.0.1:${port}/loop` }),
            (error: unknown) =>
              /redirect count exceeds/.test(error instanceof Error ? error.message : ""),
          );
          // Response size cap.
          const big = createServer((_q, response) => {
            response.writeHead(200);
            response.end("x".repeat(3_000_000));
          });
          big.listen(0, "127.0.0.1", () => {
            const bigPort = (big.address() as { port: number }).port;
            const capped = createGuardedHttp({
              allowedHosts: ["127.0.0.1"],
              maxResponseBytes: 1024,
              resolve: async () => [{ address: "127.0.0.1", family: 4 }],
            });
            void assert
              .rejects(
                capped({ method: "GET", url: `http://127.0.0.1:${bigPort}/` }),
                (error: unknown) =>
                  /response exceeds/.test(error instanceof Error ? error.message : ""),
              )
              .then(() => {
                big.close();
                server.close();
                resolveTest();
              });
          });
        } catch (error) {
          server.close();
          rejectTest(error as Error);
        }
      })();
    });
  });
});

test("privileged escapes: explicit allowlist and allow-private toggle", async () => {
  // Exact internal allowlist permits a loopback host WITHOUT address checks.
  const guard = createSsrfGuard({
    allowedHosts: ["metadata.internal"],
    resolve: async () => [{ address: "169.254.169.254", family: 4 }],
  });
  await guard.assertAllowed("http://metadata.internal/v1", "none");
  // ...but a sibling host on the same resolver is still blocked.
  await assert.rejects(guard.assertAllowed("http://other.internal/v1", "none"));

  // Privileged allow-private toggle (self-hosted internal deployments).
  const permissive = createSsrfGuard({
    allowPrivateAddresses: true,
    resolve: async () => [{ address: "192.168.10.5", family: 4 }],
  });
  await permissive.assertAllowed("http://internal.example/", "none");
});

test("isBlockedAddress range unit probes (defense in depth)", () => {
  assert.equal(isBlockedAddress("127.0.0.1", 4), true);
  assert.equal(isBlockedAddress("169.254.169.254", 4), true);
  assert.equal(isBlockedAddress("93.184.216.34", 4), false);
  assert.equal(isBlockedAddress("::1", 6), true);
  assert.equal(isBlockedAddress("::ffff:127.0.0.1", 6), true);
  assert.equal(isBlockedAddress("2606:2800:220:1:248:1893:25c8:1946", 6), false);
  assert.equal(isBlockedAddress("not-an-ip", 4), true); // unparseable → fail-secure
  void PUBLIC6;
});

// Regression (owner-reported, first real HQ connection): Node ≥20
// autoSelectFamily calls the custom `lookup` with `all: true` and expects an
// ARRAY of records; answering in the legacy (address, family) shape broke
// connection setup with ERR_INVALID_IP_ADDRESS — invisible on IP-literal
// hosts (127.0.0.1 skips lookup entirely), fatal on real hostnames.
test("guardedHttp connects through a HOSTNAME (autoSelectFamily lookup shape)", async (t) => {
  await new Promise<void>((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("hostname-ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const guardedHttp = createGuardedHttp({
        // Test-only private escape: the fixture server listens on loopback.
        allowPrivateAddresses: true,
        resolve: async (hostname) => {
          if (hostname !== "crm.example.test") throw new Error("NXDOMAIN");
          return [{ address: "127.0.0.1", family: 4 }];
        },
      });
      guardedHttp({
        method: "GET",
        url: `http://crm.example.test:${String(port)}/`,
        timeoutMs: 5_000,
      })
        .then(async (response) => {
          assert.equal(response.status, 200);
          assert.equal(response.body, "hostname-ok");
          server.close(() => resolve());
        })
        .catch((error: unknown) => {
          server.close(() => reject(error as Error));
        });
    });
  });
});
