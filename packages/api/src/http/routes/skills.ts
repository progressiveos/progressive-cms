// Community skills REST surface (Community Skills plan §4). Management is
// `skills.manage` (operator domain); the sample package download is
// authenticated-only (it is a harmless skeleton, and it must work from the
// Admin session without token juggling).
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSION_REGISTRY, recordSecurityEvent } from "@pcms/auth";
import {
  installSkillPackage,
  loadCommunitySkills,
  loadInstalledSkills,
  SkillInstallError,
  validateSkillPackage,
} from "@pcms/skills";
import yazl from "yazl";
import {
  type ApplicationServices,
  type OperationContext,
  requirePermission,
} from "../../context.js";
import { ApiError } from "../../errors.js";
import type { ApiRoute } from "../registry.js";

const SAMPLE_MANIFEST = {
  id: "community.example-template",
  version: "1.0.0",
  description:
    "Skeleton community skill: rename the id, describe the workflow, keep the manifest honest.",
  requires: { cms: ">=1.0.0-rc.1 <2.0.0" },
  recommended_scopes: ["content.read"],
  optional_scopes: [],
  dangerous_optional_scopes: [],
  entry_workflow: [
    "bootstrap/discovery (cms agent bootstrap --json)",
    "read the task; do only what the operator asked",
    "emit the structured run report (agent-run-report-v1)",
  ],
  safety_levels: ["READ"],
  references: ["references/how-to-write.md"],
  attribution: { author: "Your name <contact>", source: "https://example.com/skill" },
};

const SAMPLE_SKILL = `# Skill: community.example-template

Skeleton to fork: thin entry (routing table), heavy topics in references/,
manifest carries only what you actually require. See
skills/references/INDEX.md for the house routing pattern.
`;

const SAMPLE_REFERENCE = `# How to write a community skill

1. Keep SKILL.md a thin router; put depth in references/.
2. Declare only scopes the workflow really needs — the operator sees them
   at install time, and scopes still come from the agent's token.
3. Never instruct agents to exfiltrate secrets or bypass validation;
   installed community skills are wrapped in a distrust banner.
`;

async function sampleZip(): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(`${JSON.stringify(SAMPLE_MANIFEST, null, 2)}\n`, "utf8"),
    "manifest.json",
  );
  zip.addBuffer(Buffer.from(SAMPLE_SKILL, "utf8"), "SKILL.md");
  zip.addBuffer(Buffer.from(SAMPLE_REFERENCE, "utf8"), "references/how-to-write.md");
  zip.end();
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

function communityContext(app: ApplicationServices): {
  readonly dir: string;
  readonly enabled: boolean;
} {
  return { dir: app.communitySkillsDir, enabled: app.communitySkillsEnabled };
}

function firstPartyIds(app: ApplicationServices): string[] {
  return loadInstalledSkills(app.skillsDir).skills.map(({ manifest }) => manifest.id);
}

async function installFromBytes(
  app: ApplicationServices,
  ctx: OperationContext,
  bytes: Buffer,
  source?: string,
): Promise<unknown> {
  requirePermission(app, ctx, "skills.manage");
  if (!app.communitySkillsEnabled) {
    throw new ApiError(
      "SKILLS_COMMUNITY_DISABLED",
      "community skills are disabled: set skills.communityEnabled=true in the config",
      { status: 409 },
    );
  }
  try {
    const result = await installSkillPackage(bytes, {
      communityDir: app.communitySkillsDir,
      firstPartyIds: firstPartyIds(app),
      isRegisteredPermission: (scope) =>
        PERMISSION_REGISTRY.some((definition) => definition.key === scope),
      ...(source === undefined ? {} : { source }),
    });
    await recordSecurityEvent(app.pool, null, {
      type: "SKILL_INSTALLED",
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      transport: ctx.transport === "rest" ? "api" : ctx.transport,
      metadata: {
        id: result.skill.manifest.id,
        sha256: result.sha256,
        ...(source === undefined ? {} : { source }),
      },
    });
    return {
      id: result.skill.manifest.id,
      version: result.skill.manifest.version,
      sha256: result.sha256,
      disabled: result.skill.disabled,
    };
  } catch (error) {
    if (error instanceof SkillInstallError) {
      throw new ApiError(error.code, error.message, { status: 422 });
    }
    throw error;
  }
}

function findCommunity(app: ApplicationServices, id: string) {
  const found = loadCommunitySkills(app.communitySkillsDir).skills.find(
    (skill) => skill.manifest.id === id,
  );
  if (found === undefined) {
    throw new ApiError("SKILL_NOT_FOUND", `community skill "${id}" is not installed`, {
      status: 404,
    });
  }
  return found;
}

function requireManage(app: ApplicationServices, ctx: OperationContext): void {
  requirePermission(app, ctx, "skills.manage");
}

