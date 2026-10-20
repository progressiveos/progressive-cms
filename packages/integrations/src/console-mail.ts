// Console mail transport — the safe boundary (PCMS-OPS-T110, Operations spec
// §31/§69). Logs the envelope (recipients + subject) and sends nothing. Use
// it where no SMTP credentials exist (development, staging rehearsal, the
// documented no-credential test path); never in a deployment that must
// deliver real mail.
import type { MailTransport } from "./email.js";

export function createConsoleMailTransport(options: {
  readonly log?: (line: string) => void;
}): MailTransport {
  const log = options.log ?? ((line: string) => console.log(line));
  let counter = 0;
  return {
    async send(message) {
      counter += 1;
      const messageId = `<console-${Date.now()}-${counter}@pcms.invalid>`;
      log(
        `[mail:console] (not sent) to=<${message.to}> subject=${JSON.stringify(
          message.subject ?? "(no subject)",
        )} messageId=${messageId}`,
      );
      return { messageId };
    },
  };
}
