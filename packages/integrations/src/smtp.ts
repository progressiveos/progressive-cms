// Production SMTP mail transport (PCMS-OPS-T110; Operations spec §31, §69).
//
// Dependency-free RFC 5321 client (EHLO/AUTH PLAIN/MAIL/RCPT/DATA/QUIT) over
// node:tls / node:net. Credentials are injected as resolved secret values and
// are NEVER included in error messages or diagnostics — failures carry the
// protocol step and the server reply only.
import { connect as netConnect, type Socket } from "node:net";
import { type ConnectionOptions, connect as tlsConnect } from "node:tls";

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  /** smtps = TLS from the start; starttls = upgrade after EHLO; plain = no TLS. */
  readonly mode: "smtps" | "starttls" | "plain";
  readonly username?: string;
  readonly password?: string;
  /** Envelope/from used when a message does not carry its own `from`. */
  readonly from: string;
  readonly connectTimeoutMs?: number;
}

export class SmtpError extends Error {
  readonly code: string;
  readonly step: string;
  constructor(code: string, step: string, message: string) {
    super(`smtp ${step}: ${message}`);
    this.code = code;
    this.step = step;
  }
}

interface Reply {
  readonly code: number;
  readonly lines: string[];
}

function isTls(socket: Socket): boolean {
  return "getProtocol" in socket;
}

/** CRLF-injection guard (header/command smuggling): CR/LF inside the
 * envelope, recipient or subject would terminate the SMTP command or DATA
 * line early and let an attacker inject extra commands/headers. Such values
 * are rejected before any byte reaches the wire. */
function assertNoCrlf(step: string, value: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw new SmtpError("SMTP_INVALID_INPUT", step, "CR/LF is not allowed in this field");
  }
}

class SmtpSession {
  private buffer = "";
  private replyWaiter: ((reply: Reply) => void) | null = null;
  private lastCapabilities = "";
  private authenticated = false;

