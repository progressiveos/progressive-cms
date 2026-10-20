// SEO audit uses the same authorized validator as Admin and MCP.
import { apiCall, collectPages, machineResult, resolveApiClient } from "../api-client.js";
import { type CliCommandResult, failureResult, type GlobalOptions } from "../framework.js";

export async function seoCommand(invocation: {
  args: readonly string[];
  options: GlobalOptions;
  env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const usage = {
    exitCode: 2,
    stdout: "",
    stderr: "usage: cms seo validate <id> | --entry <id> | --all [--json]\n",
  };
  const words = args.slice(1);
  const all = words.length === 1 && words[0] === "--all";
  const entry =
    words.length === 1 && !words[0]?.startsWith("--")
      ? words[0]
      : words.length === 2 && words[0] === "--entry" && !words[1]?.startsWith("--")
        ? words[1]
        : undefined;
  if (args[0] !== "validate" || (!all && !entry)) return usage;
  try {
    const resolved = resolveApiClient(options, env);
    if (typeof resolved === "string")
      throw Object.assign(new Error(resolved), { code: "API_CLIENT_UNCONFIGURED" });
    const client = { ...resolved, json: true };
    if (entry) {
      const response = await apiCall(
        client,
        "GET",
        `/discovery/seo/validate?entry_id=${encodeURIComponent(entry)}`,
      );
      if (!response.ok) return response.result;
      const report = response.body as { issues: { severity: string }[] };
      return machineResult(
        report,
        report.issues.some((issue) => issue.severity === "error") ? 3 : 0,
      );
    }
    const catalog = await collectPages((limit, cursor) => {
      const query = new URLSearchParams({ limit: String(limit), include_archived: "false" });
      if (cursor !== null) query.set("cursor", cursor);
      return apiCall(client, "GET", `/discovery/content/tree?${query}`);
    }, Infinity);
    const issues: Record<string, unknown>[] = [];
    const failures: Record<string, unknown>[] = [];
    let exitCode = 0;
    if (!catalog.ok) {
      failures.push({ stage: "catalog", ...JSON.parse(catalog.result.stdout).error });
      exitCode = catalog.result.exitCode;
    }
    let processed = 0;
    let checked = 0;
    let skipped = 0;
    for (const item of catalog.items) {
      if (item["kind"] === "folder") {
        skipped++;
        continue;
      }
      const id = String(item["entry_id"]);
      processed++;
      const response = await apiCall(
        client,
        "GET",
        `/discovery/seo/validate?entry_id=${encodeURIComponent(id)}`,
      );
      if (!response.ok) {
        failures.push({ entry_id: id, ...JSON.parse(response.result.stdout).error });
        exitCode ||= response.result.exitCode;
        continue;
      }
      checked++;
      const report = response.body as { issues: Record<string, unknown>[] };
      issues.push(...report.issues.map((issue) => ({ entry_id: id, ...issue })));
    }
    const counts = { error: 0, warning: 0, recommendation: 0 };
    for (const issue of issues) {
      const severity = issue["severity"] as keyof typeof counts;
      counts[severity]++;
    }
    const complete = catalog.ok && failures.length === 0;
    return machineResult(
      {
        ok: complete && counts.error === 0,
        complete,
        partial: !complete,
        catalog_complete: catalog.ok,
        processed,
        checked,
        skipped,
        counts,
        issues,
        failures,
        next_cursor: catalog.next_cursor,
      },
      exitCode || (counts.error > 0 ? 3 : 0),
    );
  } catch (error) {
    return failureResult(error, options);
  }
}
