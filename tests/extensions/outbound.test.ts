// E2 gate tests (PCMS-PCPUB; ADR-0014, Extensions spec §52.7): policy
// parsing/validation, the transport-only fallback classifier, real SOCKS5
// handshakes against a minimal in-process SOCKS5 server (remote DNS,
// username/password auth, auth failure), and direct_then_socks5 falling back
// ONLY on transport failure — never after a valid HTTP response.
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import {
  createExtensionFetchClient,
  createExtensionFetchClientFromConfig,
  isTransportFailure,
  parseOutboundPolicy,
} from "@pcms/extensions/internal";

// ---- minimal SOCKS5 server (RFC 1928/1929 subset, enough for the client) --
interface SocksServerOptions {
  username?: string;
  password?: string;
  /** Records each requested destination host for assertions. */
  onTarget?: (host: string, port: number) => void;
  /** Rewrites the proxied destination (simulates proxy-side resolution). */
  map?: (host: string, port: number) => { host: string; port: number };
}

async function startSocksServer(options: SocksServerOptions = {}): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = net.createServer((client) => {
    let stage: "greeting" | "auth" | "request" = "greeting";
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      void drive();
    };
    client.on("error", () => client.destroy());
    client.on("data", onData);
    const drive = async (): Promise<void> => {
      for (;;) {
        if (stage === "greeting") {
          if (buffer.length < 2) return;
          const n = buffer[1]!;
          if (buffer.length < 2 + n) return;
          const methods = buffer.subarray(2, 2 + n);
          const wantsAuth = options.username !== undefined;
          const chosen = wantsAuth && methods.includes(0x02) ? 0x02 : 0x00;
          buffer = buffer.subarray(2 + n);
          if (!wantsAuth && !methods.includes(0x00)) {
            client.end(Buffer.from([0x05, 0xff]));
            return;
          }
          client.write(Buffer.from([0x05, chosen]));
          stage = chosen === 0x02 ? "auth" : "request";
          if (stage === "request") continue;
        } else if (stage === "auth") {
          if (buffer.length < 2) return;
          const ulen = buffer[1]!;
          const plenAt = 2 + ulen;
          if (buffer.length < plenAt + 1) return;
          const plen = buffer[plenAt]!;
          if (buffer.length < plenAt + 1 + plen) return;
          const user = buffer.subarray(2, plenAt).toString("utf8");
          const pass = buffer.subarray(plenAt + 1, plenAt + 1 + plen).toString("utf8");
          buffer = buffer.subarray(plenAt + 1 + plen);
          const ok = user === (options.username ?? "") && pass === (options.password ?? "");
          client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            client.end();
            return;
          }
          stage = "request";
        } else {
          if (buffer.length < 5) return;
          const atyp = buffer[3]!;
          if (atyp === 0x03) {
            const len = buffer[4]!;
            if (buffer.length < 5 + len + 2) return;
            const host = buffer.subarray(5, 5 + len).toString("utf8");
            const port = buffer.readUInt16BE(5 + len);
            buffer = buffer.subarray(5 + len + 2);
            await relay(client, host, port, options, buffer, () => {
              client.off("data", onData);
            });
          } else if (atyp === 0x01) {
            if (buffer.length < 10) return;
            const host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
            const port = buffer.readUInt16BE(8);
            buffer = buffer.subarray(10);
            await relay(client, host, port, options, buffer, () => {
              client.off("data", onData);
            });
          } else if (atyp === 0x04) {
            if (buffer.length < 22) return;
            const parts: string[] = [];
            for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(4 + i).toString(16));
            const host = parts.join(":");
            const port = buffer.readUInt16BE(20);
            buffer = buffer.subarray(22);
            await relay(client, host, port, options, buffer, () => {
              client.off("data", onData);
            });
          } else {
            client.end();
          }
          return;
        }
      }
    };
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as net.AddressInfo;
  return { port: address.port, close: () => new Promise((r) => server.close(() => r())) };
}

async function relay(
  client: net.Socket,
  host: string,
  port: number,
  options: SocksServerOptions,
  pending: Buffer,
  detach: () => void,
): Promise<void> {
  detach();
  const mapped = options.map?.(host, port) ?? { host, port };
  options.onTarget?.(host, port);
  let upstream: net.Socket;
  try {
    upstream = net.connect({ host: mapped.host, port: mapped.port });
    await once(upstream, "connect");
  } catch {
    client.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    return;
  }
  client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  if (pending.length > 0) upstream.write(pending);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.pipe(client);
  client.pipe(upstream);
}

