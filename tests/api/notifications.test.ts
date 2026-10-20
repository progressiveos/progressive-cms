// Notifications v1 (owner brief 2026-10-07): recipient routing validation,
// immediate send, and per-user digest — driven through the REST surface with
// a fake mail transport, against real PostgreSQL.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ApplicationServices } from "@pcms/api";
import {
  createApiFastify,
  createApiV1,
  makeNotificationRoutes,
  saveMyNotificationPrefsOp,
  sweepNotificationsOp,
} from "@pcms/api";
import { createLogger, systemClock } from "@pcms/core";
import type { MailTransport } from "@pcms/integrations";
import type { FastifyInstance } from "fastify";
import { createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

function fakeTransport() {
  const sent: { to: string; subject: string; text: string }[] = [];
  const transport: MailTransport = {
    async send(message) {
      sent.push({
        to: message.to,
        subject: message.subject ?? "",
        text: message.text ?? "",
      });
      return { messageId: `mid-${sent.length}` };
    },
  };
  return { transport, sent };
}

async function makeApp(t: { after: (fn: () => void) => void }): Promise<{
  app: ApplicationServices;
  fastify: FastifyInstance;
}> {
  const { app } = await createApiFixture(t);
  const fastify: FastifyInstance = createApiFastify(() => "req_notifications_test");
  await fastify.register(createApiV1([...makeNotificationRoutes()]), {
    application: app,
    logger: createLogger({ level: "error", sink: () => {} }),
    cookieSecure: false,
  });
  await fastify.ready();
  return { app, fastify };
}

async function bearerFor(app: ApplicationServices, scopes: readonly string[]): Promise<string> {
  const account = await app.machineIdentity.createServiceAccount({
    name: `notifications-sa-${Math.random().toString(36).slice(2, 8)}`,
    purpose: "notifications test",
    allowedScopes: [...scopes],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [...scopes],
    ttlMilliseconds: 3_600_000,
  });
  return token.rawSecret;
}

async function insertSiteUser(
  pool: ApplicationServices["pool"],
  input: { readonly name: string; readonly email: string; readonly role?: string },
): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, display_name, status) VALUES ($1, $2, 'ACTIVE')`, [
    id,
    input.name,
  ]);
  await pool.query(
    `INSERT INTO user_emails (user_id, email_normalized, email_display, is_primary)
     VALUES ($1, $2, $2, true)`,
    [id, input.email],
  );
  if (input.role !== undefined) {
    await pool.query(`INSERT INTO auth_user_roles (user_id, role_key) VALUES ($1, $2)`, [
      id,
      input.role,
    ]);
  }
  return id;
}

async function insertLead(
  pool: ApplicationServices["pool"],
  input: { readonly name: string; readonly email: string },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO forms_leads (id, source_type, source_id, status, name, email, summary)
     VALUES ($1, 'FORM_SUBMISSION', $2, 'NEW', $3, $4, 'Хочет консультацию')`,
    [id, randomUUID(), input.name, input.email],
  );
  return id;
}

