// Mail surface composition (PCMS-OPS-T110; Operations spec §31/§69). Maps the
// deployment `mail` config onto an application transport + safe probe. Shared
// by web AND worker (0.1.194): integration deliveries and notification mail
// run in the worker, which previously had no transport at all — email
// connector actions failed closed at dispatch. Resolved credential values
// live only inside the transport closure — they never reach logs, config
// dumps or API responses. The config/secret params are structural (the
// composition layer injects @pcms/core's config + secret loader) — this
// package keeps no build dependency on @pcms/core config types.
import type { DbPool } from "@pcms/core";
import { createConsoleMailTransport } from "./console-mail.js";
import type { MailTransport } from "./email.js";
import { loadActiveSmtpOptions, type MailSecretBox } from "./mail-settings.js";
import {
  createSmtpMailTransport,
  type SmtpDiagnostics,
  SmtpError,
  verifySmtpConnection,
} from "./smtp.js";

/** Structural subset of the deployment `mail` config (AppConfig["mail"]). */
export interface MailConfigView {
  readonly transport?: string;
  readonly host?: string;
  readonly port?: number;
  readonly mode?: string;
  readonly from?: string;
  readonly usernameSecretRef?: string;
  readonly passwordSecretRef?: string;
  readonly connectTimeoutMs?: number;
}

/** Structural secret loader (ResolvedSecrets). */
export interface MailSecretLoader {
  require(ref: string): string;
}

export interface MailSurface {
  readonly transport: MailTransport;
  readonly verify?: () => Promise<SmtpDiagnostics>;
}

export function buildMailSurface(
  mail: MailConfigView | undefined,
  secrets: MailSecretLoader,
): MailSurface | undefined {
  if (mail === undefined) return undefined;
  if ((mail.transport ?? "smtp") === "console") {
    return { transport: createConsoleMailTransport({}) };
  }
  if (mail.host === undefined || mail.from === undefined) {
    throw new Error("config mail: smtp transport requires host and from");
  }
  const username =
    mail.usernameSecretRef === undefined ? undefined : secrets.require(mail.usernameSecretRef);
  const password =
    mail.passwordSecretRef === undefined ? undefined : secrets.require(mail.passwordSecretRef);
  const options = {
    host: mail.host,
    port: mail.port ?? (mail.mode === undefined || mail.mode === "smtps" ? 465 : 587),
    mode: mail.mode === "smtps" ? "smtps" : "starttls",
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    from: mail.from,
    ...(mail.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: mail.connectTimeoutMs }),
  } as const;
  return {
    transport: createSmtpMailTransport(options),
    verify: () => verifySmtpConnection(options),
  };
}

/**
 * Admin-managed override (PCMS-OPS-T130): wraps the config-built surface so
 * every send/probe first checks the runtime mail settings (migration 1601).
 * An enabled, complete row wins; anything else falls back to the deployment
 * config. Resolution is per call — mail volume is tiny and operators expect
 * the toggle to take effect immediately (no TTL staleness).
 */
export function applyManagedMailSettings(
  base: MailSurface | undefined,
  deps: {
    readonly pool: DbPool;
    readonly secretBox?: MailSecretBox;
    readonly logger: { warn(msg: string, fields?: Record<string, unknown>): void };
  },
): MailSurface {
  const resolveActive = async () => {
    try {
      return await loadActiveSmtpOptions(deps.pool, deps.secretBox);
    } catch (cause) {
      // Settings unreadable → fall back to deployment config rather than
      // dropping mail entirely; the failure is visible in the log.
      deps.logger.warn("mail.settings.resolve_failed", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return null;
    }
  };
  return {
    transport: {
      async send(message) {
        const active = await resolveActive();
        if (active !== null) return createSmtpMailTransport(active).send(message);
        if (base?.transport !== undefined) return base.transport.send(message);
        throw new SmtpError("SMTP_NOT_CONFIGURED", "config", "no mail transport is configured");
      },
    },
    verify: async () => {
      const active = await resolveActive();
      if (active !== null) return verifySmtpConnection(active);
      if (base?.verify !== undefined) return base.verify();
      throw new SmtpError("SMTP_NOT_CONFIGURED", "config", "no mail transport is configured");
    },
  };
}
