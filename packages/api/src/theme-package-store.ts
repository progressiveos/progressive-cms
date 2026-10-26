// Staged theme packages (CORE-THEME-REMOTE-PACKAGE-CYCLE §3).
//
// The ONLY temporary state of the remote theme cycle: a ZIP an agent uploaded
// from its own machine, waiting to be validated and applied. It is never an
// editable theme, never a workflow, and never public: the opaque ref is not
// authorization — every read re-checks the actor, site AND environment that
// staged it.
//
// Storage sits next to the theme store on disk (not in PrivateTmp, not in one
// process's memory) so any Web process can serve the follow-up request, and it
// expires on a fixed TTL with bounded count/size. Concurrency is handled by the
// filesystem itself: an exclusive lock file serializes quota accounting and
// publication across processes, receipts are published by atomic rename, and
// orphaned bytes are swept by age. No daemon, no Jobs, no new database.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import type { OperationContext } from "./context.js";
import { ApiError } from "./errors.js";

/** One hour: long enough for a human-paced edit, short enough to stay garbage-free. */
export const THEME_PACKAGE_TTL_MS = 60 * 60 * 1000;
/** At most this many staged packages per store (and the same cap in bytes). */
const MAX_STAGED = 20;
const MAX_STAGED_TOTAL_BYTES = 256 * 1024 * 1024;
/** How long a caller waits for a busy store before a typed retryable answer. */
const LOCK_WAIT_MS = 5_000;
const REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEMP_SUFFIX = ".tmp";

interface StagedMeta {
  readonly package_ref: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly site_key: string;
  readonly environment: string | null;
}

function storeDirectory(themesRoot: string): string {
  try {
    const root = realpathSync(themesRoot);
    const dir = join(root, ".pcms-theme-packages");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) {
      throw new ApiError(
        "THEME_PACKAGE_STORE_INVALID",
        "staged package store must be a contained directory",
        { status: 500 },
      );
    }
    return dir;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // A store path that is not a writable directory is a deployment problem:
    // report it as such instead of an opaque 500 from mkdir/realpath.
    throw new ApiError(
      "THEME_PACKAGE_STORE_INVALID",
      `staged package store is not usable: ${error instanceof Error ? error.message : String(error)}`,
      { status: 503 },
    );
  }
}

const metaPath = (dir: string, ref: string) => join(dir, `${ref}.json`);
const bytesPath = (dir: string, ref: string) => join(dir, `${ref}.pcTheme`);

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isExpired(meta: StagedMeta, now: number): boolean {
  return Date.parse(meta.expires_at) <= now;
}

interface LockRecord {
  readonly token: string;
  readonly pid: number;
  readonly created_at: string;
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    return typeof parsed.token === "string" && typeof parsed.pid === "number"
      ? { token: parsed.token, pid: parsed.pid, created_at: parsed.created_at ?? "" }
      : null;
  } catch {
    return null;
  }
}

/** Removes the lock only if the path still points at the inode we created. */
function unlinkOwnLock(lockPath: string, ino: number): void {
  try {
    if (lstatSync(lockPath).ino !== ino) return;
  } catch {
    return; // already gone
  }
  rmSync(lockPath, { force: true });
}

/**
 * Cross-process critical section for quota accounting and publication.
 *
 * There is deliberately NO automatic stale-lock breaking. Every scheme that
 * removes another process's lock opens a window in which a third process can
 * enter the section (rename-away, age-based break, pid-based break) — and the
 * section guards a hard quota, so two entrants publish one package too many.
 * Instead the lock is only ever created (`O_EXCL`) and only ever removed by the
 * process that created it, verified by inode. A lock left by a crashed process
 * therefore blocks the store and is reported with a typed, actionable error;
 * an operator removes that one file. Losing a manual step is cheaper than an
 * unenforced quota.
 */
async function withStoreLock<T>(dir: string, work: () => Promise<T> | T): Promise<T> {
  const lockPath = join(dir, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomUUID();
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ApiError(
          "THEME_PACKAGE_STORE_INVALID",
          `staged package store lock is not usable: ${error instanceof Error ? error.message : String(error)}`,
          { status: 503 },
        );
      }
      if (Date.now() > deadline) throw await lockBusy(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    // From here on the fd and the lock belong to this call: every failure path
    // closes the descriptor and removes ONLY this inode.
    let ino: number;
    try {
      ino = fstatSync(fd).ino;
    } catch (error) {
      closeSync(fd);
      rmSync(lockPath, { force: true });
      throw new ApiError(
        "THEME_PACKAGE_STORE_INVALID",
        `staged package store lock is not usable: ${error instanceof Error ? error.message : String(error)}`,
        { status: 503 },
      );
    }
    try {
      try {
        writeFileSync(
          fd,
          JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() }),
        );
        syncPath(lockPath);
      } catch (error) {
        // A half-written record would be unreadable to everyone: clean up and
        // report a typed storage fault instead of a 500 with a leaked fd.
        unlinkOwnLock(lockPath, ino);
        throw new ApiError(
          "THEME_PACKAGE_STORE_FAILED",
          `staged package store cannot write its lock: ${error instanceof Error ? error.message : String(error)}`,
          { status: 503, retryable: true, details: [{ phase: "lock" }] },
        );
      }
      return await work();
    } finally {
      closeSync(fd);
      unlinkOwnLock(lockPath, ino);
    }
  }
}

