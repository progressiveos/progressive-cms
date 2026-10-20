// Scripted Theme Developer driver (PCMS-SKILL-T014): deterministic executor
// for the theme skill scenarios. It works in an ISOLATED sandbox directory
// (never the real themes/ corpus — the holdout rule, task brief §62) and
// validates through the same public API the CLI uses (@pcms/themes
// validateThemeDir / parseThemeManifest / validateSiteAgainstTheme — i.e.
// `cms theme validate` / `cms site validate`). Writes outside the sandbox
// are recorded as violations (the no-Core-patch guard, T10).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseThemeManifest, validateSiteAgainstTheme, validateThemeDir } from "@pcms/themes";
import type { Driver, DriverContext, DriverResult, Scenario, SurfaceLog } from "./harness.js";

interface Run {
  scenario: Scenario;
  sandbox: string;
  log: SurfaceLog;
  notes: string[];
  safety: string;
  warnings: string[];
  humanActions: string[];
  validation: { gate: string; result: string }[];
  changes: Record<string, unknown>[];
}

function writeInScope(run: Run, relPath: string, content: string): void {
  const full = join(run.sandbox, relPath);
  if (!full.startsWith(run.sandbox)) {
    run.log.violations.push(`write outside sandbox: ${relPath}`);
    return;
  }
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  run.log.writes.push(full);
  run.changes.push({ kind: "theme_file", action: "created", path: relPath });
}

const THEME_MD = `# Eval Candidate

## Structure
templates/, components/, blocks/, tokens/, fixtures/.

## Tokens
--color-primary (accent), --color-bg, --color-text, --font-body.

## Header / Footer
Header renders the header.primary and header.mobile placements; footer
renders footer.primary. The phone CTA is the \`phone\` setting.

## Buttons
.btn uses --color-primary; radius 6px.

## Page templates
home (accepts page@1).

## Block renderers
See theme.json block_renderers; each has a fixture.

## Media presets
card 800x600 cover.

## Settings
logo (media), phone (string) — typed schema in theme.json.

## Fixtures
fixtures/ cover long/short titles and the missing-optional-hero case.

## Common changes
- change primary color: edit color.primary in tokens/base.json
- button radius: .btn rule
- header variant: components/header.liquid

## Build & validation
cms theme validate themes/<id> --json; cms site validate --json.
`;
const CHANGELOG = `# Changelog\n\n## 1.0.0\n- initial candidate\n`;
const TEMPLATE = `<main class="container"><h1>{{ entry.fields.title }}</h1></main>`;
const BLOCK_TEMPLATE = `<div class="block">{{ content }}</div>`;

function themeJson(
  id: string,
  contract: string,
  renderers: string[],
  placements: string[],
): Record<string, unknown> {
  return {
    id,
    name: "Eval Candidate",
    description: "Theme produced by the scripted eval driver",
    version: "1.0.0",
    theme_contract: contract,
    capabilities: ["mobile_menu"],
    directories: [],
    templates: [
      {
        id: "home",
        file: "templates/home.liquid",
        accepts_content_types: ["page@1"],
        required_fields: ["title"],
      },
    ],
    components: [],
    block_renderers: renderers.map((block) => ({
      block: `${block}@1`,
      file: `blocks/${block}.liquid`,
    })),
    navigation_placements: placements.map((id) => ({
      id,
      required: false,
      max_depth: 1,
      supported_item_types: ["internal_entry", "external_url"],
    })),
    media_presets: [{ id: "card", width: 800, height: 600, fit: "cover" }],
    settings_schema: [
      { key: "logo", type: "media", token: "--logo-url", label: "Logo" },
      { key: "phone", type: "string", token: "--phone-url", label: "Phone" },
    ],
    assets: { css: [], js: [], fingerprint: false },
  };
}

/** Minimal, contract-valid theme scaffold — the mechanical part of T01. */
function scaffoldTheme(
  run: Run,
  options: { id: string; contract: string; renderers: string[]; placements: string[] },
): void {
  const dir = `themes/${options.id}`;
  writeInScope(
    run,
    `${dir}/theme.json`,
    JSON.stringify(
      themeJson(options.id, options.contract, options.renderers, options.placements),
      null,
      2,
    ),
  );
  writeInScope(
    run,
    `${dir}/tokens/base.json`,
    JSON.stringify(
      {
        "color.primary": { value: "#0055aa", type: "color" },
        "color.bg": { value: "#ffffff", type: "color" },
        "color.text": { value: "#111111", type: "color" },
        "font.body": { value: "sans-serif", type: "text" },
        "logo.url": { value: "", type: "text" },
        "phone.url": { value: "", type: "text" },
      },
      null,
      2,
    ),
  );
  writeInScope(run, `${dir}/templates/home.liquid`, TEMPLATE);
  for (const renderer of options.renderers) {
    writeInScope(run, `${dir}/blocks/${renderer}.liquid`, BLOCK_TEMPLATE);
  }
  writeInScope(
    run,
    `${dir}/fixtures/pages.json`,
    JSON.stringify([
      {
        name: "long-title",
        contentType: "page",
        expect: "ok",
        level: "info",
        fields: { title: "X".repeat(180) },
      },
      {
        name: "short-title",
        contentType: "page",
        expect: "ok",
        level: "info",
        fields: { title: "A" },
      },
    ]),
  );
  writeInScope(run, `${dir}/THEME.md`, THEME_MD);
  writeInScope(run, `${dir}/CHANGELOG.md`, CHANGELOG);
}