  private constructor(
    private socket: Socket,
    private readonly timeoutMs: number,
    private readonly host: string,
  ) {
    socket.setTimeout(timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.on("timeout", () => this.fail(new SmtpError("SMTP_TIMEOUT", "io", "socket timed out")));
    socket.on("error", (error: Error) =>
      this.fail(new SmtpError("SMTP_IO_FAILED", "io", error.message)),
    );
  }

  private fail(error: SmtpError): void {
    this.replyWaiter?.(undefined as never) ?? this.rejectCurrent(error);
    this.socket.destroy();
  }

  private pendingReject: ((error: SmtpError) => void) | null = null;
  private rejectCurrent(error: SmtpError): void {
    this.pendingReject?.(error);
    this.pendingReject = null;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    this.tryParse();
  }

  private tryParse(): void {
    if (this.replyWaiter === null) return;
    const lines: string[] = [];
    for (;;) {
      const sep = this.buffer.indexOf("\r\n");
      if (sep < 0) return;
      const line = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (match === null) {
        this.rejectCurrent(
          new SmtpError("SMTP_PROTOCOL", "reply", `unparsable "${line.slice(0, 80)}"`),
        );
        return;
      }
      lines.push(line);
      if (match[2] === " ") break;
    }
    const waiter = this.replyWaiter;
    this.replyWaiter = null;
    waiter({ code: Number(lines[lines.length - 1]!.slice(0, 3)), lines });
  }

  private readReply(): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replyWaiter = null;
        reject(new SmtpError("SMTP_TIMEOUT", "reply", "no complete reply in time"));
      }, this.timeoutMs);
      this.pendingReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.replyWaiter = (reply) => {
        clearTimeout(timer);
        this.pendingReject = null;
        resolve(reply);
      };
      this.tryParse();
    });
  }

  private async command(verb: string, payload: string | undefined, expect: number): Promise<Reply> {
    this.socket.write((payload === undefined ? verb : `${verb} ${payload}`) + "\r\n");
    const reply = await this.readReply();
    if (Math.floor(reply.code / 100) !== Math.floor(expect / 100)) {
      throw new SmtpError(
        "SMTP_REJECTED",
        verb.split(" ")[0]!,
        `${reply.code} ${reply.lines.join(" ").slice(0, 200)}`,
      );
    }
    return reply;
  }

  static async connect(options: SmtpOptions): Promise<SmtpSession> {
    const timeoutMs = options.connectTimeoutMs ?? 10000;
    const session =
      options.mode === "smtps"
        ? new SmtpSession(
            tlsConnect({
              host: options.host,
              port: options.port,
              serverName: options.host,
            } as ConnectionOptions),
            timeoutMs,
            options.host,
          )
        : new SmtpSession(
            netConnect({ host: options.host, port: options.port }),
            timeoutMs,
            options.host,
          );
    await new Promise<void>((resolve, reject) => {
      const socket = session.socket;
      const ok = () => {
        socket.removeListener("error", bad);
        resolve();
      };
      const bad = (error: Error) => {
        socket.removeListener(isTls(socket) ? "secureConnect" : "connect", ok);
        reject(new SmtpError("SMTP_CONNECT_FAILED", "connect", error.message));
      };
      socket.once(isTls(socket) ? "secureConnect" : "connect", ok);
      socket.once("error", bad);
    });
    const greeting = await session.readReply();
    if (greeting.code !== 220) {
      throw new SmtpError("SMTP_REJECTED", "greeting", `${greeting.code}`);
    }
    const ehlo = await session.command("EHLO", "progressive-cms", 250);
    session.lastCapabilities = ehlo.lines.join(" ");
    if (options.mode === "starttls") {
      await session.command("STARTTLS", undefined, 220);
      const plain = session.socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("timeout");
      plain.removeAllListeners("error");
      const upgraded = tlsConnect({ socket: plain, serverName: options.host } as ConnectionOptions);
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", () => resolve());
        upgraded.once("error", (e: Error) =>
          reject(new SmtpError("SMTP_TLS_FAILED", "starttls", e.message)),
        );
      });
      session.buffer = "";
      session.socket = upgraded;
      upgraded.setTimeout(timeoutMs);
      upgraded.setEncoding("utf8");
      upgraded.on("data", (chunk: string) => session.consume(chunk));
      upgraded.on("timeout", () =>
        session.fail(new SmtpError("SMTP_TIMEOUT", "io", "socket timed out")),
      );
      upgraded.on("error", (error: Error) =>
        session.fail(new SmtpError("SMTP_IO_FAILED", "io", error.message)),
      );
      await session.command("EHLO", "progressive-cms", 250);
    }
    if (options.username !== undefined && options.password !== undefined) {
      const token = Buffer.from(`\0${options.username}\0${options.password}`).toString("base64");
      await session.command("AUTH PLAIN", token, 235);
      session.authenticated = true;
    }
    return session;
  }

  diagnostics(): { authenticated: boolean; capabilities: string } {
    return { authenticated: this.authenticated, capabilities: this.lastCapabilities.slice(0, 400) };
  }

  async send(
    from: string,
    message: {
      readonly to: string;
      readonly from?: string;
      readonly subject?: string;
      readonly text?: string;
      readonly html?: string;
    },
  ): Promise<string> {
    const envelope = message.from ?? from;
    assertNoCrlf("MAIL FROM", envelope);
    assertNoCrlf("RCPT TO", message.to);
    if (message.subject !== undefined) assertNoCrlf("Subject", message.subject);
    await this.command("MAIL", `FROM:<${envelope}>`, 250);
    await this.command("RCPT", `TO:<${message.to}>`, 250);
    await this.command("DATA", undefined, 354);
    const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${this.host}>`;
    const body = [
      `From: <${envelope}>`,
      `To: <${message.to}>`,
      `Subject: ${message.subject ?? "(no subject)"}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      'Content-Type: text/plain; charset="utf-8"',
      "MIME-Version: 1.0",
      "",
      message.text ?? (message.html === undefined ? "" : "(html content)"),
    ]
      .join("\r\n")
      .replace(/\r\n\./g, "\r\n..");
    this.socket.write(body + "\r\n.\r\n");
    const reply = await this.readReply();
    if (reply.code !== 250) {
      throw new SmtpError(
        "SMTP_REJECTED",
        "DATA",
        `${reply.code} ${reply.lines.join(" ").slice(0, 200)}`,
      );
    }
    return messageId;
  }

  async quit(): Promise<void> {
    try {
      await this.command("QUIT", undefined, 221);
    } catch {
      // post-QUIT hangup is not an operation failure
    }
    this.socket.end();
  }
}

export interface SmtpDiagnostics {
  readonly host: string;
  readonly port: number;
  readonly mode: "smtps" | "starttls" | "plain";
  readonly authenticated: boolean;
  readonly capabilities: string;
  readonly elapsed_ms: number;
}

/** Safe probe (Integrations spec §40): reachable + authenticates, sends nothing. */
export async function verifySmtpConnection(options: SmtpOptions): Promise<SmtpDiagnostics> {
  const started = Date.now();
  const session = await SmtpSession.connect(options);
  try {
    const diag = session.diagnostics();
    return {
      host: options.host,
      port: options.port,
      mode: options.mode,
      ...diag,
      elapsed_ms: Date.now() - started,
    };
  } finally {
    await session.quit();
  }
}

export function createSmtpMailTransport(options: SmtpOptions): import("./email.js").MailTransport {
  return {
    async send(message) {
      const session = await SmtpSession.connect(options);
      try {
        return { messageId: await session.send(options.from, message) };
      } finally {
        await session.quit();
      }
    },
  };
}
