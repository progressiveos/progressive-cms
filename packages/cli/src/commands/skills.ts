// Skills CLI (PCMS-SKILL-T018; task brief §74). The release layout ships
// skills/ — this family answers "which skills are installed, what do they
// require, are they compatible with the connected server".
//   cms skills list [--json]
//   cms skills show <id> [--json]
//   cms skills check <id> [--json]
// Community packages (Community Skills plan §4):
//   cms skills validate <file>          dry-run the fail-closed package gate
//   cms skills install <file> [--url <source>]
//   cms skills uninstall <id> [--dir <root>]
//   cms skills disable <id> | enable <id>
// Local operations run against the community root (config
// skills.communityDir → $PCMS_CONFIG_FILE → ./skills-community); the same
// operations exist over REST for remote operators.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSION_REGISTRY } from "@pcms/auth";
import { loadConfig } from "@pcms/core";
import {
  evaluateSkillCompatibility,
  installSkillPackage,
  loadCommunitySkills,
  loadInstalledSkills,
  SkillInstallError,
  validateSkillPackage,
} from "@pcms/skills";
import { apiCall, humanResult, machineResult, resolveApiClient } from "../api-client.js";
import {
  type CliCommandResult,
  configLoadOptions,
  failureResult,
  type GlobalOptions,
} from "../framework.js";

export interface SkillsInvocation {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}

function skillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  // 1) explicit override; 2) the release layout, derived from THIS file
  // (…/packages/cli/src/commands → up 4 → <release>/skills) so the command
  // works from ANY cwd on an install — the p-cms.ru site agent got "root
  // недоступен" running from a foreign directory (2026-10-06); 3) cwd (dev).
  const fromEnv = env["PCMS_SKILLS_DIR"];
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);
  const fromModule = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../skills");
  if (existsSync(fromModule)) return fromModule;
  return resolve(process.cwd(), "skills");
}

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv) {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

interface BootstrapContracts {
  contracts?: Record<string, string>;
  actor?: { permissions?: readonly string[] };
}

export async function skillsCommand(invocation: SkillsInvocation): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const [subcommand, operand] = args;
  const loaded = loadInstalledSkills(skillsRoot(env));

  if (subcommand === undefined || subcommand === "list") {
    const items = loaded.skills.map(({ manifest }) => ({
      id: manifest.id,
      version: manifest.version,
      description: manifest.description,
    }));
    if (options.json === true) return machineResult({ items, problems: loaded.problems });
    const lines = items.map((item) => `${item.id}@${item.version} — ${item.description}`);
    if (loaded.problems.length > 0) {
      lines.push(
        `PROBLEMS: ${loaded.problems.map((problem) => `${problem.directory}: ${problem.error}`).join("; ")}`,
      );
    }
    return humanResult(lines.length > 0 ? lines : ["no skills installed"]);
  }

  if (subcommand === "show") {
    const found = loaded.skills.find(({ manifest }) => manifest.id === operand);
    if (found === undefined) {
      return { exitCode: 4, stdout: "", stderr: `skill not installed: ${operand ?? ""}\n` };
    }
    return options.json === true
      ? machineResult(found.manifest)
      : humanResult([
          `${found.manifest.id}@${found.manifest.version}`,
          found.manifest.description,
          `requires: ${JSON.stringify(found.manifest.requires)}`,
          `recommended scopes: ${found.manifest.recommended_scopes.join(", ")}`,
          `dangerous optional scopes: ${found.manifest.dangerous_optional_scopes.join(", ") || "(none)"}`,
          `safety levels: ${found.manifest.safety_levels.join(", ")}`,
        ]);
  }

  if (subcommand === "doc") {
    // Self-discovery (owner 2026-10-06): the installed package carries its
    // own instructions (SKILL.md + references/). Without this the agent
    // could see metadata but never the actual knowledge — the reason a
    // fresh agent burned five attempts on the update flow.
    const found = loaded.skills.find(({ manifest }) => manifest.id === operand);
    if (found === undefined) {
      return { exitCode: 4, stdout: "", stderr: `skill not installed: ${operand ?? ""}\n` };
    }
    const file = args[2] ?? "SKILL.md";
    const safe = file.replaceAll("\\", "/").replace(/^\.?\//, "");
    if (safe.includes("..") || !/^[A-Za-z0-9._/-]+\.(md|txt)$/.test(safe)) {
      return { exitCode: 3, stdout: "", stderr: `invalid doc file: ${file}\n` };
    }
    const path = resolve(found.directory, safe);
    if (!path.startsWith(resolve(found.directory) + "/")) {
      return { exitCode: 3, stdout: "", stderr: `invalid doc file: ${file}\n` };
    }
    try {
      const text = readFileSync(path, "utf8");
      return options.json === true
        ? machineResult({ id: found.manifest.id, file: safe, content: text })
        : { exitCode: 0, stdout: text, stderr: "" };
    } catch {
      return {
        exitCode: 4,
        stdout: "",
        stderr: `doc not found: ${safe} (available: SKILL.md, references/…)\n`,
      };
    }
  }

  if (subcommand === "check") {
    const found = loaded.skills.find(({ manifest }) => manifest.id === operand);
    if (found === undefined) {
      return { exitCode: 4, stdout: "", stderr: `skill not installed: ${operand ?? ""}\n` };
    }
    const response = await apiCall(clientOrThrow(options, env), "GET", "/agent/bootstrap");
    if (!response.ok) return response.result;
    const body = response.body as BootstrapContracts;
    const evaluation = evaluateSkillCompatibility(found.manifest, {
      contractVersions: body.contracts ?? {},
      capabilities: body.actor?.permissions ?? [],
    });
    if (options.json === true) {
      return machineResult({ id: found.manifest.id, ...evaluation });
    }
    return humanResult([
      `${found.manifest.id}@${found.manifest.version}: ${evaluation.result.toUpperCase()}`,
      ...evaluation.issues.map((issue) => `- [${issue.code}] ${issue.message}`),
    ]);
  }

  const dirFlag = args.indexOf("--dir");
  let communityDir = dirFlag < 0 ? env["PCMS_COMMUNITY_SKILLS_DIR"] : args[dirFlag + 1];
  if (dirFlag >= 0 && (communityDir === undefined || communityDir.startsWith("--"))) {
    return failureResult(
      Object.assign(new Error("--dir requires a directory"), { code: "CLI_USAGE_INVALID" }),
      options,
    );
  }
  if (communityDir === undefined) {
    try {
      communityDir = loadConfig(configLoadOptions(options, env, process.cwd())).skills
        ?.communityDir;
    } catch (error) {
      // A dev checkout may have no CMS config; an explicit config must never be ignored.
      if (
        options.config !== undefined ||
        options.profile !== undefined ||
        env["PCMS_CONFIG_FILE"] !== undefined ||
        (error as { code?: string }).code !== "CONFIG_NOT_FOUND"
      ) {
        return failureResult(error, options);
      }
    }
  }
  communityDir ??= resolve(process.cwd(), "skills-community");

  if (subcommand === "validate" || subcommand === "install") {
    const file = operand;
    if (file === undefined || !existsSync(file)) {
      return { exitCode: 3, stdout: "", stderr: `package not found: ${file ?? ""}\n` };
    }
    const bytes = readFileSync(file);
    const checks = {
      firstPartyIds: loadInstalledSkills(skillsRoot(env)).skills.map(({ manifest }) => manifest.id),
      isRegisteredPermission: (scope: string) =>
        PERMISSION_REGISTRY.some((definition: { key: string }) => definition.key === scope),
    };
    try {
      if (subcommand === "validate") {
        const { id } = await validateSkillPackage(bytes, checks);
        return options.json === true
          ? machineResult({ id, ok: true })
          : humanResult([`${id}: package is valid`]);
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const result = await installSkillPackage(bytes, {
        communityDir,
        firstPartyIds: checks.firstPartyIds,
        isRegisteredPermission: checks.isRegisteredPermission,
        ...(args.includes("--source") ? { source: args[args.indexOf("--source") + 1] } : {}),
      });
      return options.json === true
        ? machineResult({ id: result.skill.manifest.id, sha256, installed: true })
        : humanResult([
            `installed ${result.skill.manifest.id}@${result.skill.manifest.version}`,
            `sha256: ${sha256}`,
          ]);
    } catch (error) {
      if (error instanceof SkillInstallError) {
        return {
          ...machineResult({ ok: false, code: error.code, message: error.message }),
          exitCode: 3,
        };
      }
      throw error;
    }
  }

  if (subcommand === "uninstall" || subcommand === "disable" || subcommand === "enable") {
    const id = operand ?? "";
    const found = loadCommunitySkills(communityDir).skills.find(
      (skill) => skill.manifest.id === id,
    );
    if (found === undefined) {
      return { exitCode: 4, stdout: "", stderr: `community skill not installed: ${id}\n` };
    }
    if (subcommand === "uninstall") {
      rmSync(found.directory, { recursive: true, force: true });
      return options.json === true
        ? machineResult({ id, uninstalled: true })
        : humanResult([`uninstalled ${id}`]);
    }
    const marker = resolve(found.directory, ".pcms-disabled");
    if (subcommand === "disable") writeFileSync(marker, "disabled by operator\n");
    else if (existsSync(marker)) rmSync(marker);
    return options.json === true
      ? machineResult({ id, disabled: subcommand === "disable" })
      : humanResult([`${id}: ${subcommand === "disable" ? "disabled" : "enabled"}`]);
  }

  return {
    exitCode: 2,
    stdout: "",
    stderr:
      "usage: cms skills list [--json] | show <id> [--json] | doc <id> [file] | check <id> [--json] | validate <file> | install <file> [--source <url>] | uninstall <id> [--dir <root>] | disable <id> | enable <id> [--json]\n  doc: print the skill instructions (SKILL.md, or a references/<file>) — the installed package is self-sufficient knowledge\n",
  };
}
