// Worker for the staged-package store concurrency regressions: one real
// separate process staging one package, so quota accounting and receipt
// publication are exercised across processes (not just across promises).
//
// Usage: node --import tsx tests/helpers/theme-package-stage-worker.ts <themesRoot> <bytes> <startAtEpochMs>
// Prints one JSON line: { ok: true, package_ref } | { ok: false, code, hint? }
//
// The start time is a rendezvous point: the parent spawns several workers with
// the same value so they enter the store together instead of one after another.
import { stageThemePackageUpload } from "../../packages/api/src/theme-package-store.js";

const [themesRoot, size, startAt] = process.argv.slice(2);
if (themesRoot === undefined || size === undefined) {
  process.stderr.write("usage: <themesRoot> <bytes> [startAtEpochMs]\n");
  process.exit(2);
}

const ctx = {
  actor: {
    type: "machine",
    id: "concurrency-worker",
    permissions: new Set<string>(),
    siteKey: "default",
    environment: "production",
  },
  transport: "test",
  requestId: "req_worker",
} as never;

try {
  // Rendezvous: every worker waits until the shared start instant, so the
  // processes really overlap in the quota window.
  if (startAt !== undefined) {
    const wait = Number(startAt) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  const staged = await stageThemePackageUpload({
    themesRoot,
    bytes: Buffer.alloc(Number(size), 0x5a),
    ctx,
    siteKey: "default",
  });
  process.stdout.write(`${JSON.stringify({ ok: true, package_ref: staged.package_ref })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: (error as { code?: string }).code ?? "UNKNOWN",
      hint: (error as { details?: { hint?: string }[] }).details?.[0]?.hint,
    })}\n`,
  );
}
