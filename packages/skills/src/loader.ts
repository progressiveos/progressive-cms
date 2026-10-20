// Skill package discovery (task brief §15/§74): read installed skill
// packages from a skills/ root (repo checkout or release layout), parse each
// manifest.json. A broken manifest is reported, never silently skipped.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillManifest, type SkillManifestV1 } from "./manifest.js";

export interface InstalledSkill {
  readonly directory: string;
  readonly manifest: SkillManifestV1;
}

export interface CommunitySkill {
  readonly directory: string;
  readonly manifest: SkillManifestV1;
  /** Operator kill-switch marker (.pcms-disabled). */
  readonly disabled: boolean;
  /** Install sidecar (.pcms-install.json): origin/sha256/at install time. */
  readonly install: {
    readonly source?: string;
    readonly sha256?: string;
    readonly installedAt?: string;
  };
}

export interface LoadedSkills {
  readonly skills: readonly InstalledSkill[];
  readonly problems: readonly { readonly directory: string; readonly error: string }[];
}

export function loadInstalledSkills(skillsRoot: string): LoadedSkills {
  const skills: InstalledSkill[] = [];
  const problems: { directory: string; error: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Problem reports are surfaced by GET /agent/bootstrap and must stay
    // deployment-path-free; "." names the skills root itself.
    return { skills, problems: [{ directory: ".", error: "skills root is unreadable" }] };
  }
  for (const name of entries) {
    // Shared directories (references/, schemas/) are not skill packages —
    // a skill package is any directory that contains a manifest.json.
    if (!existsSync(join(skillsRoot, name, "manifest.json"))) continue;
    const directory = join(skillsRoot, name);
    let raw: string;
    try {
      raw = readFileSync(join(directory, "manifest.json"), "utf8");
    } catch {
      problems.push({ directory: name, error: "unreadable skill manifest" });
      continue;
    }
    try {
      const manifest = parseSkillManifest(JSON.parse(raw));
      skills.push({ directory, manifest });
    } catch (error) {
      // parseSkillManifest/JSON.parse messages are field-level: they never
      // embed filesystem paths.
      problems.push({
        directory: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { skills, problems };
}

/**
 * Community skills root (operator-installed .pcskill packages, default OFF
 * via config skills.communityEnabled). Distinct from the release skills/
 * root: same manifest contract, different trust class. Broken packages are
 * problems, never silent skips; the disable marker hides nothing from the
 * loader — visibility decisions belong to the bootstrap layer.
 */
export function loadCommunitySkills(communityRoot: string): {
  readonly skills: readonly CommunitySkill[];
  readonly problems: readonly { readonly directory: string; readonly error: string }[];
} {
  const skills: CommunitySkill[] = [];
  const problems: { directory: string; error: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(communityRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Absent root is the normal disabled/off state — not a problem.
    return { skills, problems };
  }
  for (const name of entries) {
    const directory = join(communityRoot, name);
    if (!existsSync(join(directory, "manifest.json"))) continue;
    let raw: string;
    try {
      raw = readFileSync(join(directory, "manifest.json"), "utf8");
    } catch {
      problems.push({ directory: name, error: "unreadable skill manifest" });
      continue;
    }
    try {
      const manifest = parseSkillManifest(JSON.parse(raw));
      let install: CommunitySkill["install"] = {};
      const sidecarPath = join(directory, ".pcms-install.json");
      if (existsSync(sidecarPath)) {
        try {
          install = JSON.parse(readFileSync(sidecarPath, "utf8")) as CommunitySkill["install"];
        } catch {
          problems.push({ directory: name, error: "unreadable .pcms-install.json sidecar" });
        }
      }
      skills.push({
        directory,
        manifest,
        disabled: existsSync(join(directory, ".pcms-disabled")),
        install,
      });
    } catch (error) {
      problems.push({
        directory: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { skills, problems };
}
