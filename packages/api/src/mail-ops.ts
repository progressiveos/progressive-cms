// Mail operations (PCMS-OPS-T110; Operations spec §31). Auth + audit live
// here; the probe/send mechanics belong to the transport (packages/
// integrations). Diagnostics never contain credentials — the transport
// contract guarantees that (SmtpError carries step + server reply only).
import { recordSecurityEvent } from "@pcms/auth";
import { type ApplicationServices, auditBase, type OperationContext } from "./context.js";
import { ApiError } from "./errors.js";

export interface MailTestResult {
  readonly configured: boolean;
  readonly transport: "smtp" | "console";
  readonly verified?: {
    readonly host: string;
    readonly port: number;
    readonly mode: string;
    readonly authenticated: boolean;
    readonly elapsed_ms: number;
  };
  readonly sent?: { readonly to: string; readonly message_id: string };
}

export interface MailTestOverride {
  readonly host?: string;
  readonly port?: number;
  readonly mode?: "smtps" | "starttls" | "plain";
  readonly username?: string;
  /** Only when the operator typed one; otherwise the stored password (if any)
   * is used for the probe and never echoed anywhere. */
  readonly password?: string;
}

export async function testMailTransport(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly to?: string; readonly override?: MailTestOverride },
): Promise<MailTestResult> {
  // The route spec declares `integrations.test`; the op layer enforces it
  // (defense in depth — a route without the explicit authorize call must
  // never reach the transport, T117 finding).
  app.authorize(ctx.actor, "integrations.test");
  if (app.mailVerify === undefined) {
    throw new ApiError("MAIL_NOT_CONFIGURED", "no mail transport is configured", { status: 503 });
  }
  // Owner fix: the "Test connection" action probes the values currently typed in
  // the form (merged over the stored row so the stored password can be
  // reused without ever displaying or saving it) — not just the last saved
  // state.
  const override = input.override;
  if (override?.host !== undefined) {
    const stored = await loadActiveSmtpOptions(app.pool, app.runtimeSecretBox).catch(() => null);
    const mode = override.mode ?? stored?.mode ?? "starttls";
    const username = override.username ?? stored?.username;
    const password = override.password ?? stored?.password;
    const options = {
      host: override.host,
      port: override.port ?? stored?.port ?? (mode === "smtps" ? 465 : 587),
      mode,
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      from: stored?.from ?? "probe@invalid",
    };
    const verified = await verifySmtpConnection(options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError("MAIL_VERIFY_FAILED", message, { status: 502 });
    });
    return {
      configured: true,
      transport: "smtp",
      verified: {
        host: verified.host,
        port: verified.port,
        mode: verified.mode,
        authenticated: verified.authenticated,
        elapsed_ms: verified.elapsed_ms,
      },
    };
  }
  const transport = app.mailTransport;
  if (input.to !== undefined && transport === undefined) {
    throw new ApiError("MAIL_NOT_CONFIGURED", "no mail transport is configured", { status: 503 });
  }
  const verified = await app.mailVerify().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError("MAIL_VERIFY_FAILED", message, { status: 502 });
  });
  let sent: MailTestResult["sent"] | undefined;
  if (input.to !== undefined && transport !== undefined) {
    const result = await transport
      .send({
        to: input.to,
        subject: "Progressive CMS — test email",
        text:
          "This is a test message sent by the POST /mail/test operation " +
          `(restart-safe; recipient: ${input.to}).`,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new ApiError("MAIL_SEND_FAILED", message, { status: 502 });
      });
    sent = { to: input.to, message_id: result.messageId };
  }
  return {
    configured: true,
    // mailVerify is only registered for the SMTP transport; console mode
    // registers just the transport (its "verify" is trivially a no-op log).
    transport: "smtp",
    verified: {
      host: verified.host,
      port: verified.port,
      mode: verified.mode,
      authenticated: verified.authenticated,
      elapsed_ms: verified.elapsed_ms,
    },
    ...(sent === undefined ? {} : { sent }),
  };
}

/* --- Admin-managed SMTP settings (PCMS-OPS-T130; migration 1601) --- */

