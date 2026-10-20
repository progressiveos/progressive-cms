// Spawns real CMS processes (web/worker) under tsx with a controlled
// environment and structured-log capture. Used by the process skeleton
// tests and the M01 integration gate (PCMS-OPS-T007/T010).
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

export type PcmsEntry = "apps/web/src/main.ts" | "apps/worker/src/main.ts";
type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>;

export interface SpawnedProcess {
  child: SpawnedChild;
  lines: Record<string, unknown>[];
  /** Resolves with the first log line carrying `msg` (or rejects on timeout). */
  waitFor(msg: string, timeoutMilliseconds?: number): Promise<Record<string, unknown>>;
  exited: Promise<number | null>;
  stop: () => void;
}

export function spawnPcmsProcess(
  entry: PcmsEntry,
  args: string[],
  env: NodeJS.ProcessEnv,
): SpawnedProcess {
  const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        lines.push({ raw: line });
      }
    }
  });
  const waitFor = (msg: string, timeoutMilliseconds = 20_000): Promise<Record<string, unknown>> =>
    new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        rejectWait(
          new Error(
            `"${msg}" not observed within ${timeoutMilliseconds}ms; saw: ${JSON.stringify(lines)}`,
          ),
        );
        child.kill("SIGKILL");
      }, timeoutMilliseconds);
      const poll = setInterval(() => {
        const found = lines.find((line) => line.msg === msg);
        if (found) {
          clearTimeout(timer);
          clearInterval(poll);
          resolveWait(found);
        }
      }, 50);
    });
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("exit", (code) => resolveExit(code));
  });
  return { child, lines, waitFor, exited, stop: () => child.kill("SIGTERM") };
}
