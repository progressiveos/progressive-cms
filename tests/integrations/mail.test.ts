// PCMS-OPS-T110 — mail surface checks: console transport boundary, SMTP
// client happy path against an in-process fake server, and the config
// schema acceptance of the `mail` section. No database involved.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { test } from "node:test";
import { validateConfigDocument } from "@pcms/core";
import {
  createConsoleMailTransport,
  createSmtpMailTransport,
  verifySmtpConnection,
} from "@pcms/integrations";

test("console transport logs the envelope and sends nothing", async () => {
  const lines: string[] = [];
  const transport = createConsoleMailTransport({ log: (line) => lines.push(line) });
  const result = await transport.send({ to: "ops@example.com", subject: "probe", text: "hi" });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("ops@example.com"));
  assert.ok(lines[0]!.includes("not sent"));
  assert.ok(result.messageId.includes("console-"));
});

/** Minimal SMTP fake: greets, accepts commands, records AUTH presence. */
async function fakeSmtp(): Promise<{ server: Server; port: number; sawAuth: { value: boolean } }> {
  const sawAuth = { value: false };
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 fake ESMTP ready\r\n");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\r\n");
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const verb = line.split(" ")[0] ?? line;
        if (verb === "EHLO") socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
        else if (verb === "AUTH") {
          sawAuth.value = true;
          socket.write("235 ok\r\n");
        } else if (verb === "MAIL" || verb === "RCPT" || verb === "NOOP")
          socket.write("250 ok\r\n");
        else if (verb === "DATA") socket.write("354 go\r\n");
        else if (line === ".") socket.write("250 queued\r\n");
        else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { server, port, sawAuth };
}

test("smtp transport verifies, authenticates and delivers against a fake server", async (t) => {
  const { server, port, sawAuth } = await fakeSmtp();
  t.after(() => server.close());
  const options = {
    host: "127.0.0.1",
    port,
    mode: "plain" as const,
    username: "agent",
    password: "secret-value",
    from: "cms@example.com",
    connectTimeoutMs: 3000,
  };
  const diag = await verifySmtpConnection(options);
  assert.equal(diag.authenticated, true);
  assert.equal(sawAuth.value, true);
  assert.ok(diag.elapsed_ms >= 0);

  const transport = createSmtpMailTransport(options);
  const sent = await transport.send({ to: "dest@example.com", subject: "t", text: "body" });
  assert.match(sent.messageId, /@127\.0\.0\.1>$/);
});

test("config schema accepts the mail section (secret refs only)", () => {
  const doc = {
    nodeEnv: "production",
    db: { host: "db", port: 5432, database: "d", user: "u", sslMode: "disable" },
    mail: {
      transport: "smtp",
      from: "info@site.example.test",
      host: "mail.example.com",
      port: 587,
      mode: "starttls",
      usernameSecretRef: "mail.username",
      passwordSecretRef: "mail.password",
    },
  };
  const result = validateConfigDocument(doc);
  assert.equal(result.ok, true, JSON.stringify(result));
});