export function makeSkillsRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "GET",
        url: "/skills",
        operationId: "list_skills",
        summary:
          "Installed skills across both roots with origin/trust/enabled (community management needs skills.manage)",
        tag: "discovery",
        auth: "authenticated",
      },
      async handle(app, ctx) {
        const firstParty = loadInstalledSkills(app.skillsDir).skills.map(({ manifest }) => ({
          id: manifest.id,
          version: manifest.version,
          origin: "first-party",
          enabled: true,
          attribution: null,
        }));
        const community = app.communitySkillsEnabled
          ? loadCommunitySkills(app.communitySkillsDir).skills.map((skill) => ({
              id: skill.manifest.id,
              version: skill.manifest.version,
              origin: "community",
              enabled: !skill.disabled,
              attribution: skill.manifest.attribution ?? null,
            }))
          : [];
        const isManager = ctx.actor.permissions.has("skills.manage");
        return {
          status: 200,
          body: {
            items: [...firstParty, ...community],
            community_enabled: app.communitySkillsEnabled,
            can_manage: isManager,
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/skills/sample.zip",
        operationId: "download_skill_sample",
        summary: "Skeleton .pcskill package to fork into a community skill",
        tag: "discovery",
        auth: "authenticated",
      },
      async handle() {
        const zip = await sampleZip();
        return {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="community-skill-template.zip"',
          },
          body: zip,
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/skills/install",
        operationId: "install_skill",
        summary:
          "Install a .pcskill package (skills.manage; community skills must be enabled). Body: JSON {url} to fetch, or the raw package as application/octet-stream (the agent authoring path)",
        tag: "discovery",
        auth: "authenticated",
        permission: "skills.manage",
        csrf: true,
        bodyLimit: 2 * 1024 * 1024 + 64 * 1024,
      },
      async handle(app, ctx, request) {
        const raw = request.body;
        if (Buffer.isBuffer(raw)) {
          const bodyResult = (await installFromBytes(app, ctx, raw)) as Record<string, unknown>;
          return { status: 201, body: bodyResult };
        }
        const body = (raw ?? {}) as { url?: unknown };
        const url = typeof body.url === "string" ? body.url : "";
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new ApiError(
            "API_REQUEST_INVALID",
            "body must be {url} JSON or the raw package as application/octet-stream",
            { status: 400 },
          );
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new ApiError("API_REQUEST_INVALID", "only http(s) package URLs are allowed", {
            status: 400,
          });
        }
        const response = await fetch(parsed, { redirect: "follow" });
        if (!response.ok) {
          throw new ApiError(
            "SKILL_PACKAGE_UNREACHABLE",
            `package download HTTP ${response.status}`,
            {
              status: 422,
            },
          );
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > 2 * 1024 * 1024) {
          throw new ApiError("SKILL_PACKAGE_INVALID", "package over the 2 MiB cap", {
            status: 422,
          });
        }
        const bodyResult = (await installFromBytes(app, ctx, bytes, parsed.toString())) as Record<
          string,
          unknown
        >;
        return { status: 201, body: bodyResult };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/skills/:id/disable",
        operationId: "disable_skill",
        summary: "Hide a community skill from agents without uninstalling (skills.manage)",
        tag: "discovery",
        auth: "authenticated",
        permission: "skills.manage",
        csrf: true,
      },
      async handle(app, ctx, request) {
        requireManage(app, ctx);
        const params = request.params as { id: string };
        const skill = findCommunity(app, params.id);
        writeFileSync(join(skill.directory, ".pcms-disabled"), "disabled by operator\n");
        await recordSecurityEvent(app.pool, null, {
          type: "SKILL_DISABLED",
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          transport: ctx.transport === "rest" ? "api" : ctx.transport,
          metadata: { id: params.id },
        });
        return { status: 200, body: { id: params.id, disabled: true } };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/skills/:id/enable",
        operationId: "enable_skill",
        summary: "Re-enable a disabled community skill (skills.manage)",
        tag: "discovery",
        auth: "authenticated",
        permission: "skills.manage",
        csrf: true,
      },
      async handle(app, ctx, request) {
        requireManage(app, ctx);
        const params = request.params as { id: string };
        const skill = findCommunity(app, params.id);
        const marker = join(skill.directory, ".pcms-disabled");
        if (existsSync(marker)) rmSync(marker);
        await recordSecurityEvent(app.pool, null, {
          type: "SKILL_ENABLED",
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          transport: ctx.transport === "rest" ? "api" : ctx.transport,
          metadata: { id: params.id },
        });
        return { status: 200, body: { id: params.id, disabled: false } };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/skills/:id",
        operationId: "uninstall_skill",
        summary: "Uninstall a community skill (skills.manage)",
        tag: "discovery",
        auth: "authenticated",
        permission: "skills.manage",
        csrf: true,
      },
      async handle(app, ctx, request) {
        requireManage(app, ctx);
        const params = request.params as { id: string };
        if (!params.id.startsWith("community.")) {
          throw new ApiError("SKILL_ID_FORBIDDEN", "only community skills can be uninstalled", {
            status: 403,
          });
        }
        const skill = findCommunity(app, params.id);
        const sha256 = skill.install.sha256 ?? null;
        rmSync(skill.directory, { recursive: true, force: true });
        await recordSecurityEvent(app.pool, null, {
          type: "SKILL_UNINSTALLED",
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          transport: ctx.transport === "rest" ? "api" : ctx.transport,
          metadata: { id: params.id, ...(sha256 === null ? {} : { sha256 }) },
        });
        return { status: 200, body: { id: params.id, uninstalled: true } };
      },
    },
  ];
}
