// Secret loading baseline (PCMS-OPS-T009, Operations spec §9/§10).
//
// secret != ordinary config: the config document only names secrets; values
// are resolved here at process start, from an environment variable or a
// permission-restricted file (0600). Fail-secure: a missing, empty or
// wrongly-permissioned secret is a startup error — never a silent default.
// Resolved values live in an opaque frozen object and are never dumped;
// the logger's redaction pass is the second line of defense (ADR-0004).
import { readFileSync, statSync } from "node:fs";
import type { SecretRef } from "../config/schema.js";

export interface SecretIssue {
  name: string;
  message: string;
}

export class SecretError extends Error {
  readonly issues: readonly SecretIssue[];

  constructor(message: string, issues: readonly SecretIssue[]) {
    super(message);
    this.name = "SecretError";
    this.issues = issues;
  }
}

export interface ResolvedSecrets {
  get(name: string): string | undefined;
  /** Throws SecretError when the secret was not provided. */
  require(name: string): string;
  names(): string[];
}

export function loadSecrets(
  refs: Readonly<Record<string, SecretRef>>,
  env: Record<string, string | undefined> = process.env,
): ResolvedSecrets {
  const values = new Map<string, string>();
  const issues: SecretIssue[] = [];

  for (const [name, ref] of Object.entries(refs)) {
    if (ref.env !== undefined) {
      const value = env[ref.env];
      if (value === undefined || value === "") {
        issues.push({ name, message: `environment variable ${ref.env} is not set or empty` });
      } else {
        values.set(name, value);
      }
    } else if (ref.file !== undefined) {
      try {
        values.set(name, readSecretFile(ref.file));
      } catch (error) {
        issues.push({ name, message: error instanceof Error ? error.message : String(error) });
      }
    } else {
      issues.push({ name, message: "secret reference has neither an env nor a file source" });
    }
  }

  if (issues.length > 0) {
    throw new SecretError(
      `secret loading failed (${issues.length} issue(s)): ${issues
        .map((issue) => `${issue.name} — ${issue.message}`)
        .join("; ")}`,
      issues,
    );
  }

  return {
    get: (name) => values.get(name),
    require: (name) => {
      const value = values.get(name);
      if (value === undefined) {
        throw new SecretError(`required secret "${name}" was not loaded`, [
          { name, message: "not loaded" },
        ]);
      }
      return value;
    },
    names: () => [...values.keys()],
  };
}

function readSecretFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error(`secret file "${path}" is not a regular file`);
  }
  // Operations §9/§58: secrets readable only by the service account. Fail
  // securely on group/world bits instead of proceeding with a leaky file.
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `secret file "${path}" has permissive mode ${mode.toString(8).padStart(3, "0")}; 0600 required`,
    );
  }
  const content = readFileSync(path, "utf8");
  const trimmed = content.replace(/\r?\n$/, ""); // editors add one trailing newline
  if (trimmed === "") {
    throw new Error(`secret file "${path}" is empty`);
  }
  return trimmed;
}
