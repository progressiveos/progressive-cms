// Archive path rules and the .pcpub entry allowlist (ADR-0014 §2, §18).
// Fail closed: every rule violation is a rejection, never a skip.
import { PcpubError } from "./diagnostics.js";

export const PCPUB_MANIFEST_PATH = "manifest.json";
export const PCPUB_CONTENT_PREFIX = "content/";
export const PCPUB_ASSETS_PREFIX = "assets/";
export const PCPUB_ARTIFACT_ROOTS = ["research/", "review/"] as const;
export const PCPUB_AUTHOR_NOTES_PATH = "author-notes.md";

/** Validate an archive path (relative, `/`-separated, safe segments). */
export function assertValidEntryPath(path: string): void {
  const fail = (message: string): never => {
    throw new PcpubError("PCPUB_ARCHIVE_UNSAFE_PATH", message, { path });
  };
  if (path.length === 0 || path.length > 512) fail("path length out of bounds");
  if (Buffer.from(path, "utf8").length !== path.length) fail("path is not valid UTF-8/ASCII-safe");
  if (path.includes("\\") || path.includes("\0")) fail("path contains backslash or NUL");
  if (path.startsWith("/")) fail("path is absolute");
  if (path.endsWith("/")) fail("directory entries are not allowed");
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) fail("path contains control characters");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) fail("path contains an empty segment");
    if (segment === "." || segment === "..") fail("path contains a relative segment");
  }
}

/** The only entry shapes a .pcpub may contain (exact-set is enforced above this). */
export function isAllowedEntryPath(path: string): boolean {
  if (path === PCPUB_MANIFEST_PATH) return true;
  if (path === PCPUB_AUTHOR_NOTES_PATH) return true;
  if (path.startsWith(PCPUB_CONTENT_PREFIX)) {
    const name = path.slice(PCPUB_CONTENT_PREFIX.length);
    return !name.includes("/") && name.endsWith(".pcmd");
  }
  for (const root of PCPUB_ARTIFACT_ROOTS) {
    if (path.startsWith(root)) return true;
  }
  if (path.startsWith(PCPUB_ASSETS_PREFIX)) return true;
  return false;
}

/** Artifact kind inferred from the allowed roots; null when not an artifact. */
export function artifactKindOf(path: string): "research" | "review" | "author_notes" | null {
  if (path.startsWith("research/")) return "research";
  if (path.startsWith("review/")) return "review";
  if (path === PCPUB_AUTHOR_NOTES_PATH) return "author_notes";
  return null;
}
