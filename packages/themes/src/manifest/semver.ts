import semver from "semver";

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parses an exact `major.minor.patch` version; null when malformed. */
export function parseVersion(value: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!m) return null;
  const major = Number.parseInt(m[1] ?? "", 10);
  const minor = Number.parseInt(m[2] ?? "", 10);
  const patch = Number.parseInt(m[3] ?? "", 10);
  if ([major, minor, patch].some((n) => !Number.isFinite(n))) return null;
  return { major, minor, patch };
}

/** True for a valid npm SemVer range, including prerelease and compound ranges. */
export function isValidVersionRange(range: string): boolean {
  return semver.validRange(range) !== null;
}

/** True when `version` satisfies an npm SemVer range. */
export function satisfiesVersion(version: string, range: string): boolean {
  const partial = /^(\d+)(?:\.(\d+))?$/.exec(version);
  const normalized =
    semver.valid(version) ?? (partial === null ? null : `${partial[1]}.${partial[2] ?? "0"}.0`);
  return (
    normalized !== null &&
    isValidVersionRange(range) &&
    semver.satisfies(normalized, range, { includePrerelease: true })
  );
}
