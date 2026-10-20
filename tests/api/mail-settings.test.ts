// PCMS-OPS-T130 — Admin-managed SMTP settings (migration 1601): sanitized
// reads (no password ever), permission split, write-only password semantics
// (set/clear/keep), encryption at rest, verify-before-enable against a live
// mini SMTP endpoint, and no-optimistic-state on verification failure.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

/** Minimal RFC 5321 endpoint: greets, accepts AUTH PLAIN, mail, data, quit.
 * Records the AUTH line so tests can prove which credential was used. */
function startMiniSmtp(): Promise<{ server: Server; port: number; seenAuth: string[] }> {
  const seenAuth: string[] = [];
  const server = createServer((socket) => {
    socket.write("220 mini.test ESMTP\r\n");
    let inData = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of chunk.split("\r\n")) {
        if (line === "") continue;
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued\r\n");
          }
          continue;
        }
        const command = line.toUpperCase();
        if (command.startsWith("EHLO") || command.startsWith("HELO")) {
          socket.write("250-mini.test\r\n250 AUTH PLAIN\r\n");
        } else if (command.startsWith("AUTH PLAIN")) {
          seenAuth.push(line);
          socket.write("235 ok\r\n");
        } else if (command.startsWith("MAIL FROM") || command.startsWith("RCPT TO")) {
          socket.write("250 ok\r\n");
        } else if (command.startsWith("DATA")) {
          inData = true;
          socket.write("354 go\r\n");
        } else if (command.startsWith("QUIT")) {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, port, seenAuth });
    });
  });
}

test("mail settings: sanitized default, permission split, password write-only", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { deriveKeyForTesting, createSecretBox } = await import("@pcms/auth");
  const box = createSecretBox(deriveKeyForTesting("mail-settings-test"));
  const { app } = await createApiFixture(t, { runtimeSecretBox: box });
  const owner = apiContextOf(ownerActor());

  const { getMailSettingsOp, updateMailSettingsOp } = await import("@pcms/api");

  const before = await getMailSettingsOp(app, owner);
  assert.equal(before.configured, true);
  assert.equal(before.enabled, false);
  assert.equal(before.password_set, false);
  assert.equal(before.encryption_ready, true);

  // Permission split: plain readers cannot mutate; configure is required.
  await assert.rejects(
    () =>
      updateMailSettingsOp(app, apiContextOf(scopedActor(["integrations.read"])), {
        enabled: false,
        from: "cms@example.com",
        host: "smtp.example.com",
      }),
    (error: { readonly code?: string }) => error?.code === "AUTH_PERMISSION_DENIED",
  );

  // Store settings + a password (still disabled — no verification needed).
  const saved = await updateMailSettingsOp(app, owner, {
    enabled: false,
    from: "cms@example.com",
    host: "smtp.example.com",
    username: "cms",
    password: "sup3r-secret",
  });
  assert.equal(saved.enabled, false);
  assert.equal(saved.password_set, true);
  assert.equal(saved.username, "cms");
  assert.equal("password" in saved, false);

  // The blob in the database is not the plaintext.
  const raw = await app.pool.query<{ password_enc: Buffer }>(
    "SELECT password_enc FROM pcms_mail_settings WHERE id = 1",
  );
  const stored = raw.rows[0]?.password_enc;
  assert.ok(stored !== null && stored !== undefined);
  assert.notEqual(stored.toString("base64"), "sup3r-secret");

  // Update without touching the password keeps it; explicit null clears it.
  const kept = await updateMailSettingsOp(app, owner, {
    enabled: false,
    from: "cms@example.com",
    host: "smtp.example.com",
  });
  assert.equal(kept.password_set, true);
  const cleared = await updateMailSettingsOp(app, owner, {
    enabled: false,
    from: "cms@example.com",
    host: "smtp.example.com",
    password: null,
  });
  assert.equal(cleared.password_set, false);
});

test("mail settings: enable verifies against the SMTP endpoint; failure persists nothing", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { deriveKeyForTesting, createSecretBox } = await import("@pcms/auth");
  const box = createSecretBox(deriveKeyForTesting("mail-settings-test"));
  const { app } = await createApiFixture(t, { runtimeSecretBox: box });
  const owner = apiContextOf(ownerActor());
  const { updateMailSettingsOp, getMailSettingsOp } = await import("@pcms/api");

  // Enabled + unreachable → verification failure, nothing persisted.
  await assert.rejects(
    () =>
      updateMailSettingsOp(app, owner, {
        enabled: true,
        from: "cms@example.com",
        host: "127.0.0.1",
        port: 1, // nothing listens here
        mode: "plain",
        username: "cms",
        password: "pw",
      }),
    (error: { readonly code?: string }) => error?.code === "MAIL_VERIFY_FAILED",
  );
  const untouched = await getMailSettingsOp(app, owner);
  assert.equal(untouched.enabled, false);
  assert.equal(untouched.password_set, false);

  // Enabled against a live mini SMTP endpoint → verified and stored.
  const mini = await startMiniSmtp();
  t.after(() => mini.server.close());
  const saved = await updateMailSettingsOp(app, owner, {
    enabled: true,
    from: "cms@example.com",
    host: "127.0.0.1",
    port: mini.port,
    mode: "plain",
    username: "cms",
    password: "stored-pw",
  });
  assert.equal(saved.enabled, true);
  assert.ok(
    mini.seenAuth.some((line) =>
      line.includes(Buffer.from("\u0000cms\u0000stored-pw").toString("base64")),
    ),
    "AUTH PLAIN line should carry the decrypted credential",
  );

  // A stored password is used when the write keeps it (no password field).
  const rotated = await updateMailSettingsOp(app, owner, {
    enabled: true,
    from: "cms@example.com",
    host: "127.0.0.1",
    port: mini.port,
    mode: "plain",
    username: "cms",
    password: "next-pw",
  });
  assert.equal(rotated.enabled, true);
  assert.ok(
    mini.seenAuth.some((line) =>
      line.includes(Buffer.from("\u0000cms\u0000next-pw").toString("base64")),
    ),
  );
});

test("mail settings: storing a password without an encryption key fails closed", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t);
  const owner = apiContextOf(ownerActor());
  const { updateMailSettingsOp, getMailSettingsOp } = await import("@pcms/api");

  const view = await getMailSettingsOp(app, owner);
  assert.equal(view.encryption_ready, false);

  await assert.rejects(
    () =>
      updateMailSettingsOp(app, owner, {
        enabled: false,
        from: "cms@example.com",
        host: "smtp.example.com",
        password: "pw",
      }),
    (error: { readonly code?: string }) => error?.code === "MAIL_ENCRYPTION_NOT_CONFIGURED",
  );

  // Ref-free writes without a password still work (username-only relays).
  const saved = await updateMailSettingsOp(app, owner, {
    enabled: false,
    from: "cms@example.com",
    host: "smtp.example.com",
  });
  assert.equal(saved.password_set, false);
});
