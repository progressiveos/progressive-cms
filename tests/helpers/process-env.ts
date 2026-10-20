// Controlled child-process environment for spawning CMS processes in tests.
//
// The config loader rejects unknown PCMS_* variables fail-securely (ADR-0004),
// so a spawned process must never inherit the runner's full environment —
// only an explicit, intended set of PCMS_* variables plus a minimal PATH/HOME.
export function cmsProcessEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: process.env.LANG,
    ...overrides,
  };
}
