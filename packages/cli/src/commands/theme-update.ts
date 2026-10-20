import { readFileSync } from "node:fs";
import { apiCall, humanResult, machineResult, resolveApiClient } from "../api-client.js";
import { failureResult, type GlobalOptions, requireTargetSafety } from "../framework.js";

export async function themeUpdateCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}) {
  const { args, options, env } = invocation;
  const [command, file, ...rest] = args;
  if (
    !["active", "update-active", "revisions", "rollback", "install", "uninstall"].includes(
      command ?? "",
    ) ||
    (command === "rollback"
      ? file === undefined ||
        rest.length !== 2 ||
        rest[0] !== "--expected-generation" ||
        !/^\d+$/.test(rest[1] ?? "") ||
        !Number.isSafeInteger(Number(rest[1]))
      : rest.length !== 0 ||
        (command === "active" || command === "revisions" ? file !== undefined : file === undefined))
  ) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "usage: cms theme active | revisions [--json] | install <package.pcTheme> | uninstall <theme-id> --environment <env> --yes [--json] | update-active <package.pcTheme> --environment <env> --yes [--json] | rollback <revision-id> --expected-generation N --environment <env> --yes [--json]\n",
    };
  }
  if (
    command === "update-active" ||
    command === "rollback" ||
    command === "install" ||
    command === "uninstall"
  ) {
    const refusal = requireTargetSafety(options, `cms theme ${command}`);
    if (refusal !== null) return refusal;
  }
  try {
    const client = resolveApiClient(options, env);
    if (typeof client === "string") {
      throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
    }
    const response =
      command === "active"
        ? await apiCall(client, "GET", "/themes/active")
        : command === "revisions"
          ? await apiCall(client, "GET", "/themes/revisions")
          : command === "rollback"
            ? await apiCall(client, "POST", "/themes/rollback", {
                revision_id: file,
                expected_generation: Number(rest[1]),
              })
            : command === "uninstall"
              ? await apiCall(
                  client,
                  "DELETE",
                  `/themes/installed/${encodeURIComponent(file ?? "")}`,
                )
              : await apiCall(
                  client,
                  "POST",
                  command === "install" ? "/themes/install" : "/themes/active/update",
                  readFileSync(file ?? ""),
                );
    if (!response.ok) return response.result;
    if (options.json) return machineResult({ ok: true, ...(response.body as object) });
    if (command === "install" || command === "uninstall") {
      return humanResult([JSON.stringify(response.body)]);
    }
    if (command === "revisions") {
      const body = response.body as {
        theme_generation: number;
        revisions: readonly {
          revision_id: string;
          theme_id: string;
          package_version: string;
          active: boolean;
        }[];
      };
      return humanResult([
        `theme generation ${body.theme_generation}`,
        ...body.revisions.map(
          (row) =>
            `${row.active ? "*" : " "} ${row.revision_id} ${row.theme_id} ${row.package_version}`,
        ),
      ]);
    }
    const actual =
      command === "rollback" ? (response.body as { served: unknown }).served : response.body;
    const body = actual as { id: string; version: string; cleanup_warning?: string };
    return humanResult([
      `serving theme ${body.id} ${body.version}`,
      ...(body.cleanup_warning === undefined ? [] : [`warning: ${body.cleanup_warning}`]),
    ]);
  } catch (error) {
    return failureResult(error, options);
  }
}