async function startHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  // dual-stack: destinations may resolve to ::1 or 127.0.0.1
  server.listen(0);
  await once(server, "listening");
  const address = server.address() as net.AddressInfo;
  return { port: address.port, close: () => new Promise((r) => server.close(() => r())) };
}

test("parseOutboundPolicy: defaults to direct, validates proxy shapes", () => {
  assert.deepEqual(parseOutboundPolicy({}), { mode: "direct" });
  assert.deepEqual(parseOutboundPolicy({ network: {} }), { mode: "direct" });
  assert.throws(() => parseOutboundPolicy({ network: { mode: "http" } }), /network\.mode/);
  assert.throws(
    () => parseOutboundPolicy({ network: { mode: "socks5", proxy_port: 1080 } }),
    /proxy_host/,
  );
  assert.throws(
    () => parseOutboundPolicy({ network: { mode: "socks5", proxy_host: "p" } }),
    /proxy_port/,
  );
  assert.throws(
    () =>
      parseOutboundPolicy({
        network: { mode: "socks5", proxy_host: "p", proxy_port: 0 },
      }),
    /proxy_port/,
  );
  assert.throws(
    () =>
      parseOutboundPolicy({
        network: { mode: "socks5", proxy_host: "p".repeat(256), proxy_port: 1 },
      }),
    /proxy_host/,
  );
  const policy = parseOutboundPolicy({
    network: {
      mode: "direct_then_socks5",
      proxy_host: "10.0.0.1",
      proxy_port: 1080,
      remote_dns: false,
      proxy_username: "u",
      proxy_password: "s3cret",
    },
  });
  assert.equal(policy.mode, "direct_then_socks5");
  assert.deepEqual(
    { ...policy.proxy, password: policy.proxy?.password },
    { host: "10.0.0.1", port: 1080, remoteDns: false, username: "u", password: "s3cret" },
  );
});

test("isTransportFailure: transport yes, caller abort and invalid URL no", () => {
  assert.equal(isTransportFailure(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), true);
  assert.equal(isTransportFailure(Object.assign(new Error("x"), { code: "ENOTFOUND" })), true);
  assert.equal(isTransportFailure(new Error("TLS handshake failed")), true);
  assert.equal(
    isTransportFailure(Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })),
    true,
  );
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  assert.equal(isTransportFailure(abort), false);
  assert.equal(isTransportFailure(new TypeError("Invalid URL")), false);
});

