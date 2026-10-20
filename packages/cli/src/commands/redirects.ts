// `cms redirects validate|apply` — legacy-URL redirect import over the REST
// surface (Navigation spec §33/§60). Input is a CSV with a header row:
//   source,target,status_code,reason
// (status_code defaults to 301; 410 rows leave target empty). validate is a
// pure dry-run report; apply validates and applies atomically and requires
// --yes. Exit codes: 0 ok/applied, 1 report has errors or API failure, 2/3
// usage/input.
import { readFileSync } from "node:fs";
import { type ApiClientOptions, apiCall, machineResult, resolveApiClient } from "../api-client.js";
import { type CliCommandResult, failureResult, type GlobalOptions } from "../framework.js";

const USAGE = `usage: cms redirects <subcommand> [options]
  validate --csv <file> [--site <key>]   dry-run: per-row report + graph issues
  apply    --csv <file> [--site <key>] --yes
                                         atomic import (any error aborts the batch)

CSV header: source,target,status_code,reason (status_code default 301;
410 rows carry no target).`;

/** Minimal RFC-4180-ish CSV reader: quoted fields, doubled quotes, CRLF. */
export function parseRedirectCsv(text: string): {
  rows: { source: string; target: string | null; status_code?: number; reason?: string }[];
  warnings: string[];
} {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      field = "";
      if (record.length > 1 || (record[0] ?? "").trim() !== "") records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  record.push(field);
  if (record.length > 1 || (record[0] ?? "").trim() !== "") records.push(record);

  const warnings: string[] = [];
  const [header, ...dataRows] = records;
  if (header === undefined) throw new Error("CSV is empty (expected a header row)");
  const names = header.map((name) => name.trim().toLowerCase());
  const sourceAt = names.indexOf("source");
  const targetAt = names.indexOf("target");
  const statusAt = names.indexOf("status_code");
  const reasonAt = names.indexOf("reason");
  if (sourceAt < 0 || targetAt < 0) {
    throw new Error(`CSV header must contain at least "source" and "target" columns`);
  }
  const rows = dataRows.map((cells, line) => {
    const source = (cells[sourceAt] ?? "").trim();
    if (source === "") warnings.push(`line ${line + 2}: empty source skipped`);
    const rawTarget = (cells[targetAt] ?? "").trim();
    const rawStatus = statusAt >= 0 ? (cells[statusAt] ?? "").trim() : "";
    const status = rawStatus === "" ? 301 : Number(rawStatus);
    const reason = reasonAt >= 0 ? (cells[reasonAt] ?? "").trim() : "";
    return {
      source,
      target: rawTarget === "" ? null : rawTarget,
      ...(Number.isInteger(status) ? { status_code: status } : {}),
      ...(reason === "" ? {} : { reason }),
    };
  });
  return { rows: rows.filter((row) => row.source !== ""), warnings };
}

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv): ApiClientOptions {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

export async function redirectsCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  try {
    if (args[0] !== "validate" && args[0] !== "apply") {
      return { exitCode: 2, stdout: "", stderr: USAGE };
    }
    let csvPath: string | undefined;
    let site: string | undefined = options.site ?? env["PCMS_SITE_KEY"];
    let yes = options.yes;
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--csv") csvPath = args[index + 1];
      else if (arg === "--site") site = args[index + 1];
      else if (arg === "--yes") yes = true;
    }
    if (csvPath === undefined || csvPath === "") {
      return { exitCode: 3, stdout: "", stderr: "redirects requires --csv <file>\n" };
    }
    if (args[0] === "apply" && !yes) {
      return {
        exitCode: 3,
        stdout: "",
        stderr: "redirects apply requires --yes (the batch is applied atomically)\n",
      };
    }
    let csv: string;
    try {
      csv = readFileSync(csvPath, "utf8");
    } catch (error) {
      return {
        exitCode: 3,
        stdout: "",
        stderr: `cannot read CSV "${csvPath}": ${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
    const { rows, warnings } = parseRedirectCsv(csv);
    if (rows.length === 0) {
      return { exitCode: 3, stdout: "", stderr: "CSV produced no import rows\n" };
    }
    const client = clientOrThrow(options, env);
    const response = await apiCall(
      client,
      "POST",
      args[0] === "validate"
        ? "/routing/redirect-imports/validate"
        : "/routing/redirect-imports/apply",
      { ...(site === undefined ? {} : { site }), rows },
    );
    if (!response.ok) return response.result;
    const result = machineResult(response.body);
    const body = response.body as { report?: { ok?: boolean } };
    // A report with row/graph errors is a "no" answer, not a transport
    // failure: exit 1 so scripts can branch, payload still printed.
    if (body.report?.ok === false && result.exitCode === 0) {
      return { exitCode: 1, stdout: result.stdout, stderr: "" };
    }
    if (warnings.length > 0) {
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: `${warnings.join("\n")}\n`,
      };
    }
    return result;
  } catch (error) {
    return failureResult(error, options);
  }
}
