// CLI dispatcher (PCMS-OPS-T002 minimal core; M09 grows the M09-generation
// command tree through packages/cli/src/framework.ts — PCMS-API-T022).

import { agentCommand } from "./commands/agent.js";
import { bundleCommand } from "./commands/bundle.js";
import { configValidate } from "./commands/config-validate.js";
import { contentCommand } from "./commands/content.js";
import { dbMigrate } from "./commands/db-migrate.js";
import { capabilitiesCommand, doctorCommand, infoCommand } from "./commands/diagnostics.js";
import { domainsCommand } from "./commands/domains.js";
import { entriesCommand } from "./commands/entries.js";
import { contractsCommand, deprecationsCommand, extensionsCommand } from "./commands/extensions.js";
import { figmaCommand } from "./commands/figma.js";
import { formsCommand } from "./commands/forms.js";
import { integrationsCommand } from "./commands/integrations.js";
import { mailCommand } from "./commands/mail.js";
import { maintenanceCommand } from "./commands/maintenance.js";
import { mediaCommand, publicationCommand } from "./commands/media-publication.js";
import { migrateCommand } from "./commands/migrate.js";
import { navCommand, routeCommand } from "./commands/nav-route.js";
import { observationsCommand } from "./commands/observations.js";
import { paymentsCommand } from "./commands/payments.js";
import { redirectsCommand } from "./commands/redirects.js";
import { registryCommand } from "./commands/registry.js";
import { researchCommand } from "./commands/research.js";
import { revisionsCommand } from "./commands/revisions.js";
import { schemaCommand } from "./commands/schema.js";
import { searchCommand } from "./commands/search.js";
import { seoCommand } from "./commands/seo.js";
import { siteValidate } from "./commands/site-validate.js";
import { skillsCommand } from "./commands/skills.js";
import { themeCleanupCommand } from "./commands/theme-cleanup.js";
import { themeManage } from "./commands/theme-manage.js";
import { themeUpdateCommand } from "./commands/theme-update.js";
import { themeValidate } from "./commands/theme-validate.js";
import { updateCommand } from "./commands/update.js";
import { sessionAdmin, tokenAdmin, userAdmin } from "./commands/user-admin.js";
import { parseGlobalOptions } from "./framework.js";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE = [
  "usage: cms <command> [args]",
  "API context: --site <site-key> --environment <env> (or PCMS_SITE_KEY/PCMS_ENVIRONMENT)",
  "",
  "Commands:",
  "  config validate [--json] [--config <path>]    validate the configuration file",
  "  extensions list|install|enable|disable|uninstall <id> [--check]  (M14)",
  "  contracts versions | deprecations list       contract discovery (M14)",
  "  update check|apply --manifest <file>         update preflight/orchestration (M14)",
  "  maintenance status|enable|disable            site maintenance mode (M15)",
  "  registry status|releases|apply --version <v>  registry releases + apply-update (needs PCMS_API_URL/TOKEN)",
  "  entries identity-locale <id> --locale <tag>   identity repair: move entry + working revisions to the locale (needs PCMS_API_URL/TOKEN)",
  "  revisions cleanup --entry <id>                delete all SEALED revisions except the published one (needs PCMS_API_URL/TOKEN)",
  "  domains list|add|primary|remove                domain bindings (needs PCMS_API_URL/TOKEN + domains.manage)",
  "  observations show|append --text <t>|clear [--config <p>]  agent observations file (rides the update report)",
  "  agent bootstrap [--json]                     agent discovery entry point (M16)",
  "  skills list|show <id>|check <id> [--json]    installed skill discovery + compatibility (M16)",
  "  db migrate [--check] [--json] [--config <p>]  apply pending migrations explicitly",
  "  schema list|show|validate [--file <defs>]     content schema diagnostics (M02)",
  "  theme validate <dir> [--json]                 theme contract validation (M03)",
  "  theme revisions [--json]                     retained confirmed theme revisions",
  "  theme rollback <revision-id> --expected-generation N --environment <env> --yes [--json]",
  "  theme active [--json]                         actual theme served by the running API",
  "  theme update-active <package> --environment <env> --yes [--json]",
  "  site validate [--theme <dir>] [--content <f>] [--json]",
  "",
  "Local operator recovery (M08; audited, no HTTP surface):",
  "  user create-owner|reset-password|disable|disable-mfa [--email <e>] ...",
  "  session revoke-all --email <e>              revoke all sessions of a user",
  "  token revoke --token-id <uuid>              revoke a service-account token",
  "",
  "M09 generation (spec §57 exit codes; --json deterministic output):",
  "  content schema list|show <key> | validate <file> | import <bundle>",
  "  media list [--limit N | --all] [--cursor C] | get|usage|archive <id> [--yes]",
  "  seo validate <id> | --entry <id> | --all    SEO audit (API)",
  "  entries route change <id> --to-path <path> [--reason <text>] [--yes]",
  "  publication calendar|changesets|preflight|apply|publish-now|cancel",
  "  publication plan preview|schedule <id> --request <json-file>",
  "    mutating publication commands require --environment <env> --yes and",
  "    run against the CMS API (PCMS_API_URL + PCMS_API_TOKEN)",
  "  integrations connectors|instances|bindings|deliveries|inbound",
  "    integrations delivery <id> | retry <id> | instance-test <id>  (M13)",
  "  payments providers|instances|capabilities|list|get|events|cancel|refund (M13)",
  "  search query|status|reindex                 search operations (M11);",
  "  research search|fetch|status                external Web research via XMLStock + safe fetch (ADR-0015);",
  "    research fetch --out <file.md> keeps stdout compact (agent token economy)",
  "  forms|quizzes list|get <id>                 definition discovery (M12);",
  "  interactions submissions|runs|leads|export   interaction history (M12);",
  "    reindex requires --environment <env> --yes",
  "  bundle validate|pack|inspect|submit|status <args>  .pcpub content packages",
  "  migrate modx3|wordpress|tilda|bitrix <options>    source-site migration",
  "  redirects validate|apply --csv <file> [--yes]     atomic legacy URL import",
  "  figma pull --url <design-url> [--out-dir <dir>]",
  "  nav inspect|check | route inspect|check [options]",
  "  mail test [--to <address>] [--json]               configured mail transport",
  "  theme list                                     offline installed package catalog",
  "  theme install|uninstall <arg>                   API; --environment <env> --yes",
  "  theme cleanup [--dry-run | --apply] [--keep-last N] [--older-than-days N]",
  "  doctor | info | capabilities                operator diagnostics",
  "  global flags: --json --profile <name> --config <path>",
  "  config file: --config wins; else $PCMS_CONFIG_FILE; else ./config/pcms.json",
  "    (server installs: export PCMS_CONFIG_FILE=/etc/progressive-cms/pcms.json)",
  "",
].join("\n");

