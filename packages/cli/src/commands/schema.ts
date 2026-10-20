// cms schema list/show/validate (PCMS-CONT-T027, P1; Content spec §73).
// Schema diagnostics against a definitions file: deterministic machine-
// readable output, reusable with the reference corpus (T025).
import { readFileSync } from "node:fs";
import {
  type ContentTypeDefinition,
  createContentDiscovery,
  createContentTypeRegistry,
  validateContentPayload,
} from "@pcms/content";
import type { CliResult } from "../main.js";

interface SchemaCommandOptions {
  readonly args: readonly string[];
}

interface DefinitionsFile {
  contentTypes: ContentTypeDefinition[];
}

function parseArgs(args: readonly string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--json") {
      parsed.json = true;
    } else if (
      arg === "--file" ||
      arg === "--payload" ||
      arg === "--level" ||
      arg === "--version"
    ) {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`option ${arg} requires a value`);
      }
      parsed[arg.slice(2)] = value;
      index += 1;
    } else if (!arg.startsWith("-") && parsed.positional === undefined) {
      parsed.positional = arg;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return parsed;
}

function jsonResult(payload: unknown): CliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: "" };
}

export function schemaCommand(options: SchemaCommandOptions): CliResult {
  let parsed: Record<string, string | boolean>;
  try {
    // args[0] is the subcommand; flags/positional parsing starts after it.
    parsed = parseArgs(options.args.slice(1));
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  const file =
    typeof parsed.file === "string" ? parsed.file : "fixtures/content/reference-content-types.json";

  let definitions: DefinitionsFile;
  try {
    const parsedFile = JSON.parse(readFileSync(file, "utf8")) as unknown;
    // Both real-world shapes are accepted: the tooling wrapper
    // {contentTypes:[…]} and the bare deployment typesFile array.
    definitions = Array.isArray(parsedFile)
      ? ({ contentTypes: parsedFile } as DefinitionsFile)
      : (parsedFile as DefinitionsFile);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cannot read definitions file "${file}": ${(error as Error).message}\n`,
    };
  }
  const registry = createContentTypeRegistry();
  const registerIssues: string[] = [];
  for (const definition of definitions.contentTypes ?? []) {
    try {
      registry.registerContentType(definition);
    } catch (error) {
      registerIssues.push(
        `${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`,
      );
    }
  }
  const discovery = createContentDiscovery({
    contentTypes: registry,
    fields: { listFieldTypes: () => [] } as never,
  });
  const json = parsed.json === true;
  const positional = typeof parsed.positional === "string" ? parsed.positional : undefined;

  const subcommand = options.args[0];
  switch (subcommand) {
    case "list": {
      if (json) return jsonResult(discovery.listContentTypes());
      const lines = discovery
        .listContentTypes()
        .map(
          (entry) => `${entry.key}@${entry.version}  ${entry.title}  [body: ${entry.bodyPolicy}]`,
        );
      return { exitCode: 0, stdout: `${["content types:", ...lines, ""].join("\n")}`, stderr: "" };
    }
    case "show": {
      if (positional === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "usage: cms schema show <key> [--version N] [--file p] [--json]\n",
        };
      }
      const version = typeof parsed.version === "string" ? Number(parsed.version) : undefined;
      const descriptor =
        version === undefined || Number.isNaN(version)
          ? discovery.getLatestContentTypeSchema(positional)
          : discovery.getContentTypeSchema(positional, version);
      if (descriptor === null) {
        return { exitCode: 1, stdout: "", stderr: `content type "${positional}" not found\n` };
      }
      return json
        ? jsonResult(descriptor)
        : { exitCode: 0, stdout: `${JSON.stringify(descriptor, null, 2)}\n`, stderr: "" };
    }
    case "validate": {
      if (positional === undefined || typeof parsed.payload !== "string") {
        return {
          exitCode: 2,
          stdout: "",
          stderr:
            "usage: cms schema validate <key> --payload <path> [--level draft|publish] [--file p] [--json]\n",
        };
      }
      const version = typeof parsed.version === "string" ? Number(parsed.version) : undefined;
      const schema =
        version === undefined || Number.isNaN(version)
          ? registry.getLatestContentType(positional)
          : registry.getContentType(positional, version);
      if (schema === null) {
        return { exitCode: 1, stdout: "", stderr: `content type "${positional}" not found\n` };
      }
      let fields: unknown;
      try {
        fields = JSON.parse(readFileSync(parsed.payload, "utf8"));
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `cannot read payload: ${(error as Error).message}\n`,
        };
      }
      const level = parsed.level === "publish" ? "publish" : "draft";
      const result = validateContentPayload(schema, fields, level);
      const payload = {
        ok: result.ok,
        level,
        schema: `${schema.key}@${schema.version}`,
        errors: result.errors,
        warnings: result.warnings,
        ...(registerIssues.length > 0 ? { registrationIssues: registerIssues } : {}),
      };
      if (json) {
        return {
          exitCode: result.ok ? 0 : 1,
          stdout: `${JSON.stringify(payload, null, 2)}\n`,
          stderr: "",
        };
      }
      const lines = result.errors.map(
        (error) => `${error.severity} ${error.path} ${error.code}: ${error.message}`,
      );
      return {
        exitCode: result.ok ? 0 : 1,
        stdout: `${result.ok ? `valid ${schema.key}@${schema.version} (${level})` : `invalid (${level})`}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`,
        stderr: "",
      };
    }
    default:
      return {
        exitCode: 2,
        stdout: "",
        stderr:
          "usage: cms schema <list|show|validate> [args] [--file <definitions.json>] [--json]\n",
      };
  }
}