test("notification settings: defaults, recipient validation, per-user digest", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  const editorId = await insertSiteUser(app.pool, {
    name: "Редактор уведомлений",
    email: "editor-notifications@test.local",
  });
  await insertSiteUser(app.pool, {
    name: "Админ уведомлений",
    email: "admin-notifications@test.local",
    role: "ADMIN",
  });

  const token = await bearerFor(app, ["integrations.read", "integrations.configure"]);
  const auth = { authorization: `Bearer ${token}` };

  // Defaults: empty recipient lists; candidates resolve from the users table.
  const initial = await fastify.inject({
    method: "GET",
    url: "/api/v1/notifications/settings",
    headers: auth,
  });
  assert.equal(initial.statusCode, 200, initial.body);
  const initialBody = initial.json() as {
    settings: { recipients: Record<string, string[]>; site_name: string };
    candidates: { user_id: string; email: string }[];
  };
  assert.deepEqual(initialBody.settings.recipients.leads, []);
  assert.equal(initialBody.settings.site_name, "Progressive CMS");
  const emails = initialBody.candidates.map((candidate) => candidate.email).sort();
  assert.ok(emails.includes("editor-notifications@test.local"));

  // Unknown recipient user → 422, nothing saved.
  const rejected = await fastify.inject({
    method: "PUT",
    url: "/api/v1/notifications/settings",
    headers: { ...auth, "content-type": "application/json" },
    payload: { settings: { recipients: { leads: [randomUUID()] } } },
  });
  assert.equal(rejected.statusCode, 422, rejected.body);

  // Valid save round-trips.
  const saved = await fastify.inject({
    method: "PUT",
    url: "/api/v1/notifications/settings",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      settings: {
        site_name: "Тест-сайт",
        recipients: { leads: [editorId], forms: [], quizzes: [], system: [] },
        form_recipients: {},
      },
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const reread = await fastify.inject({
    method: "GET",
    url: "/api/v1/notifications/settings",
    headers: auth,
  });
  const rereadBody = reread.json() as {
    settings: { recipients: Record<string, string[]>; site_name: string };
  };
  assert.deepEqual(rereadBody.settings.recipients.leads, [editorId]);
  assert.equal(rereadBody.settings.site_name, "Тест-сайт");

  // Per-user prefs: unsupported digest interval rejects; supported saves.
  const editorCtx = { actor: { type: "USER" as const, id: editorId } } as never;
  await assert.rejects(() =>
    saveMyNotificationPrefsOp(app, editorCtx, { disabled: [], digest_minutes: 90 }),
  );
  await saveMyNotificationPrefsOp(app, editorCtx, {
    disabled: [],
    digest_minutes: 60,
    locale: "en",
  });
  const prefs = await app.pool.query<{
    digest_minutes: number;
    digest_since: Date;
    locale: string;
  }>(
    `SELECT digest_minutes, digest_since, locale FROM user_notification_prefs WHERE user_id = $1`,
    [editorId],
  );
  assert.equal(prefs.rows[0]?.digest_minutes, 60);
  assert.equal(prefs.rows[0]?.locale, "en");
  assert.ok(prefs.rows[0] !== undefined && prefs.rows[0].digest_since !== null);
});

test("sweep: immediate send to category recipients; digest users get the digest instead", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  const editorId = await insertSiteUser(app.pool, {
    name: "Дайджест-редактор",
    email: "digest@test.local",
  });
  await insertSiteUser(app.pool, {
    name: "Сисадмин",
    email: "sysadmin@test.local",
    role: "ADMIN",
  });

  const token = await bearerFor(app, ["integrations.read", "integrations.configure"]);
  await fastify.inject({
    method: "PUT",
    url: "/api/v1/notifications/settings",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: {
      settings: {
        site_name: "Тест-сайт",
        recipients: { leads: [editorId], forms: [], quizzes: [], system: [] },
        form_recipients: {},
      },
    },
  });

  // Editor is on a 1-hour digest with the window already elapsed; a system
  // event (applied update) exercises the privileged-role routing.
  await saveMyNotificationPrefsOp(app, { actor: { type: "USER", id: editorId } } as never, {
    disabled: [],
    digest_minutes: 60,
    locale: "en",
  });
  await app.pool.query(
    `UPDATE user_notification_prefs SET digest_since = now() - interval '90 minutes'
     WHERE user_id = $1`,
    [editorId],
  );
  await app.pool.query(
    `INSERT INTO pcms_update_history
       (id, from_version, to_version, actor_type, started_at, completed_at, status, rollback_policy)
     VALUES ($1, '0.1.193', '0.1.194', 'user', now(), now(), 'SUCCEEDED', 'rollback_safe')`,
    [randomUUID()],
  );

  const first = await insertLead(app.pool, {
    name: "АннаLead",
    email: "anna@test.local",
  });
  const { transport, sent } = fakeTransport();
  const stats = await sweepNotificationsOp({
    pool: app.pool,
    clock: systemClock,
    mailTransport: transport,
    origin: "https://test.example",
  });
  assert.equal(stats.inserted >= 1, true);

  // The digest user gets NO immediate mail — their window had elapsed, so
  // sweep #1 delivers their DIGEST (queued lead included) in THEIR language…
  const editorMail = sent.filter((message) => message.to === "digest@test.local");
  assert.equal(editorMail.length, 1);
  assert.match(editorMail[0]?.subject ?? "", /Digest — Leads: 1/);
  assert.match(editorMail[0]?.text ?? "", /Open in Admin: https:\/\/test.example\/admin\/#\/leads/);
  assert.match(editorMail[0]?.text ?? "", /АннаLead/);
  // …while the sysadmin (privileged role, no prefs row) gets the system
  // event immediately.
  const adminMail = sent.filter((message) => message.to === "sysadmin@test.local");
  assert.ok(adminMail.length >= 1);
  // The sysadmin kept the default Russian locale.
  assert.ok(adminMail.some((message) => /Обновление применено/.test(message.subject)));

  // Sweep #2 with a new lead: the digest window restarts, so nothing new is
  // mailed to the editor, and the applied-update notification is NOT
  // repeated (already-sent dedupe); boot-time system events may still route.
  await insertLead(app.pool, { name: "БорисLead", email: "boris@test.local" });
  sent.length = 0;
  const stats2 = await sweepNotificationsOp({
    pool: app.pool,
    clock: systemClock,
    mailTransport: transport,
  });
  assert.equal(stats2.digests_sent, 0);
  assert.equal(
    sent.filter((message) => message.to === "digest@test.local").length,
    0,
    JSON.stringify(
      sent.map((message) => [message.to, message.subject, message.text?.slice(0, 120)]),
    ),
  );
  assert.equal(
    sent.filter(
      (message) =>
        message.to === "sysadmin@test.local" && /Обновление применено/.test(message.subject),
    ).length,
    0,
  );
  void first;
});
