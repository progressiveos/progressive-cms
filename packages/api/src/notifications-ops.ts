// Notifications v1 (owner brief 2026-10-07): event e-mail to site users —
// leads / form submissions / quiz completions plus system events to admins.
//
// Architecture: sweep sources with monotonic (created_at, id) cursors into
// notification_events; recipients resolve at SEND time (category recipient
// lists + per-form overrides + per-user subscriptions), so editing either
// never loses queued events. Delivery is immediate (default) or a per-user
// digest (1/3/6/12h) — each admin chooses in their account menu; everything
// defaults to enabled. E-mails use one branded template (site wordmark
// header, chips, field table); a theme/developer may restyle marketing mail
// later — this is the admin-notification baseline. v1 labels are Russian
// (the operator audience); no free-form recipient addresses, ever —
// recipients are site users.
import { randomUUID } from "node:crypto";
import { recordSecurityEvent } from "@pcms/auth";
import type { Clock, DbPool } from "@pcms/core";
import type { MailTransport } from "@pcms/integrations";
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

export const NOTIFICATION_CATEGORIES = ["leads", "forms", "quizzes", "system"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export const DIGEST_MINUTES_OPTIONS = [0, 60, 180, 360, 720] as const;

// ---------------------------------------------------------------------------
// Localized rendering (ru/en; the recipient's account-menu choice). Queued
// events store ordered [key, value] pairs; labels resolve at send time, so
// one queued event renders in every language.
// ---------------------------------------------------------------------------

type EventKind = "lead" | "form" | "quiz" | "update" | "delivery" | "maintenance";

const KIND_BY_EVENT_TYPE: Readonly<Record<string, EventKind>> = {
  LeadCreated: "lead",
  FormSubmitted: "form",
  QuizCompleted: "quiz",
  UpdateApplied: "update",
  IntegrationDeliveryFailed: "delivery",
  MAINTENANCE_ENABLED: "maintenance",
  MAINTENANCE_DISABLED: "maintenance",
};

type Pair = readonly [string, string];

const FIELD_LABELS: Readonly<Record<string, Readonly<Record<NotificationLocale, string>>>> = {
  name: { ru: "Имя", en: "Name" },
  email: { ru: "E-mail", en: "E-mail" },
  phone: { ru: "Телефон", en: "Phone" },
  source: { ru: "Источник", en: "Source" },
  lead_status: { ru: "Статус", en: "Status" },
  form: { ru: "Форма", en: "Form" },
  submitted: { ru: "Отправлено", en: "Submitted" },
  form_status: { ru: "Статус", en: "Status" },
  quiz: { ru: "Квиз", en: "Quiz" },
  score: { ru: "Счёт", en: "Score" },
  completed: { ru: "Завершён", en: "Completed" },
  from_version: { ru: "Была версия", en: "Previous version" },
  to_version: { ru: "Стала версия", en: "New version" },
  update_status: { ru: "Статус", en: "Status" },
  failure: { ru: "Код сбоя", en: "Failure code" },
  event: { ru: "Событие", en: "Event" },
  action: { ru: "Действие", en: "Action" },
  error: { ru: "Код ошибки", en: "Error code" },
  time: { ru: "Время", en: "Time" },
};

const CHIP_LABELS: Readonly<Record<string, Readonly<Record<NotificationLocale, string>>>> = {
  lead: { ru: "Лид", en: "Lead" },
  form: { ru: "Форма", en: "Form" },
  quiz: { ru: "Квиз", en: "Quiz" },
  system: { ru: "Система", en: "System" },
  success: { ru: "Успех", en: "Success" },
  failure: { ru: "Сбой", en: "Failure" },
  integration: { ru: "Интеграция", en: "Integration" },
  maintenance: { ru: "Техрежим", en: "Maintenance" },
};

const CATEGORY_LABELS_LOCALIZED: Readonly<
  Record<NotificationCategory, Readonly<Record<NotificationLocale, string>>>
> = {
  leads: { ru: "Лиды", en: "Leads" },
  forms: { ru: "Ответы форм", en: "Form submissions" },
  quizzes: { ru: "Квизы", en: "Quizzes" },
  system: { ru: "Системные", en: "System" },
};

function eventTitle(
  kind: EventKind,
  locale: NotificationLocale,
  data: Readonly<Record<string, string>>,
): string {
  const ru = locale === "ru";
  switch (kind) {
    case "lead":
      return ru
        ? `Новый лид — ${data["source"] ?? "Форма"}`
        : `New lead — ${data["source"] ?? "Form"}`;
    case "form":
      return ru ? `Ответ формы — ${data["form"] ?? ""}` : `Form submission — ${data["form"] ?? ""}`;
    case "quiz":
      return ru
        ? `Квиз завершён — ${data["quiz"] ?? ""}`
        : `Quiz completed — ${data["quiz"] ?? ""}`;
    case "update": {
      const version = data["to_version"] ?? "";
      if (data["update_status"] === "SUCCEEDED")
        return ru ? `Обновление применено — ${version}` : `Update applied — ${version}`;
      return ru ? `Обновление не удалось — ${version}` : `Update failed — ${version}`;
    }
    case "delivery":
      return ru
        ? `Сбой доставки — ${data["event"] ?? ""}`
        : `Delivery failure — ${data["event"] ?? ""}`;
    case "maintenance":
      return data["maintenance"] === "enabled"
        ? ru
          ? "Технический режим включён"
          : "Maintenance mode enabled"
        : ru
          ? "Технический режим выключен"
          : "Maintenance mode disabled";
  }
}

function eventChips(kind: EventKind, locale: NotificationLocale): readonly string[] {
  const t = (key: string): string => CHIP_LABELS[key]?.[locale] ?? key;
  switch (kind) {
    case "lead":
      return [t("lead"), t("form")];
    case "form":
      return [t("form")];
    case "quiz":
      return [t("quiz")];
    case "update":
      return [t("system")];
    case "delivery":
      return [t("system"), t("integration")];
    case "maintenance":
      return [t("system"), t("maintenance")];
  }
}

interface LocalizedEvent {
  readonly title: string;
  readonly summary: string;
  readonly fields: readonly Pair[];
  readonly chips: readonly string[];
}

function renderLocalizedEvent(
  kind: EventKind,
  locale: NotificationLocale,
  pairs: readonly Pair[],
): LocalizedEvent {
  const data: Record<string, string> = {};
  for (const [key, value] of pairs) data[key] = value;
  const fields = pairs
    .filter(([key]) => key !== "maintenance")
    .map(([key, value]) => [FIELD_LABELS[key]?.[locale] ?? key, value] as Pair);
  return {
    title: eventTitle(kind, locale, data),
    summary: data["failure"] ?? "",
    fields,
    chips: eventChips(kind, locale),
  };
}

/** Admin deep-link per event kind (origin resolved from the primary domain
 * binding at dispatch; no link when the deployment has no domain). */
function adminPathFor(kind: EventKind): string {
  switch (kind) {
    case "lead":
      return "/admin/#/leads";
    case "form":
      return "/admin/#/submissions";
    case "quiz":
      return "/admin/#/quiz-runs";
    case "update":
      return "/admin/#/extensions";
    case "delivery":
      return "/admin/#/integrations";
    case "maintenance":
      return "/admin/#/maintenance";
  }
}

const LINK_LABELS: Readonly<Record<NotificationLocale, string>> = {
  ru: "Открыть в админке",
  en: "Open in Admin",
};

const FOOTER_LABELS: Readonly<Record<NotificationLocale, string>> = {
  ru: "Отправлено движком Progressive CMS · Административные уведомления сайта",
  en: "Sent by the Progressive CMS engine · Site administrative notifications",
};

const SUBJECT_PREFIXES: Readonly<Record<NotificationLocale, string>> = {
  ru: "{site}: ",
  en: "{site}: ",
};

const DIGEST_SUBJECTS: Readonly<Record<NotificationLocale, string>> = {
  ru: "Дайджест",
  en: "Digest",
};

const EVENTS_RETENTION_DAYS = 30;
const SWEEP_BATCH = 100;
const WINDOW_DAYS = 2; // immediate-send retry window (bounds late-added recipients' backlog)

export interface NotificationSettings {
  /** Branded-header site name for outgoing notification mail. */
  readonly site_name: string;
  /** Per-category recipient user ids. Empty = nothing sends for the category
   * (system ignores this and targets privileged roles). */
  readonly recipients: Readonly<Record<NotificationCategory, readonly string[]>>;
  /** formDefinitionId -> recipient user ids; replaces the category list for
   * form submissions AND leads originating from that form (MODX-style
   * per-form departments). */
  readonly form_recipients: Readonly<Record<string, readonly string[]>>;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  site_name: "Progressive CMS",
  recipients: { leads: [], forms: [], quizzes: [], system: [] },
  form_recipients: {},
};

export const NOTIFICATION_LOCALES = ["ru", "en"] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

export interface NotificationPrefs {
  readonly disabled: readonly NotificationCategory[];
  readonly digest_minutes: (typeof DIGEST_MINUTES_OPTIONS)[number];
  readonly locale: NotificationLocale;
}

function parseSettings(raw: unknown): NotificationSettings {
  if (raw === null || typeof raw !== "object") return DEFAULT_SETTINGS;
  const value = raw as {
    site_name?: unknown;
    recipients?: Record<string, unknown>;
    form_recipients?: Record<string, unknown>;
  };
  const siteName =
    typeof value.site_name === "string" && value.site_name.trim() !== ""
      ? value.site_name.trim().slice(0, 120)
      : DEFAULT_SETTINGS.site_name;
  const recipients = { leads: [], forms: [], quizzes: [], system: [] } as Record<
    NotificationCategory,
    string[]
  >;
  for (const category of NOTIFICATION_CATEGORIES) {
    const list = value.recipients?.[category];
    if (Array.isArray(list)) {
      recipients[category] = list.filter((id): id is string => typeof id === "string");
    }
  }
  const form_recipients: Record<string, string[]> = {};
  if (value.form_recipients !== null && typeof value.form_recipients === "object") {
    for (const [formId, list] of Object.entries(value.form_recipients)) {
      if (Array.isArray(list)) {
        const ids = list.filter((id): id is string => typeof id === "string");
        if (ids.length > 0) form_recipients[formId] = ids;
      }
    }
  }
  return { site_name: siteName, recipients, form_recipients };
}

async function loadSettings(pool: DbPool): Promise<NotificationSettings> {
  const result = await pool.query<{ settings: unknown }>(
    `SELECT settings FROM notification_settings WHERE id = 1`,
  );
  return parseSettings(result.rows[0]?.settings);
}

// ---------------------------------------------------------------------------
// Operator settings surface
// ---------------------------------------------------------------------------

export async function getNotificationSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<{
  settings: NotificationSettings;
  candidates: readonly {
    user_id: string;
    display_name: string;
    email: string;
    roles: readonly string[];
  }[];
  forms: readonly { id: string; title: string }[];
}> {
  requirePermission(app, ctx, "integrations.read");
  const settings = await loadSettings(app.pool);
  const candidates = await activeUsersWithEmail(app.pool);
  const forms = await app.pool.query<{ id: string; title: string }>(
    `SELECT id, title FROM forms_form_definitions ORDER BY title, id`,
  );
  return { settings, candidates, forms: forms.rows };
}

export async function saveNotificationSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly settings: unknown },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "integrations.configure");
  const settings = parseSettings(input.settings);
  // Every referenced recipient must be an existing ACTIVE user.
  const known = new Set((await activeUsersWithEmail(app.pool)).map((user) => user.user_id));
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const id of settings.recipients[category]) {
      if (!known.has(id)) {
        throw new ApiError("VALIDATION_FAILED", `unknown recipient user ${id}`, { status: 422 });
      }
    }
  }
  for (const [formId, list] of Object.entries(settings.form_recipients)) {
    for (const id of list) {
      if (!known.has(id)) {
        throw new ApiError("VALIDATION_FAILED", `unknown recipient user ${id}`, { status: 422 });
      }
    }
    const exists = await app.pool.query<{ id: string }>(
      `SELECT id FROM forms_form_definitions WHERE id = $1`,
      [formId],
    );
    if (exists.rows.length === 0) {
      throw new ApiError("VALIDATION_FAILED", `unknown form ${formId}`, { status: 422 });
    }
  }
  await app.pool.query(
    `INSERT INTO notification_settings (id, settings, updated_at)
     VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET settings = $1::jsonb, updated_at = now()`,
    [JSON.stringify(settings)],
  );
  await recordSecurityEvent(app.pool, null, {
    type: "NOTIFICATION_SETTINGS_UPDATED",
    actorType: ctx.actor.type,
    actorId: ctx.actor.id ?? null,
    transport: "api",
    metadata: { actor: ctx.actor.id ?? ctx.actor.type },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Per-user subscriptions (ЛК)
// ---------------------------------------------------------------------------

export async function getMyNotificationPrefsOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<NotificationPrefs> {
  if (ctx.actor.type !== "USER" || ctx.actor.id === undefined) {
    throw new ApiError("AUTH_REQUIRED", "user account required", { status: 401 });
  }
  const result = await app.pool.query<{
    disabled: unknown;
    digest_minutes: number;
    locale: string;
  }>(`SELECT disabled, digest_minutes, locale FROM user_notification_prefs WHERE user_id = $1`, [
    ctx.actor.id,
  ]);
  const row = result.rows[0];
  return {
    locale: (NOTIFICATION_LOCALES as readonly string[]).includes(row?.locale ?? "")
      ? (row?.locale as NotificationLocale)
      : "ru",
    disabled: Array.isArray(row?.disabled)
      ? (row.disabled as NotificationCategory[]).filter((category) =>
          (NOTIFICATION_CATEGORIES as readonly string[]).includes(category),
        )
      : [],
    digest_minutes:
      row !== undefined &&
      (DIGEST_MINUTES_OPTIONS as readonly number[]).includes(row.digest_minutes)
        ? (row.digest_minutes as NotificationPrefs["digest_minutes"])
        : 0,
  };
}

export async function saveMyNotificationPrefsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly disabled: unknown;
    readonly digest_minutes: unknown;
    readonly locale?: unknown;
  },
): Promise<{ ok: true }> {
  if (ctx.actor.type !== "USER" || ctx.actor.id === undefined) {
    throw new ApiError("AUTH_REQUIRED", "user account required", { status: 401 });
  }
  const disabled = Array.isArray(input.disabled)
    ? (input.disabled as unknown[]).filter((entry): entry is NotificationCategory =>
        (NOTIFICATION_CATEGORIES as readonly string[]).includes(entry as string),
      )
    : [];
  const digest = Number(input.digest_minutes ?? 0);
  if (!(DIGEST_MINUTES_OPTIONS as readonly number[]).includes(digest)) {
    throw new ApiError("VALIDATION_FAILED", `unsupported digest interval ${digest}`, {
      status: 422,
    });
  }
  const locale =
    typeof input.locale === "string" &&
    (NOTIFICATION_LOCALES as readonly string[]).includes(input.locale)
      ? input.locale
      : "ru";
  const previous = await app.pool.query<{ digest_minutes: number }>(
    `SELECT digest_minutes FROM user_notification_prefs WHERE user_id = $1`,
    [ctx.actor.id],
  );
  const wasImmediate = (previous.rows[0]?.digest_minutes ?? 0) === 0;
  // Switching immediate → digest starts the window NOW so the first digest
  // never replays the whole history.
  await app.pool.query(
    `INSERT INTO user_notification_prefs (user_id, disabled, digest_minutes, locale, digest_since, updated_at)
     VALUES ($1, $2::jsonb, $3, $5, CASE WHEN $3 > 0 AND $4 THEN now() ELSE to_timestamp(0) END, now())
     ON CONFLICT (user_id) DO UPDATE SET disabled = $2::jsonb, digest_minutes = $3, locale = $5,
       digest_since = CASE WHEN $3 > 0 AND $4 THEN now() ELSE user_notification_prefs.digest_since END,
       updated_at = now()`,
    [ctx.actor.id, JSON.stringify(disabled), digest, wasImmediate, locale],
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sweep + dispatch (worker)
// ---------------------------------------------------------------------------

type Cursor = { readonly at: Date; readonly id: string };

function encodeCursor(cursor: Cursor): string {
  return JSON.stringify([cursor.at.toISOString(), cursor.id]);
}

function decodeCursor(raw: string | undefined): Cursor {
  if (raw !== undefined && raw !== "") {
    try {
      const parsed = JSON.parse(raw) as [string, string];
      const at = new Date(parsed[0]);
      if (!Number.isNaN(at.getTime())) return { at, id: parsed[1] ?? "" };
    } catch {
      // fall through to epoch default
    }
  }
  // nil uuid sorts below every UUIDv7 id — a valid lower bound for the
  // (created_at, id) row comparison.
  return { at: new Date(0), id: "00000000-0000-0000-0000-000000000000" };
}

async function readCursor(pool: DbPool, source: string): Promise<Cursor> {
  const result = await pool.query<{ cursor: string }>(
    `SELECT cursor FROM notification_cursors WHERE source = $1`,
    [source],
  );
  return decodeCursor(result.rows[0]?.cursor);
}

async function writeCursor(pool: DbPool, source: string, cursor: Cursor): Promise<void> {
  // Last write wins: dispatch jobs are serialized by the per-minute
  // idempotency key, so concurrent sweeps are already excluded.
  await pool.query(
    `INSERT INTO notification_cursors (source, cursor) VALUES ($1, $2)
     ON CONFLICT (source) DO UPDATE SET cursor = $2`,
    [source, encodeCursor(cursor)],
  );
}

interface RawEvent {
  readonly category: NotificationCategory;
  readonly event_type: string;
  /** Ordered locale-neutral payload pairs; labels resolve at send time. */
  readonly data: readonly Pair[];
  readonly form_definition_id: string | null;
  readonly at: Date;
  readonly id: string;
}

async function pollSources(app: { pool: DbPool; clock: Clock }): Promise<{ inserted: number }> {
  let inserted = 0;
  const sweep = async (
    source: string,
    query: (cursor: Cursor) => Promise<{ rows: RawEvent[] }>,
  ): Promise<void> => {
    const previous = await readCursor(app.pool, source);
    const batch = await query(previous);
    for (const event of batch.rows) {
      const kind = KIND_BY_EVENT_TYPE[event.event_type] ?? ("system" as EventKind);
      const ru = renderLocalizedEvent(kind, "ru", event.data);
      const insertedRow = await app.pool.query(
        `INSERT INTO notification_events
           (id, category, event_type, source_id, title, summary, fields, chips, data, form_definition_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)
         ON CONFLICT (category, event_type, source_id) DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          event.category,
          event.event_type,
          event.id,
          ru.title,
          ru.summary,
          JSON.stringify(ru.fields),
          JSON.stringify(ru.chips),
          JSON.stringify(event.data),
          event.form_definition_id,
          event.at,
        ],
      );
      if (insertedRow.rows.length > 0) inserted += 1;
    }
    if (batch.rows.length > 0) {
      const last = batch.rows[batch.rows.length - 1];
      if (last !== undefined) {
        await writeCursor(app.pool, source, { at: last.at, id: last.id });
      }
    }
  };

  await sweep("leads", async (cursor) => {
    const rows = await app.pool.query<{
      id: string;
      created_at: Date;
      status: string;
      name: string | null;
      email: string | null;
      phone: string | null;
      summary: string;
      source_type: string;
      source_id: string;
    }>(
      `SELECT l.id, l.created_at, l.status, l.name, l.email, l.phone, l.summary, l.source_type, l.source_id
       FROM forms_leads l
       WHERE (l.created_at, l.id) > ($1, $2)
       ORDER BY l.created_at, l.id LIMIT ${SWEEP_BATCH}`,
      [cursor.at, cursor.id],
    );
    // Resolve human source titles for the batch (form or quiz definition).
    const formIds = new Set<string>();
    for (const row of rows.rows) {
      if (row.source_type === "FORM_SUBMISSION") formIds.add(row.source_id);
    }
    const titles = new Map<string, string>();
    if (formIds.size > 0) {
      const defs = await app.pool.query<{ id: string; title: string; form_definition_id: string }>(
        `SELECT s.id, d.title, s.form_definition_id
         FROM forms_submissions s JOIN forms_form_definitions d ON d.id = s.form_definition_id
         WHERE s.id = ANY($1::uuid[])`,
        [[...formIds]],
      );
      for (const row of defs.rows) titles.set(row.id, row.title);
    }
    return {
      rows: rows.rows.map((row) => {
        const isForm = row.source_type === "FORM_SUBMISSION";
        const sourceTitle = isForm ? (titles.get(row.source_id) ?? "Форма") : "Quiz";
        return {
          category: "leads" as const,
          event_type: "LeadCreated",
          data: (
            [
              ["source", sourceTitle],
              ["name", row.name ?? ""],
              ["email", row.email ?? ""],
              ["phone", row.phone ?? ""],
              ["lead_status", row.status],
            ] as const
          ).filter(([, value]) => value !== ""),
          form_definition_id: isForm ? row.source_id : null,
          at: row.created_at,
          id: row.id,
        };
      }),
    };
  });

  await sweep("forms", async (cursor) => {
    const rows = await app.pool.query<{
      id: string;
      submitted_at: Date;
      status: string;
      form_definition_id: string;
      title: string;
    }>(
      `SELECT s.id, s.submitted_at, s.status, s.form_definition_id, d.title
       FROM forms_submissions s JOIN forms_form_definitions d ON d.id = s.form_definition_id
       WHERE s.status = 'ACCEPTED' AND (s.submitted_at, s.id) > ($1, $2)
       ORDER BY s.submitted_at, s.id LIMIT ${SWEEP_BATCH}`,
      [cursor.at, cursor.id],
    );
    return {
      rows: rows.rows.map((row) => ({
        category: "forms" as const,
        event_type: "FormSubmitted",
        data: [
          ["form", row.title],
          ["submitted", row.submitted_at.toISOString().replace("T", " ").slice(0, 16) + " UTC"],
          ["form_status", row.status],
        ] as const,
        form_definition_id: row.form_definition_id,
        at: row.submitted_at,
        id: row.id,
      })),
    };
  });

  await sweep("quizzes", async (cursor) => {
    const rows = await app.pool.query<{
      id: string;
      completed_at: Date;
      score: number | null;
      outcome_id: string | null;
      quiz_definition_id: string;
      title: string;
    }>(
      `SELECT r.id, r.completed_at, r.score, r.outcome_id, r.quiz_definition_id, d.title
       FROM forms_quiz_runs r JOIN forms_quiz_definitions d ON d.id = r.quiz_definition_id
       WHERE r.state = 'COMPLETED' AND r.completed_at IS NOT NULL
         AND (r.completed_at, r.id) > ($1, $2)
       ORDER BY r.completed_at, r.id LIMIT ${SWEEP_BATCH}`,
      [cursor.at, cursor.id],
    );
    return {
      rows: rows.rows.map((row) => ({
        category: "quizzes" as const,
        event_type: "QuizCompleted",
        data: [
          ["quiz", row.title],
          ["score", row.score === null ? "" : String(row.score)],
          ["completed", row.completed_at.toISOString().replace("T", " ").slice(0, 16) + " UTC"],
        ] as const,
        form_definition_id: null,
        at: row.completed_at,
        id: row.id,
      })),
    };
  });

  await sweep("updates", async (cursor) => {
    const rows = await app.pool.query<{
      id: string;
      completed_at: Date;
      from_version: string;
      to_version: string;
      status: string;
      failure_code: string | null;
    }>(
      `SELECT h.id, h.completed_at, h.from_version, h.to_version, h.status, h.failure_code
       FROM pcms_update_history h
       WHERE h.completed_at IS NOT NULL AND (h.completed_at, h.id) > ($1, $2)
       ORDER BY h.completed_at, h.id LIMIT ${SWEEP_BATCH}`,
      [cursor.at, cursor.id],
    );
    return {
      rows: rows.rows.map((row) => ({
        category: "system" as const,
        event_type: "UpdateApplied",
        data: [
          ["from_version", row.from_version],
          ["to_version", row.to_version],
          ["update_status", row.status],
          ["failure", row.failure_code ?? ""],
        ] as const,
        form_definition_id: null,
        at: row.completed_at,
        id: row.id,
      })),
    };
  });

  await sweep("integration_failures", async (cursor) => {
    const rows = await app.pool.query<{
      id: string;
      at: Date;
      event_type: string;
      action_type: string;
      last_error_code: string | null;
    }>(
      `SELECT d.id, COALESCE(d.completed_at, d.created_at) AS at,
              d.event_type, d.action_type, d.last_error_code
       FROM integration_delivery d
       WHERE d.status = 'FAILED_PERMANENT' AND (COALESCE(d.completed_at, d.created_at), d.id) > ($1, $2)
       ORDER BY 1, d.id LIMIT ${SWEEP_BATCH}`,
      [cursor.at, cursor.id],
    );
    return {
      rows: rows.rows.map((row) => ({
        category: "system" as const,
        event_type: "IntegrationDeliveryFailed",
        data: [
          ["event", row.event_type],
          ["action", row.action_type],
          ["error", row.last_error_code ?? ""],
        ] as const,
        form_definition_id: null,
        at: row.at,
        id: row.id,
      })),
    };
  });

  await sweep("maintenance", async (cursor) => {
    const rows = await app.pool.query<{
      id: string;
      created_at: Date;
      event_type: string;
    }>(
      `SELECT e.id, e.created_at, e.event_type
       FROM auth_security_events e
       WHERE e.event_type IN ('MAINTENANCE_ENABLED', 'MAINTENANCE_DISABLED')
         AND (e.created_at, e.id) > ($1, $2)
       ORDER BY e.created_at, e.id LIMIT ${SWEEP_BATCH}`,
      [cursor.at, cursor.id],
    );
    return {
      rows: rows.rows.map((row) => ({
        category: "system" as const,
        event_type: row.event_type,
        data: [
          ["maintenance", row.event_type === "MAINTENANCE_ENABLED" ? "enabled" : "disabled"],
          ["time", row.created_at.toISOString().replace("T", " ").slice(0, 16) + " UTC"],
        ] as const,
        form_definition_id: null,
        at: row.created_at,
        id: row.id,
      })),
    };
  });

  return { inserted };
}

interface RecipientUser {
  readonly user_id: string;
  display_name: string;
  email: string;
  readonly roles: readonly string[];
}

async function activeUsersWithEmail(pool: DbPool): Promise<RecipientUser[]> {
  const result = await pool.query<{
    user_id: string;
    display_name: string;
    email: string;
    roles: string[] | null;
  }>(
    `SELECT u.id AS user_id, u.display_name, e.email_display AS email,
            COALESCE(array_agg(r.role_key) FILTER (WHERE r.role_key IS NOT NULL), '{}') AS roles
     FROM users u
     JOIN user_emails e ON e.user_id = u.id AND e.is_primary
     LEFT JOIN auth_user_roles r ON r.user_id = u.id
     WHERE u.status = 'ACTIVE'
     GROUP BY u.id, u.display_name, e.email_display
     ORDER BY u.display_name, u.id`,
  );
  return result.rows.map((row) => ({
    user_id: row.user_id,
    display_name: row.display_name,
    email: row.email,
    roles: row.roles ?? [],
  }));
}

const PRIVILEGED_ROLES = ["OWNER", "ADMIN", "DEVELOPER"];

async function loadPrefs(
  pool: DbPool,
  userIds: readonly string[],
): Promise<
  Map<string, { disabled: Set<string>; digestMinutes: number; locale: NotificationLocale }>
> {
  const map = new Map<
    string,
    { disabled: Set<string>; digestMinutes: number; locale: NotificationLocale }
  >();
  if (userIds.length === 0) return map;
  const result = await pool.query<{
    user_id: string;
    disabled: unknown;
    digest_minutes: number;
    locale: string;
  }>(
    `SELECT user_id, disabled, digest_minutes, locale FROM user_notification_prefs WHERE user_id = ANY($1::uuid[])`,
    [[...userIds]],
  );
  for (const row of result.rows) {
    map.set(row.user_id, {
      disabled: new Set(Array.isArray(row.disabled) ? (row.disabled as string[]) : []),
      digestMinutes: row.digest_minutes,
      locale: (NOTIFICATION_LOCALES as readonly string[]).includes(row.locale)
        ? (row.locale as NotificationLocale)
        : "ru",
    });
  }
  return map;
}

/** Branded notification e-mail (inline styles only — mail clients strip
 * <style>). Light card on soft background, dark header with the site
 * wordmark, category chips, per-event field tables. */
/** Official PCMS mark (apps/admin/public/brand/pcms-logo.svg), inlined as a
 * data URI: e-mail clients strip <style> and often block remote images; a
 * data URI renders in most clients and degrades to the wordmark elsewhere. */
const PCMS_LOGO_DATA_URI =
  "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9Im5vIj8+PHN2ZyB3aWR0aD0iMzIyLjY5MDA5IiBoZWlnaHQ9IjMwMi4zMzk3OCIgdmlld0JveD0iMCAwIDMyMi42OTAwOSAzMDIuMzM5NzgiIHZlcnNpb249IjEuMSIgaWQ9InN2ZzMwIiB4bWxuczppbmtzY2FwZT0iaHR0cDovL3d3dy5pbmtzY2FwZS5vcmcvbmFtZXNwYWNlcy9pbmtzY2FwZSIgeG1sbnM6c29kaXBvZGk9Imh0dHA6Ly9zb2RpcG9kaS5zb3VyY2Vmb3JnZS5uZXQvRFREL3NvZGlwb2RpLTAuZHRkIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnN2Zz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxkZWZzIGlkPSJkZWZzMjQiPjxyYWRpYWxHcmFkaWVudCBpZD0iZ3JhZC1iYW5uZXIiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIiBjeD0iMjkwIiBjeT0iLTUwIiByPSIzNzAiPjxzdG9wIG9mZnNldD0iMC40MiIgc3RvcC1jb2xvcj0iIzUyZjljZiIgaWQ9InN0b3AyIiAvPjxzdG9wIG9mZnNldD0iMC41NSIgc3RvcC1jb2xvcj0iIzIzZjJlMCIgaWQ9InN0b3A0IiAvPjxzdG9wIG9mZnNldD0iMC43MCIgc3RvcC1jb2xvcj0iIzAwZDRmNCIgaWQ9InN0b3A2IiAvPjxzdG9wIG9mZnNldD0iMC44NSIgc3RvcC1jb2xvcj0iIzAwOTdmYyIgaWQ9InN0b3A4IiAvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzAwNzFmYiIgaWQ9InN0b3AxMCIgLz48L3JhZGlhbEdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZC1sZWciIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIiB4MT0iMjgwIiB5MT0iMjA4IiB4Mj0iOTgiIHkyPSI0MTIiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzAxODVhYSIgaWQ9InN0b3AxMyIgLz48c3RvcCBvZmZzZXQ9IjAuMjUiIHN0b3AtY29sb3I9IiMwMTUxODkiIGlkPSJzdG9wMTUiIC8+PHN0b3Agb2Zmc2V0PSIwLjUiIHN0b3AtY29sb3I9IiMwNTM2NmUiIGlkPSJzdG9wMTciIC8+PHN0b3Agb2Zmc2V0PSIwLjc1IiBzdG9wLWNvbG9yPSIjMGM0ODc2IiBpZD0ic3RvcDE5IiAvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzEyNzRhMyIgaWQ9InN0b3AyMSIgLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48IS0tIGJhY2tncm91bmQgLS0+PCEtLSBsb2dvIG1hcms6IHN0eWxpemVkIFIgLS0+PGcgaWQ9ImxvZ28tbWFyayIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTEwMiwtOTcpIj48IS0tIGJhbm5lciArIGFycm93ICsgdGFpbCBiYW5kIC0tPjxwYXRoIGlkPSJiYW5uZXItYXJyb3ciIGZpbGw9InVybCgjZ3JhZC1iYW5uZXIpIiBkPSJNIDE3OC4zNiw5OS42NyBRIDE4MSw5NyAxODQuNzYsOTcgaCAxNDAuODEgcSA0LjQzLDAgNy4xMywzLjUxIGwgODkuODMsMTE2LjY4IFEgNDI3LDIyMyA0MjIuMjIsMjI4LjU1IEwgMzMwLjY0LDMzNC45NCBRIDMyOCwzMzggMzIzLjk2LDMzOC4wNiBMIDIyMy40LDMzOS42NyBRIDIwMywzNDAgMjE2LjUyLDMyNC43MSBsIDg4LjQzLC0xMDAgUSAzMTAsMjE5IDMwNS4yLDIxMy4wOCBMIDI4Mi43LDE4NS4zMyBRIDI4MCwxODIgMjc1LjcxLDE4MiBIIDExOC41NSBxIC0yMS41NSwwIC02LjQsLTE1LjMzIHoiIHN0eWxlPSJmaWxsOnVybCgjZ3JhZC1iYW5uZXIpIiAvPjwhLS0gZGlhZ29uYWwgbGVnIHN0cm9rZSAtLT48cGF0aCBpZD0ibGVnIiBmaWxsPSJ1cmwoI2dyYWQtbGVnKSIgZD0iTSAxODYuNCwyMDYuNDUgUSAxODksMjA0IDE5Mi41NywyMDQgaCA3OS43NCBxIDIwLjY5LDAgNi41OSwxNS4xNCBMIDExNy41OCwzOTIuMjcgUSAxMDIsNDA5IDEwMiwzODYuMTQgdiAtOTYuMjYgcSAwLC0zLjg4IDIuODMsLTYuNTQgeiIgc3R5bGU9ImZpbGw6dXJsKCNncmFkLWxlZykiIC8+PC9nPjwvc3ZnPg==";

export function renderNotificationEmail(input: {
  readonly locale: NotificationLocale;
  readonly siteName: string;
  /** Primary-domain origin; without it the e-mail renders without links. */
  readonly origin?: string | null;
  readonly events: readonly {
    readonly event_type: string;
    readonly data: readonly Pair[];
    readonly created_at: Date;
  }[];
}): { readonly html: string; readonly text: string } {
  const locale = input.locale;
  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const chipColors: Readonly<Record<string, string>> = {
    Лид: "#0f766e",
    Lead: "#0f766e",
    "Ответ формы": "#1d4ed8",
    Form: "#1d4ed8",
    Квиз: "#7c3aed",
    Quiz: "#7c3aed",
    Система: "#b45309",
    System: "#b45309",
    Успех: "#15803d",
    Success: "#15803d",
    Сбой: "#b91c1c",
    Failure: "#b91c1c",
    Интеграция: "#b45309",
    Integration: "#b45309",
    Техрежим: "#b45309",
    Maintenance: "#b45309",
  };
  const chip = (label: string): string => {
    const color = chipColors[label] ?? "#475569";
    return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${color}15;color:${color};font:600 12px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;border:1px solid ${color}35;">${escapeHtml(label)}</span>`;
  };
  const eventCard = (event: (typeof input.events)[number]): string => {
    const kind: EventKind = KIND_BY_EVENT_TYPE[event.event_type] ?? "update";
    const localized = renderLocalizedEvent(kind, locale, event.data);
    const rows = localized.fields
      .map(
        ([label, value]) =>
          `<tr>
             <td style="padding:6px 14px;color:#64748b;font:400 13px/1.5 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
             <td style="padding:6px 14px;color:#0f172a;font:500 13px/1.5 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;word-break:break-word;">${escapeHtml(value)}</td>
           </tr>`,
      )
      .join("");
    const when = event.created_at.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const link =
      input.origin === undefined || input.origin === null
        ? ""
        : `<a href="${escapeHtml(input.origin)}${adminPathFor(kind)}" style="color:#2563eb;font:500 12px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;text-decoration:none;">${LINK_LABELS[locale]} →</a>`;
    return `<tr><td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;border-collapse:separate;overflow:hidden;">
        <tr><td style="padding:14px 16px 4px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:0 6px 6px 0;">${localized.chips.map(chip).join('</td><td style="padding:0 6px 6px 0;">')}</td></tr></table>
          <div style="color:#0f172a;font:600 16px/1.4 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding-top:2px;">${escapeHtml(localized.title)}</div>
        </td></tr>
        ${
          localized.summary
            ? `<tr><td style="padding:2px 16px 6px 16px;color:#334155;font:400 13px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;">${escapeHtml(localized.summary)}</td></tr>`
            : ""
        }
        ${rows ? `<tr><td style="padding:4px 8px 8px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:8px;border-collapse:separate;">${rows}</table></td></tr>` : ""}
        <tr><td style="padding:0 16px 12px 16px;color:#94a3b8;font:400 12px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;">${when}${link ? ` &nbsp;·&nbsp; ${link}` : ""}</td></tr>
      </table>
    </td></tr>`;
  };

  const eventsHtml = input.events.map(eventCard).join("");
  const html = `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:0;background:#eef2f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
    <tr><td style="padding:0 8px 12px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#101828;border-radius:12px 12px 0 0;border-collapse:separate;">
        <tr>
          <td style="padding:18px 20px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="padding-right:10px;vertical-align:middle;"><img src="${PCMS_LOGO_DATA_URI}" width="26" height="24" alt="" style="display:block;border:0;" /></td>
              <td style="vertical-align:middle;">
                <span style="color:#ffffff;font:700 17px/1.3 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;">${escapeHtml(input.siteName)}</span>
                <span style="display:inline-block;margin-left:10px;padding:2px 10px;border-radius:999px;background:#ffffff1a;color:#cbd5e1;font:500 12px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;border:1px solid #ffffff2e;">Progressive CMS</span>
              </td>
            </tr></table>
          </td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:0 0 12px 12px;border-collapse:separate;padding:12px 0 4px 0;">
        ${eventsHtml}
      </table>
    </td></tr>
    <tr><td style="padding:10px 8px 4px 8px;color:#94a3b8;font:400 12px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
      ${FOOTER_LABELS[locale]}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = input.events
    .map((event) => {
      const kind: EventKind = KIND_BY_EVENT_TYPE[event.event_type] ?? "update";
      const localized = renderLocalizedEvent(kind, locale, event.data);
      const lines = localized.fields.map(([label, value]) => `  ${label}: ${value}`).join("\n");
      const link =
        input.origin === undefined || input.origin === null
          ? ""
          : `\n  ${LINK_LABELS[locale]}: ${input.origin}${adminPathFor(kind)}`;
      return `${localized.title}${localized.summary ? `\n${localized.summary}` : ""}${lines ? `\n${lines}` : ""}${link}`;
    })
    .join("\n\n");
  return { html, text: `${input.siteName} — Progressive CMS\n\n${text}\n` };
}

async function sendToUser(
  transport: MailTransport,
  from: string | undefined,
  user: RecipientUser,
  subject: string,
  body: { readonly html: string; readonly text: string },
): Promise<void> {
  await transport.send({
    to: user.email,
    ...(from === undefined ? {} : { from }),
    subject,
    text: body.text,
    html: body.html,
  });
}

export interface NotificationsSweepStats {
  readonly inserted: number;
  readonly immediate_sent: number;
  readonly digests_sent: number;
}

/** Worker entry: sweep sources → queue, deliver immediate, advance digests.
 * Safe to run concurrently with itself (send-row PK dedupe; dispatch jobs
 * are serialized by the per-minute idempotency key). */
export async function sweepNotificationsOp(app: {
  readonly pool: DbPool;
  readonly clock: Clock;
  readonly mailTransport?: MailTransport;
  /** Canonical public origin (primary domain binding); enables admin links. */
  readonly origin?: string | null;
}): Promise<NotificationsSweepStats> {
  const { inserted } = await pollSources(app);
  const transport = app.mailTransport;
  let immediateSent = 0;
  let digestsSent = 0;

  // Retention: drop acknowledged-or-not events past the window.
  await app.pool.query(
    `DELETE FROM notification_events WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(EVENTS_RETENTION_DAYS)],
  );

  const settings = await loadSettings(app.pool);
  const siteName = settings.site_name ?? "Progressive CMS";

  if (transport === undefined) {
    // No transport configured (worker without mail): events stay queued and
    // are delivered once a transport appears. Visible in worker logs.
    return { inserted, immediate_sent: 0, digests_sent: 0 };
  }

  const users = await activeUsersWithEmail(app.pool);
  const byId = new Map(users.map((user) => [user.user_id, user]));

  const resolveRecipients = async (
    category: NotificationCategory,
    formDefinitionId: string | null,
  ): Promise<RecipientUser[]> => {
    let ids: readonly string[];
    if (category === "system") {
      return users.filter((user) => user.roles.some((role) => PRIVILEGED_ROLES.includes(role)));
    }
    const override =
      formDefinitionId !== null ? settings.form_recipients[formDefinitionId] : undefined;
    if (override !== undefined && override.length > 0) {
      ids = override;
    } else {
      ids = settings.recipients[category];
    }
    return ids
      .map((id) => byId.get(id))
      .filter((user): user is RecipientUser => user !== undefined);
  };

  // Immediate + digest-eligible events inside the retry window.
  const pending = await app.pool.query<{
    id: string;
    category: NotificationCategory;
    event_type: string;
    data: unknown;
    form_definition_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, category, event_type, data, form_definition_id, created_at
     FROM notification_events
     WHERE created_at > now() - ($1 || ' days')::interval
     ORDER BY created_at, id LIMIT 500`,
    [String(WINDOW_DAYS)],
  );

  const prefs = await loadPrefs(
    app.pool,
    users.map((user) => user.user_id),
  );

  // Already-sent pairs inside the window: the immediate pass must never
  // re-send an event to a user who already got it (immediately earlier, or
  // via a digest before their mode changed).
  const sentPairs = new Set<string>();
  const sentRows = await app.pool.query<{ notification_id: string; user_id: string }>(
    `SELECT s.notification_id, s.user_id
     FROM notification_sends s
     JOIN notification_events e ON e.id = s.notification_id
     WHERE e.created_at > now() - ($1 || ' days')::interval`,
    [String(WINDOW_DAYS)],
  );
  for (const row of sentRows.rows) {
    sentPairs.add(`${row.notification_id}|${row.user_id}`);
  }
  for (const event of pending.rows) {
    const recipients = await resolveRecipients(event.category, event.form_definition_id);
    if (recipients.length === 0) continue;
    for (const user of recipients) {
      const pref = prefs.get(user.user_id);
      if (pref?.disabled.has(event.category)) continue;
      const digestMinutes = pref?.digestMinutes ?? 0;
      if (digestMinutes > 0) continue; // digest users get the sweep below
      if (sentPairs.has(`${event.id}|${user.user_id}`)) continue;
      const locale = pref?.locale ?? "ru";
      const localized = renderLocalizedEvent(
        KIND_BY_EVENT_TYPE[event.event_type] ?? "update",
        locale,
        (event.data as Pair[]) ?? [],
      );
      const body = renderNotificationEmail({
        locale,
        siteName: siteName,
        origin: app.origin ?? null,
        events: [
          {
            event_type: event.event_type,
            data: (event.data as Pair[]) ?? [],
            created_at: event.created_at,
          },
        ],
      });
      try {
        await sendToUser(transport, undefined, user, `${siteName}: ${localized.title}`, body);
        sentPairs.add(`${event.id}|${user.user_id}`);
        await app.pool.query(
          `INSERT INTO notification_sends (notification_id, user_id) VALUES ($1, $2)
           ON CONFLICT (notification_id, user_id) DO NOTHING`,
          [event.id, user.user_id],
        );
        immediateSent += 1;
      } catch (error) {
        // Leave unsent; the next sweep retries inside the window.
        console.error(
          `[notifications] immediate send failed (${event.id} → ${user.user_id}):`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  // Digest sweep: per user, when the interval elapsed since the window start.
  const digestUsers = users.filter((user) => (prefs.get(user.user_id)?.digestMinutes ?? 0) > 0);
  for (const user of digestUsers) {
    const pref = prefs.get(user.user_id);
    if (pref === undefined) continue;
    const intervalMs = (pref.digestMinutes ?? 0) * 60_000;
    const state = await app.pool.query<{ digest_since: Date }>(
      `SELECT digest_since FROM user_notification_prefs WHERE user_id = $1`,
      [user.user_id],
    );
    const since = state.rows[0]?.digest_since ?? new Date(0);
    const now = app.clock.now();
    if (now.getTime() - since.getTime() < intervalMs) continue;
    const events = await app.pool.query<{
      id: string;
      category: NotificationCategory;
      event_type: string;
      form_definition_id: string | null;
      data: unknown;
      created_at: Date;
    }>(
      `SELECT e.id, e.category, e.event_type, e.form_definition_id, e.data, e.created_at
       FROM notification_events e
       WHERE e.created_at >= $1 AND e.created_at <= $2
         AND NOT EXISTS (
           SELECT 1 FROM notification_sends s WHERE s.notification_id = e.id AND s.user_id = $3
         )
       ORDER BY e.created_at, e.id LIMIT 200`,
      [since, now, user.user_id],
    );
    // Eligibility mirrors the immediate path: a user receives a category only
    // when routing lists them (system = privileged roles), then their own
    // opt-outs apply.
    const eligible = events.rows.filter((event) => {
      if (pref.disabled.has(event.category)) return false;
      if (event.category === "system") {
        return user.roles.some((role) => PRIVILEGED_ROLES.includes(role));
      }
      const override =
        event.form_definition_id !== null
          ? settings.form_recipients[event.form_definition_id]
          : undefined;
      if (override !== undefined && override.length > 0) {
        return override.includes(user.user_id);
      }
      return (settings.recipients[event.category] ?? []).includes(user.user_id);
    });
    try {
      if (eligible.length > 0) {
        const locale = pref.locale;
        const body = renderNotificationEmail({
          locale,
          siteName: siteName,
          origin: app.origin ?? null,
          events: eligible.map((event) => ({
            event_type: event.event_type,
            data: (event.data as Pair[]) ?? [],
            created_at: event.created_at,
          })),
        });
        const grouped = new Map<string, number>();
        for (const event of eligible) {
          grouped.set(event.category, (grouped.get(event.category) ?? 0) + 1);
        }
        const subject =
          `${siteName}: ${DIGEST_SUBJECTS[locale]} — ` +
          [...grouped.entries()]
            .map(
              ([category, count]) =>
                `${CATEGORY_LABELS_LOCALIZED[category as NotificationCategory][locale]}: ${count}`,
            )
            .join(", ");
        await sendToUser(transport, undefined, user, subject, body);
        digestsSent += 1;
        for (const event of eligible) {
          await app.pool.query(
            `INSERT INTO notification_sends (notification_id, user_id) VALUES ($1, $2)
             ON CONFLICT (notification_id, user_id) DO NOTHING`,
            [event.id, user.user_id],
          );
        }
      }
      await app.pool.query(
        `UPDATE user_notification_prefs SET digest_since = $2, updated_at = now() WHERE user_id = $1`,
        [user.user_id, now],
      );
    } catch (error) {
      console.error(
        `[notifications] digest send failed (${user.user_id}):`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return { inserted, immediate_sent: immediateSent, digests_sent: digestsSent };
}
