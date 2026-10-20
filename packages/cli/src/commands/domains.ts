// Domains CLI family (owner 2026-10-06 audit): REST /site/domains had no CLI
// wrapper — site agents on CLI-only deployments could not switch the primary
// domain (the /privacy sitemap case). Thin clients over the same endpoints
// the Admin uses.
//
//   cms domains list [--site <key>]
//   cms domains add --hostname <h> [--site <key>] [--primary] [--locale <l>]
//        [--scheme https|http] [--redirect redirect|serve]
//   cms domains primary --hostname <h> [--site <key>]
//   cms domains remove --hostname <h> [--site <key>]
import { type ApiClientOptions, apiCall, machineResult, resolveApiClient } from "../api-client.js";
import type { CliCommandResult, GlobalOptions } from "../framework.js";

const USAGE = `usage: cms domains <subcommand> [--json]
  list [--site <key>]
  add --hostname <h> [--site <key>] [--primary] [--locale <l>]
      [--scheme https|http] [--redirect redirect|serve]
  primary --hostname <h> [--site <key>]     atomic canonical-primary switch
  remove --hostname <h> [--site <key>]      last binding is undeletable
`;

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv): ApiClientOptions {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function domainsCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const subcommand = args[0];
  try {
    if (
      subcommand !== "list" &&
      subcommand !== "add" &&
      subcommand !== "primary" &&
      subcommand !== "remove"
    ) {
      return { exitCode: 2, stdout: "", stderr: USAGE };
    }
    const client = clientOrThrow(options, env);
    const site = options.site ?? env["PCMS_SITE_KEY"];
    const siteQuery = site === undefined ? "" : `?site=${encodeURIComponent(site)}`;
    const hostname = optionValue(args, "--hostname") ?? "";

    if (subcommand === "list") {
      const response = await apiCall(client, "GET", `/site/domains${siteQuery}`);
      if (!response.ok) return response.result;
      return machineResult(response.body);
    }

    if (subcommand === "add") {
      if (hostname === "") {
        return { exitCode: 3, stdout: "", stderr: "--hostname is required\n" };
      }
      const body: Record<string, unknown> = { hostname };
      if (args.includes("--primary")) body.is_primary = true;
      const locale = optionValue(args, "--locale");
      if (locale !== undefined) body.locale = locale;
      const scheme = optionValue(args, "--scheme");
      if (scheme !== undefined) body.scheme_policy = scheme;
      const redirect = optionValue(args, "--redirect");
      if (redirect !== undefined) body.canonical_redirect_policy = redirect;
      const response = await apiCall(client, "POST", `/site/domains${siteQuery}`, body);
      if (!response.ok) return response.result;
      return machineResult(response.body);
    }

    if (subcommand === "primary") {
      if (hostname === undefined || hostname === "") {
        return { exitCode: 3, stdout: "", stderr: "--hostname is required\n" };
      }
      const response = await apiCall(
        client,
        "PATCH",
        `/site/domains/${encodeURIComponent(hostname)}${siteQuery}`,
        { is_primary: true },
      );
      if (!response.ok) return response.result;
      return machineResult(response.body);
    }

    // remove
    if (hostname === undefined || hostname === "") {
      return { exitCode: 3, stdout: "", stderr: "--hostname is required\n" };
    }
    const response = await apiCall(
      client,
      "DELETE",
      `/site/domains/${encodeURIComponent(hostname)}${siteQuery}`,
    );
    if (!response.ok) return response.result;
    return machineResult(response.body);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}