export async function runCli(argv: readonly string[]): Promise<CliResult> {
  // M09 generation: global flags first, then the new command tree.
  const parsed = parseGlobalOptions(argv);
  if (parsed !== undefined) {
    const { options, rest: words } = parsed;
    const [command, subcommand, ...rest] = words;
    const invocation = {
      args: [subcommand ?? "", ...rest],
      options,
      env: process.env,
      cwd: process.cwd(),
    };
    if (command === "nav" || command === "route") {
      return (command === "nav" ? navCommand : routeCommand)({
        args: [
          subcommand ?? "",
          ...rest,
          ...(options.config === undefined
            ? options.profile === undefined
              ? []
              : ["--config", `pcms.${options.profile}.json`]
            : ["--config", options.config]),
          ...(options.site === undefined ? [] : ["--site", options.site]),
          ...(options.json ? ["--json"] : []),
        ],
        env: process.env,
        cwd: process.cwd(),
      });
    }
    if (command === "content") {
      const result = await contentCommand(invocation);
      return result;
    }
    if (command === "theme" && subcommand === "cleanup") return themeCleanupCommand(invocation);
    if (
      command === "theme" &&
      (subcommand === "install" ||
        subcommand === "uninstall" ||
        subcommand === "active" ||
        subcommand === "update-active" ||
        subcommand === "revisions" ||
        subcommand === "rollback")
    ) {
      return themeUpdateCommand(invocation);
    }
    if (command === "bundle") {
      return bundleCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
        cwd: process.cwd(),
      });
    }
    if (command === "media") {
      return mediaCommand({ ...invocation, args: [subcommand ?? "", ...rest] });
    }
    if (command === "publication") {
      return publicationCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "figma") {
      return figmaCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "migrate") {
      return migrateCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "redirects") {
      return redirectsCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "seo") return seoCommand(invocation);
    if (command === "search") {
      return searchCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "forms" || command === "quizzes" || command === "interactions") {
      // forms.ts keys on the family ("forms"|"quizzes"|"interactions") as the
      // first arg — pass it through, mirroring the legacy raw-args path.
      return formsCommand({
        args: [command, subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "integrations") {
      return integrationsCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "payments") {
      return paymentsCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "extensions") {
      return extensionsCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "observations") {
      return observationsCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "domains") {
      return domainsCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "revisions") {
      return revisionsCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "entries") {
      return entriesCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "registry") {
      return registryCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "maintenance") {
      return maintenanceCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "skills") {
      return skillsCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "agent") {
      return agentCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "mail") {
      return mailCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "research") {
      return researchCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "contracts") {
      return contractsCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "deprecations") {
      return deprecationsCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "update") {
      return updateCommand({
        args: [subcommand ?? "", ...rest],
        options,
        env: process.env,
      });
    }
    if (command === "doctor") {
      return doctorCommand(invocation);
    }
    if (command === "info") {
      return infoCommand(invocation);
    }
    if (command === "capabilities") {
      return capabilitiesCommand(invocation);
    }
    if (
      command !== undefined &&
      [
        "config",
        "db",
        "schema",
        "theme",
        "site",
        "nav",
        "route",
        "user",
        "session",
        "token",
      ].includes(command)
    ) {
      // Legacy families fall through to the M01 dispatcher below.
      return runLegacyCli(argv);
    }
    if (command === undefined) {
      return { exitCode: 2, stdout: "", stderr: `${USAGE}\n` };
    }
    return { exitCode: 2, stdout: "", stderr: `${USAGE}\n` };
  }
  return runLegacyCli(argv);
}

/** M01 dispatcher (PCMS-OPS-T002) — legacy families, pinned 0/1/2 codes. */
async function runLegacyCli(argv: readonly string[]): Promise<CliResult> {
  const [command, subcommand, ...rest] = argv;
  if (command === "config" && subcommand === "validate") {
    return configValidate({ args: rest });
  }
  if (command === "db" && subcommand === "migrate") {
    const result = await dbMigrate({ args: rest });
    return result;
  }
  if (command === "schema") {
    return schemaCommand({ args: [subcommand ?? "", ...rest] });
  }
  if (command === "theme" && subcommand === "validate") {
    return themeValidate({ args: rest });
  }
  if (command === "theme" && subcommand === "list") {
    return themeManage({ args: [subcommand, ...rest] });
  }
  if (command === "site" && subcommand === "validate") {
    const result = await siteValidate({ args: rest });
    return result;
  }
  if (command === "nav" || command === "route") {
    return (command === "nav" ? navCommand : routeCommand)({
      args: [subcommand ?? "", ...rest],
    });
  }

  // Local operator recovery commands (PCMS-AUTH-T026, Auth spec §62).
  if (command === "user") {
    return userAdmin({ args: [subcommand ?? "", ...rest] });
  }
  if (command === "session") {
    return sessionAdmin({ args: [subcommand ?? "", ...rest] });
  }
  if (command === "token") {
    return tokenAdmin({ args: [subcommand ?? "", ...rest] });
  }

  return { exitCode: 2, stdout: "", stderr: `${USAGE}\n` };
}