/** Typed, actionable "someone else holds the store" answer (no auto-break). */
async function lockBusy(lockPath: string): Promise<ApiError> {
  const record = readLockRecord(lockPath);
  let ageSeconds: number | null = null;
  try {
    ageSeconds = Math.round((Date.now() - lstatSync(lockPath).mtimeMs) / 1000);
  } catch {
    // Vanished while reporting: the plain busy answer still holds.
  }
  return new ApiError(
    "THEME_PACKAGE_STORE_BUSY",
    "another process is writing to the staged package store; retry shortly",
    {
      status: 503,
      retryable: true,
      details: [
        {
          phase: "lock",
          ...(record === null ? {} : { holder_pid: record.pid }),
          ...(ageSeconds === null ? {} : { lock_age_seconds: ageSeconds }),
          // A crashed holder leaves the file behind; no process removes it
          // automatically (that would race), so name the operator action.
          hint: "for recovery, stop every Web process sharing this theme store, then remove .pcms-theme-packages/.lock in the themes root; a new upload can start after a process check",
        },
      ],
    },
  );
}

/**
 * Removes expired packages and orphaned bytes/temps. Only files this store
 * created are eligible: a `<ref>.json` receipt owns its `<ref>.pcTheme`, and
 * anything else is judged by AGE so a live upload of another process (fresh
 * bytes, no receipt yet) is never deleted.
 */
function sweep(dir: string, now: number): void {
  const receipts = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const ref = name.slice(0, -".json".length);
    const path = metaPath(dir, ref);
    try {
      const meta = JSON.parse(readFileSync(path, "utf8")) as StagedMeta;
      if (!isExpired(meta, now)) {
        receipts.add(meta.package_ref);
        continue;
      }
      rmSync(bytesPath(dir, meta.package_ref), { force: true });
      rmSync(path, { force: true });
    } catch {
      // An unreadable receipt cannot be attributed to any actor: drop it.
      rmSync(path, { force: true });
    }
  }
  // Orphans: bytes or temp files without a live receipt, older than the TTL.
  for (const name of readdirSync(dir)) {
    if (name === ".lock" || name.endsWith(".json")) continue;
    const ref = name.replace(/\.(pcTheme|tmp)$/, "").replace(/\.pcTheme\.tmp$/, "");
    if (receipts.has(ref)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs <= THEME_PACKAGE_TTL_MS) continue;
      rmSync(path, { force: true });
    } catch {
      // Vanished between readdir and stat.
    }
  }
}

function stagedEntries(dir: string): StagedMeta[] {
  const out: StagedMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as StagedMeta);
    } catch {
      // Swept by the next sweep() call.
    }
  }
  return out;
}

export interface StagedThemePackage {
  readonly package_ref: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly expires_at: string;
  readonly bytes: Buffer;
}

/** Bytes plus every orphan/temp file currently occupying the store. */
function occupiedBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (name === ".lock" || name.endsWith(".json")) continue;
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // Vanished between readdir and stat.
    }
  }
  return total;
}

/** Writes bytes + receipt atomically inside the store lock; the receipt commits. */
export async function stageThemePackageUpload(input: {
  readonly themesRoot: string;
  readonly bytes: Buffer;
  readonly ctx: OperationContext;
  readonly siteKey: string;
}): Promise<Omit<StagedThemePackage, "bytes">> {
  const dir = storeDirectory(input.themesRoot);
  return await withStoreLock(dir, () => {
    const now = Date.now();
    sweep(dir, now);
    const staged = stagedEntries(dir);
    // Orphaned bytes count toward the budget: the cap is about DISK, not
    // receipts, so a crashed upload cannot hide its leftovers.
    const totalBytes = Math.max(
      staged.reduce((sum, meta) => sum + meta.size_bytes, 0),
      occupiedBytes(dir),
    );
    if (staged.length >= MAX_STAGED || totalBytes + input.bytes.length > MAX_STAGED_TOTAL_BYTES) {
      throw new ApiError(
        "THEME_PACKAGE_STORE_FULL",
        `too many staged packages (${staged.length}/${MAX_STAGED}); wait for the TTL or apply an existing one`,
        { status: 409 },
      );
    }
    const ref = randomUUID();
    const meta: StagedMeta = {
      package_ref: ref,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      size_bytes: input.bytes.length,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + THEME_PACKAGE_TTL_MS).toISOString(),
      actor_type: input.ctx.actor.type,
      actor_id: input.ctx.actor.id,
      site_key: input.siteKey,
      environment: input.ctx.actor.environment,
    };
    const target = bytesPath(dir, ref);
    const temporaryBytes = `${target}${TEMP_SUFFIX}`;
    const receipt = metaPath(dir, ref);
    const temporaryReceipt = `${receipt}${TEMP_SUFFIX}`;
    try {
      writeFileSync(temporaryBytes, input.bytes, { mode: 0o600 });
      syncPath(temporaryBytes);
      renameSync(temporaryBytes, target);
      syncPath(dir);
      // Publish the receipt by rename: another process never observes a
      // half-written receipt, and a failed write leaves no final receipt.
      writeFileSync(temporaryReceipt, JSON.stringify(meta), { mode: 0o600 });
      syncPath(temporaryReceipt);
      renameSync(temporaryReceipt, receipt);
      syncPath(dir);
    } catch (error) {
      for (const path of [temporaryBytes, target, temporaryReceipt, receipt]) {
        rmSync(path, { force: true });
      }
      throw new ApiError(
        "THEME_PACKAGE_STORE_FAILED",
        `cannot store the uploaded package: ${error instanceof Error ? error.message : String(error)}`,
        { status: 503 },
      );
    }
    return {
      package_ref: ref,
      sha256: meta.sha256,
      size_bytes: meta.size_bytes,
      expires_at: meta.expires_at,
    };
  });
}