import {
  buildSmtpOptionsForWrite,
  loadActiveSmtpOptions,
  loadMailSettings,
  MailSettingsError,
  type MailSettingsView,
  type MailSettingsWrite,
  saveMailSettings,
  verifySmtpConnection,
} from "@pcms/integrations";

export interface MailSettingsWire {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly from: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly mode: "smtps" | "starttls" | "plain" | null;
  readonly username: string | null;
  /** Never the password itself — only whether one is stored. */
  readonly password_set: boolean;
  readonly encryption_ready: boolean;
  readonly updated_at: string | null;
  readonly updated_by: string | null;
}

export async function getMailSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<MailSettingsWire> {
  app.authorize(ctx.actor, "integrations.read");
  const view = await loadMailSettings(app.pool);
  return toWire(view, app.runtimeSecretBox !== undefined);
}

export interface MailSettingsInput {
  readonly enabled: boolean;
  readonly from: string;
  readonly host: string;
  readonly port?: number;
  readonly mode?: "smtps" | "starttls" | "plain";
  readonly username?: string;
  /** string → store; null → clear; absent → keep the stored value. */
  readonly password?: string | null;
}

export async function updateMailSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: MailSettingsInput,
): Promise<MailSettingsWire> {
  app.authorize(ctx.actor, "integrations.configure");
  const before = await loadMailSettings(app.pool);
  const mode = input.mode ?? "starttls";
  const write: MailSettingsWrite = {
    enabled: input.enabled,
    from: input.from,
    host: input.host,
    port: input.port ?? (mode === "smtps" ? 465 : 587),
    mode,
    ...(input.username === undefined ? {} : { username: input.username }),
    ...(input.password === undefined
      ? {}
      : input.password === null
        ? { password: { clear: true as const } }
        : { password: { set: input.password } }),
  };
  // Enabling verifies the connection BEFORE anything is persisted — the
  // operator never ends up with an enabled-but-broken transport (same
  // no-optimistic-state contract as the maintenance toggle).
  if (input.enabled) {
    if (input.from.length === 0 || !input.from.includes("@")) {
      throw new ApiError("API_REQUEST_INVALID", "from must be a mailbox address", { status: 422 });
    }
    const candidate = await buildSmtpOptionsForWrite(app.pool, app.runtimeSecretBox, write);
    if (candidate !== null) {
      try {
        await verifySmtpConnection(candidate);
      } catch (error) {
        const message =
          error instanceof MailSettingsError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        throw new ApiError(
          error instanceof MailSettingsError ? error.code : "MAIL_VERIFY_FAILED",
          message,
          { status: error instanceof MailSettingsError ? 409 : 502 },
        );
      }
    }
  }
  const after = await saveMailSettings(
    app.pool,
    app.runtimeSecretBox,
    write,
    `user:${ctx.actor.id}`,
  ).catch((error: unknown) => {
    if (error instanceof MailSettingsError) {
      throw new ApiError(error.code, error.message, { status: 409 });
    }
    throw error;
  });
  await recordSecurityEvent(app.pool, null, {
    type: "MAIL_SETTINGS_UPDATED",
    ...auditBase(ctx),
    subjectType: "site",
    subjectId: "mail",
    metadata: {
      enabled: after.enabled,
      previous_enabled: before?.enabled ?? false,
      // Never the credential values — only which fields the actor touched.
      updated_fields: Object.keys(input).sort(),
      password_changed: input.password !== undefined,
    },
  });
  return toWire(after, app.runtimeSecretBox !== undefined);
}

function toWire(view: MailSettingsView | null, encryptionReady: boolean): MailSettingsWire {
  return {
    configured: view !== null,
    enabled: view?.enabled ?? false,
    from: view?.from ?? null,
    host: view?.host ?? null,
    port: view?.port ?? null,
    mode: view?.mode ?? null,
    username: view?.username ?? null,
    password_set: view?.has_password ?? false,
    encryption_ready: encryptionReady,
    updated_at: view?.updated_at === undefined ? null : new Date(view.updated_at).toISOString(),
    updated_by: view?.updated_by ?? null,
  };
}