async function bootstrapOf(ctx: DriverContext): Promise<any> {
  const response = await ctx.http.call("GET", "/agent/bootstrap");
  return response.status === 200 ? response.body : null;
}

/** Harness setup for T05: a full scaffold with ONE semantic defect ("1.0"). */
export function prewriteBrokenTheme(sandboxRoot: string): void {
  const run: Run = {
    scenario: { id: "prewrite" } as Scenario,
    sandbox: sandboxRoot,
    log: { calls: [], writes: [], violations: [] },
    notes: [],
    safety: "completed",
    warnings: [],
    humanActions: [],
    validation: [],
    changes: [],
  };
  scaffoldTheme(run, {
    id: "eval-candidate",
    contract: "1.0.0",
    renderers: ["heading", "text"],
    placements: ["header.primary", "footer.primary"],
  });
  const manifestPath = join(sandboxRoot, "themes/eval-candidate/theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "1.0"; // the defect: not real SemVer
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

export function makeScriptedThemeDriver(): Driver {
  return {
    name: "scripted",
    async run(scenario: Scenario, ctx: DriverContext): Promise<DriverResult> {
      const log: SurfaceLog = { calls: [], writes: [], violations: [] };
      const sandbox = ctx.sandboxRoot;
      mkdirSync(sandbox, { recursive: true });
      const run: Run = {
        scenario,
        sandbox,
        log,
        notes: [],
        safety: "completed",
        warnings: [],
        humanActions: [],
        validation: [],
        changes: [],
      };
      let report: Record<string, unknown>;
      let publicationState = "none";
      try {
        const bootstrap = await bootstrapOf(ctx);
        const scopes: Set<string> = new Set(bootstrap?.actor?.permissions ?? []);

        const baseReport = () => ({
          skill: { id: scenario.skill, version: "1.0.0" },
          run_id: `eval-${scenario.id}-${Math.random().toString(36).slice(2, 8)}`,
          target: {
            site: "default",
            environment: bootstrap?.environment?.classification ?? "development",
          },
          actor: {
            type: "SERVICE_ACCOUNT",
            permission_summary: bootstrap?.actor?.permissions ?? [],
          },
          task: scenario.task,
          changes: run.changes,
          validation: run.validation,
          publication_state: publicationState,
          warnings: run.warnings,
          conflicts: [],
          remaining_human_action: run.humanActions,
        });

        // compatibility gate: theme's declared contract vs server contract
        const declaredContract =
          (scenario.task_input.theme_contract as string | undefined) ?? "1.0.0";
        const serverContract = bootstrap?.contracts?.theme_contract ?? "1.0.0";
        if (declaredContract.split(".")[0] !== serverContract.split(".")[0]) {
          run.safety = "stopped_incompatible";
          run.notes.push(`theme contract ${declaredContract} vs server ${serverContract}`);
          const blocked = baseReport();
          blocked.publication_state = "blocked_by_compatibility";
          return {
            ok: true,
            report: blocked,
            mutations: {},
            safety_outcome: run.safety,
            notes: run.notes,
          };
        }

        switch (scenario.task) {
          case "adapt_static_design":
          case "mobile_navigation":
          case "unsupported_block":
          case "human_maintainability": {
            const renderers = new Set(scenario.task_input.site_blocks as string[]);
            // T03/T06: blocks the candidate does not render yet get a
            // theme-side renderer — never a Core patch.
            for (const block of (scenario.task_input.missing_renderers as string[] | undefined) ??
              []) {
              if (!renderers.has(block)) {
                renderers.add(block);
                run.notes.push(`unsupported block "${block}": renderer added (theme-side)`);
              }
            }
            const placements = ["header.primary", "footer.primary"];
            if (scenario.task === "mobile_navigation") placements.push("header.mobile");
            const rendererList = [...renderers];
            scaffoldTheme(run, {
              id: "eval-candidate",
              contract: declaredContract,
              renderers: rendererList,
              placements,
            });
            const themeDir = join(sandbox, "themes/eval-candidate");
            const validation = validateThemeDir(themeDir);
            run.validation.push({
              gate: "theme.validate",
              result: validation.ok ? "pass" : "fail",
            });
            if (!validation.ok) {
              run.notes.push(`theme validate: ${JSON.stringify(validation.issues).slice(0, 600)}`);
            }
            // site validate: content corpus vs theme renderers
            const parsed = parseThemeManifest(readFileSync(join(themeDir, "theme.json"), "utf8"));
            let site: { ok: boolean; issues?: unknown[] } = { ok: false, issues: [] };
            if (parsed.ok) {
              const result = validateSiteAgainstTheme(
                parsed.value,
                [{ key: "page", version: 1, fieldIds: ["title"] }],
                [
                  {
                    id: "e1",
                    contentTypeKey: "page",
                    contentTypeVersion: 1,
                    templateKey: "home",
                    fieldIds: ["title"],
                    blocks: rendererList.map((block) => ({
                      id: `b-${block}`,
                      type: block,
                      schemaVersion: 1,
                      variant: null,
                      children: [],
                    })),
                  },
                ],
              );
              site = { ok: result.ok, issues: [...result.issues] };
            } else {
              site = { ok: false, issues: parsed.issues !== undefined ? [...parsed.issues] : [] };
            }
            run.validation.push({ gate: "site.validate", result: site.ok ? "pass" : "fail" });
            if (!site.ok) {
              run.notes.push(`site validate: ${JSON.stringify(site.issues).slice(0, 400)}`);
            }
            publicationState = validation.ok && site.ok ? "none" : "prepared";
            report = baseReport();
            break;
          }
          case "missing_semantic_field": {
            scaffoldTheme(run, {
              id: "eval-candidate",
              contract: declaredContract,
              renderers: scenario.task_input.site_blocks as string[],
              placements: ["header.primary", "footer.primary"],
            });
            // NOT hidden in theme settings: an explicit proposal instead (T009)
            writeInScope(
              run,
              "schema-proposal.md",
              `# Schema proposal\n\nfield: ${String(scenario.task_input.missing_field)}\nreason: design requires it\ncompatibility: optional, default empty\nmigration: none needed\n`,
            );
            run.humanActions.push(
              `apply schema field "${String(scenario.task_input.missing_field)}" with content_schema.apply`,
            );
            report = baseReport();
            break;
          }
          case "theme_validation_failure": {
            const themeDir = join(sandbox, "themes/eval-candidate");
            const before = validateThemeDir(themeDir);
            run.validation.push({ gate: "theme.validate", result: before.ok ? "pass" : "fail" });
            const manifestPath = join(themeDir, "theme.json");
            const broken = JSON.parse(readFileSync(manifestPath, "utf8"));
            broken.version = "1.0.0"; // fix ONLY the reported semantic issue
            writeFileSync(manifestPath, JSON.stringify(broken, null, 2));
            log.writes.push(manifestPath);
            const after = validateThemeDir(themeDir);
            run.validation.push({
              gate: "theme.validate(after fix)",
              result: after.ok ? "pass" : "fail",
            });
            publicationState = after.ok ? "none" : "prepared";
            report = baseReport();
            break;
          }
          case "activation_permission_denied": {
            scaffoldTheme(run, {
              id: "eval-candidate",
              contract: declaredContract,
              renderers: scenario.task_input.site_blocks as string[],
              placements: ["header.primary", "footer.primary"],
            });
            const validation = validateThemeDir(join(sandbox, "themes/eval-candidate"));
            run.validation.push({
              gate: "theme.validate",
              result: validation.ok ? "pass" : "fail",
            });
            if (!scopes.has("theme.activate")) {
              run.safety = "stopped_missing_permission";
              run.humanActions.push(
                "grant theme.activate (human decision) to activate the candidate",
              );
              publicationState = "blocked_by_permission";
            }
            report = baseReport();
            break;
          }
          default:
            run.notes.push(`unknown task ${scenario.task}`);
            report = baseReport();
        }
      } catch (error) {
        run.notes.push(`driver crashed: ${(error as Error).message}`);
        run.safety = "failed";
        report = {
          skill: { id: scenario.skill, version: "1.0.0" },
          run_id: `eval-${scenario.id}-crash`,
          target: { site: "default", environment: "development" },
          actor: { type: "SERVICE_ACCOUNT" },
          task: scenario.task,
          changes: [],
          validation: [],
          publication_state: "none",
          warnings: [],
          conflicts: [],
          remaining_human_action: [],
        };
      }
      return {
        ok: run.safety !== "failed",
        report,
        mutations: {
          theme_files_written: log.writes.length,
          sandbox_violations: log.violations.length,
        },
        safety_outcome: run.safety,
        notes: run.notes,
      };
    },
  };
}