/**
 * A receipt without its bytes and a broken disk are different answers: ENOENT
 * (or a directory where a file should be) is "this ref is gone", while a real
 * I/O failure — EIO, ENOSPC, EACCES — is a storage fault the operator must see
 * instead of a 404 that hides it. No path or errno detail leaves the server.
 */
function storageFailure(error: unknown, phase: "resolve" | "read"): ApiError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return notFound();
  if (code === "EISDIR") {
    // A directory where the package bytes belong: the staged copy was
    // replaced, which is corruption rather than a missing ref.
    return new ApiError(
      "THEME_PACKAGE_CORRUPT",
      "staged package bytes were replaced; upload the package again",
      { status: 409 },
    );
  }
  return new ApiError(
    "THEME_PACKAGE_STORE_FAILED",
    `staged package store cannot ${phase} the package (storage fault); retry or contact the operator`,
    { status: 503, retryable: true, details: [{ phase }] },
  );
}

const notFound = () =>
  new ApiError(
    "THEME_PACKAGE_NOT_FOUND",
    "no staged theme package with this reference (expired, already applied or not yours)",
    { status: 404 },
  );

/**
 * Reads a staged package for the CURRENT actor + site + environment. Another
 * actor's, another site's, another environment's or an expired ref is
 * indistinguishable from a missing one — the ref is not a capability. The
 * digest is re-verified: bytes that changed on disk are refused, not applied.
 */
export async function readStagedThemePackage(input: {
  readonly themesRoot: string;
  readonly ref: string;
  readonly ctx: OperationContext;
  readonly siteKey: string;
}): Promise<StagedThemePackage> {
  if (!REF_RE.test(input.ref)) throw notFound();
  const dir = storeDirectory(input.themesRoot);
  let meta: StagedMeta;
  let raw: string;
  try {
    raw = readFileSync(metaPath(dir, input.ref), "utf8");
  } catch (error) {
    // Missing/unreadable receipt: the ref does not exist for this caller. A
    // real storage fault (EIO, EACCES) surfaces as such instead of a 404.
    throw storageFailure(error, "read");
  }
  try {
    meta = JSON.parse(raw) as StagedMeta;
  } catch {
    throw notFound(); // a receipt that is not JSON is not a usable ref
  }
  // The ref is bound to the exact context that staged it. `null` environment
  // is a real value, not a wildcard: an unscoped token cannot pick up a
  // production package.
  if (
    meta.actor_type !== input.ctx.actor.type ||
    meta.actor_id !== input.ctx.actor.id ||
    meta.site_key !== input.siteKey ||
    (meta.environment ?? null) !== (input.ctx.actor.environment ?? null)
  ) {
    throw notFound();
  }
  if (isExpired(meta, Date.now())) throw notFound();
  const path = bytesPath(dir, input.ref);
  let real: string;
  try {
    real = realpathSync(path);
  } catch (error) {
    throw storageFailure(error, "resolve");
  }
  if (!real.startsWith(`${dir}${sep}`)) throw notFound();
  let bytes: Buffer;
  try {
    bytes = readFileSync(real);
  } catch (error) {
    throw storageFailure(error, "read");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== meta.sha256) {
    throw new ApiError(
      "THEME_PACKAGE_CORRUPT",
      "staged package bytes do not match the recorded digest; upload it again",
      { status: 409 },
    );
  }
  return {
    package_ref: meta.package_ref,
    sha256: meta.sha256,
    size_bytes: meta.size_bytes,
    expires_at: meta.expires_at,
    bytes,
  };
}

/** Themes root (parent of the configured renderDir theme) for the store. */
export function themesRootOf(configuredDir: string | undefined): string | null {
  return configuredDir === undefined ? null : dirname(configuredDir);
}