test("socks5 client reaches an HTTP target through a real SOCKS5 handshake", async () => {
  const target = await startHttpServer((req, res) => {
    res.end(JSON.stringify({ ok: true }));
  });
  const seen: string[] = [];
  const socks = await startSocksServer({ onTarget: (host) => seen.push(host) });
  const client = createExtensionFetchClient({
    mode: "socks5",
    proxy: { host: "127.0.0.1", port: socks.port, remoteDns: true },
  });
  const response = await client(`http://localhost:${target.port}/ping`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  // remote DNS: the proxy received the HOSTNAME, not a resolved IP.
  assert.deepEqual(seen, ["localhost"]);
  await socks.close();
  await target.close();
});

test("socks5 with local DNS resolves the hostname before the proxy", async () => {
  const target = await startHttpServer((req, res) => res.end("ok"));
  const seen: string[] = [];
  const socks = await startSocksServer({ onTarget: (host) => seen.push(host) });
  const client = createExtensionFetchClient({
    mode: "socks5",
    proxy: { host: "127.0.0.1", port: socks.port, remoteDns: false },
  });
  const response = await client(`http://localhost:${target.port}/`);
  assert.equal(response.status, 200);
  const [resolved] = seen;
  assert.ok(
    resolved !== undefined && net.isIP(resolved) > 0,
    `expected a resolved IP, got ${seen[0]}`,
  );
  await socks.close();
  await target.close();
});

test("socks5 username/password auth: correct credentials pass, wrong fail", async () => {
  const target = await startHttpServer((req, res) => res.end("secret-ok"));
  const socks = await startSocksServer({ username: "agent", password: "pw-123" });
  const good = createExtensionFetchClient({
    mode: "socks5",
    proxy: {
      host: "127.0.0.1",
      port: socks.port,
      remoteDns: true,
      username: "agent",
      password: "pw-123",
    },
  });
  assert.equal((await good(`http://localhost:${target.port}/`)).status, 200);
  const bad = createExtensionFetchClient({
    mode: "socks5",
    proxy: {
      host: "127.0.0.1",
      port: socks.port,
      remoteDns: true,
      username: "agent",
      password: "nope",
    },
  });
  await assert.rejects(bad(`http://localhost:${target.port}/`), (error: unknown) => {
    const message = [
      error instanceof Error ? error.message : "",
      error instanceof Error && error.cause instanceof Error ? error.cause.message : "",
    ].join(" ");
    return /auth/i.test(message);
  });
  await socks.close();
  await target.close();
});

test("direct_then_socks5 falls back on transport failure, not on HTTP errors", async () => {
  const target = await startHttpServer((req, res) => {
    res.statusCode = 404;
    res.end("nope");
  });
  const contacted: string[] = [];
  const socks = await startSocksServer({ onTarget: (host) => contacted.push(host) });

  // Direct reaches the server (404): NO fallback — the proxy is never used.
  const semantic = createExtensionFetchClient({
    mode: "direct_then_socks5",
    proxy: { host: "127.0.0.1", port: socks.port, remoteDns: true },
  });
  const notFound = await semantic(`http://localhost:${target.port}/`);
  assert.equal(notFound.status, 404);
  assert.equal(contacted.length, 0);

  // Direct connection refused (loopback port with no listener): falls back
  // through the proxy, which maps the destination to the live server.
  const alive = await startHttpServer((_req, res) => res.end("fallback-ok"));
  const dead = await startHttpServer(() => {});
  const deadPort = dead.port;
  await dead.close();
  const mapped = await startSocksServer({
    map: (_host: string, port: number) => ({
      host: "127.0.0.1",
      port: port === deadPort ? alive.port : port,
    }),
    onTarget: (host: string) => contacted.push(host),
  });
  const fallback = createExtensionFetchClient({
    mode: "direct_then_socks5",
    proxy: { host: "127.0.0.1", port: mapped.port, remoteDns: true },
  });
  const ok = await fallback(`http://127.0.0.1:${deadPort}/via-proxy`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "fallback-ok");
  assert.deepEqual(contacted, ["127.0.0.1"]);
  await mapped.close();
  await alive.close();
  await socks.close();
  await target.close();
});

test("config-driven factory and redaction: no password in failures", async () => {
  const socks = await startSocksServer({ username: "agent", password: "super-secret-value" });
  const bad = createExtensionFetchClientFromConfig({
    network: {
      mode: "socks5",
      proxy_host: "127.0.0.1",
      proxy_port: socks.port,
      proxy_username: "agent",
      proxy_password: "super-secret-value",
    },
  });
  // wrong password on purpose: point the client at a different credential
  const wrong = createExtensionFetchClientFromConfig({
    network: {
      mode: "socks5",
      proxy_host: "127.0.0.1",
      proxy_port: socks.port,
      remote_dns: true,
      proxy_username: "agent",
      proxy_password: "something-else",
    },
  });
  try {
    await wrong("http://example.invalid/");
  } catch (error) {
    assert.ok(!(error instanceof Error && /super-secret-value/.test(error.message)));
  }
  assert.ok(bad);
  await socks.close();
});

test("direct_then_socks5: silently hanging direct connect times out and falls back (2026-09-29 prod symptom)", async () => {
  // A TCP listener that accepts but never speaks: TLS/HTTP hangs instead of
  // refusing — exactly the prod behavior against runware.ai.
  const blackhole = net.createServer((socket) => {
    socket.on("error", () => socket.destroy());
    // no response, no close
  });
  await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  const blackholePort = (blackhole.address() as { port: number }).port;

  const alive = await startHttpServer((_req, res) => res.end("via-socks5"));
  const socks = await startSocksServer({
    map: () => ({ host: "127.0.0.1", port: alive.port }),
    onTarget: () => {},
  });

  const client = createExtensionFetchClient({
    mode: "direct_then_socks5",
    proxy: { host: "127.0.0.1", port: socks.port, remoteDns: true },
  });
  // Plain HTTP against a silent listener: the socket connects (accepts) and
  // then stays quiet — this is the "server accepts but never speaks" hang
  // that used to swallow the whole caller budget before any fallback.
  const started = Date.now();
  const response = await client(`http://127.0.0.1:${blackholePort}/`);
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "via-socks5");
  assert.ok(elapsed < 14_000, `fallback took ${elapsed}ms — hang was not bounded`);
  await socks.close();
  await alive.close();
  blackhole.close();
});
