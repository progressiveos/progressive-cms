import { apiCall, humanResult, machineResult, resolveApiClient } from "../api-client.js";
import { failureResult, type GlobalOptions, requireTargetSafety } from "../framework.js";

export async function themeCleanupCommand(invocation: {
  args: readonly string[];
  options: GlobalOptions;
  env: NodeJS.ProcessEnv;
}) {
  const { args, options, env } = invocation;
  try {
    let apply = false;
    let dryRun = false;
    let keepLast = 5;
    let days = 1;
    for (let i = 1; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--apply") apply = true;
      else if (flag === "--dry-run") dryRun = true;
      else if (
        (flag === "--keep-last" || flag === "--older-than-days") &&
        /^\d+$/.test(args[i + 1] ?? "")
      ) {
        const value = Number(args[++i]);
        if (flag === "--keep-last") keepLast = value;
        else days = value;
      } else
        throw Object.assign(new Error("unknown flag or missing value"), {
          code: "CLI_USAGE_INVALID",
        });
    }
    if ((apply && dryRun) || keepLast < 5 || keepLast > 100 || days < 1 || days > 36500)
      throw Object.assign(new Error("invalid cleanup policy"), { code: "CLI_USAGE_INVALID" });
    if (apply) {
      const refusal = requireTargetSafety(options, "cms theme cleanup --apply");
      if (refusal) return refusal;
    }
    const client = resolveApiClient(options, env);
    if (typeof client === "string")
      return failureResult(
        Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" }),
        options,
      );
    const path = "/themes/revisions/cleanup";
    let response = await apiCall(client, "POST", path, {
      dry_run: true,
      keep_last: keepLast,
      older_than_days: days,
    });
    if (!response.ok) return response.result;
    const preview = response.body as {
      theme_generation: number;
      candidates: { revision_id: string }[];
    };
    if (apply && preview.candidates.length) {
      response = await apiCall(client, "POST", path, {
        dry_run: false,
        keep_last: keepLast,
        older_than_days: days,
        expected_generation: preview.theme_generation,
        revision_ids: preview.candidates.map((r) => r.revision_id),
      });
      if (!response.ok) return response.result;
    }
    const result = response.body as {
      ok: boolean;
      candidates: unknown[];
      removed: string[];
      pending: string[];
      has_more: boolean;
    };
    const output = options.json
      ? machineResult(result)
      : humanResult([
          apply
            ? `theme snapshots removed: ${result.removed.length}; pending retry: ${result.pending.length}`
            : `eligible theme snapshots: ${result.candidates.length} (preview only)`,
          ...(result.has_more ? ["more snapshots remain; repeat cleanup for the next batch"] : []),
        ]);
    return { ...output, exitCode: result.ok ? 0 : 7 };
  } catch (error) {
    return failureResult(error, options);
  }
}
