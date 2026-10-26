// cms theme export | upload | validate-package (CORE-THEME-REMOTE-PACKAGE-CYCLE).
//
// The agent-side half of the remote theme cycle: download the package of the
// theme the server actually serves, edit it locally, upload the result and
// validate it before applying. No SSH, no server filesystem access, no path
// API — the unit of exchange is one .pcTheme ZIP.
import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { apiBinary, apiCall, humanResult, machineResult, resolveApiClient } from "../api-client.js";
import { failureResult, type GlobalOptions } from "../framework.js";

function parseFlags(args: readonly string[]): {
  readonly positional: string[];
  readonly output?: string;
  readonly expectedGeneration?: number;
} {
  const positional: string[] = [];
  let output: string | undefined;
  let expectedGeneration: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg === "--json") continue;
    if (arg === "--output") {
      output = args[index + 1];
      index += 1;
    } else if (arg === "--expected-generation") {
      const raw = args[index + 1];
      if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw Object.assign(new Error("--expected-generation needs a nonnegative integer"), {
          code: "CLI_ARGUMENT_INVALID",
        });
      }
      expectedGeneration = Number(raw);
      index += 1;
    } else if (arg.startsWith("--")) {
      throw Object.assign(new Error(`unknown argument "${arg}"`), {
        code: "CLI_ARGUMENT_INVALID",
      });
    } else {
      positional.push(arg);
    }
  }
  return {
    positional,
    ...(output === undefined ? {} : { output }),
    ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
  };
}

interface ThemeSourceDescriptor {
  readonly theme_id: string;
  readonly served_version: string;
  readonly installed_head_version: string | null;
  readonly revision_id: string | null;
  readonly theme_generation: number;
  readonly package_sha256: string;
  readonly size_bytes: number;
  readonly download_path: string;
}

export async function themePackageCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}) {
  const { args, options, env } = invocation;
  const subcommand = args[0];
  try {
    const flags = parseFlags(args.slice(1));
    const client = resolveApiClient(options, env);
    if (typeof client === "string") {
      throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
    }
    if (subcommand === "export") {
      if (flags.output === undefined || flags.positional.length !== 0) {
        throw Object.assign(new Error("usage: cms theme export --output <file.pcTheme> [--json]"), {
          code: "CLI_ARGUMENT_INVALID",
        });
      }
      const source = await apiCall(client, "GET", "/themes/source");
      if (!source.ok) return source.result;
      const descriptor = source.body as ThemeSourceDescriptor;
      const download = await apiBinary(
        client,
        `/themes/source/package?expected_generation=${descriptor.theme_generation}`,
      );
      if (!download.ok) return download.result;
      const digest = createHash("sha256").update(download.bytes).digest("hex");
      if (digest !== descriptor.package_sha256) {
        throw Object.assign(
          new Error(
            `downloaded package digest ${digest} does not match the descriptor ${descriptor.package_sha256}`,
          ),
          { code: "THEME_PACKAGE_CORRUPT" },
        );
      }
      // Atomic local write: a partial download never leaves a usable file.
      const target = resolve(flags.output);
      const temporary = `${target}.partial`;
      try {
        writeFileSync(temporary, download.bytes, { mode: 0o600 });
        renameSync(temporary, target);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      const result = {
        ok: true,
        output: target,
        ...descriptor,
        verified_sha256: digest,
      };
      if (options.json) return machineResult(result);
      return humanResult([
        `exported ${descriptor.theme_id} ${descriptor.served_version} (generation ${descriptor.theme_generation})`,
        `installed head: ${descriptor.installed_head_version ?? "(not installed)"}`,
        `file: ${target} (${descriptor.size_bytes} bytes)`,
        `sha256: ${digest}`,
        "edit locally, bump the version above the installed head, then: cms theme upload <file>",
      ]);
    }
    if (subcommand === "upload") {
      const file = flags.positional[0];
      if (file === undefined || flags.positional.length !== 1) {
        throw Object.assign(new Error("usage: cms theme upload <file.pcTheme> [--json]"), {
          code: "CLI_ARGUMENT_INVALID",
        });
      }
      const bytes = readFileSync(resolve(file));
      const response = await apiCall(client, "POST", "/themes/packages", bytes);
      if (!response.ok) return response.result;
      const body = response.body as { package_ref: string; sha256: string; expires_at: string };
      if (options.json) return machineResult({ ok: true, ...body });
      return humanResult([
        `uploaded package_ref ${body.package_ref}`,
        `sha256: ${body.sha256}`,
        `expires: ${body.expires_at}`,
        `next: cms theme validate-package ${body.package_ref}`,
      ]);
    }
    if (subcommand === "validate-package") {
      const ref = flags.positional[0];
      if (ref === undefined || flags.positional.length !== 1) {
        throw Object.assign(new Error("usage: cms theme validate-package <package-ref> [--json]"), {
          code: "CLI_ARGUMENT_INVALID",
        });
      }
      const response = await apiCall(
        client,
        "POST",
        `/themes/packages/${encodeURIComponent(ref)}/validate`,
      );
      if (!response.ok) return response.result;
      const body = response.body as {
        theme: { id: string; version: string };
        render_stack: string;
        package_sha256: string;
      };
      if (options.json) return machineResult({ ok: true, ...body });
      return humanResult([
        `valid: ${body.theme.id} ${body.theme.version}`,
        `render stack: ${body.render_stack}`,
        `sha256: ${body.package_sha256}`,
        "the active theme is unchanged",
      ]);
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: `unknown theme package subcommand: ${subcommand ?? "(none)"} (use export|upload|validate-package)\n`,
    };
  } catch (error) {
    return failureResult(error, options);
  }
}
