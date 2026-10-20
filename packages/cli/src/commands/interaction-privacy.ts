import { readFile } from "node:fs/promises";
import { apiCall, humanResult, machineResult, resolveApiClient } from "../api-client.js";
import { failureResult, type GlobalOptions, requireTargetSafety } from "../framework.js";

export async function interactionPrivacyCommand(invocation: {
  args: readonly string[];
  options: GlobalOptions;
  env: NodeJS.ProcessEnv;
}) {
  const { args, options, env } = invocation;
  try {
    const [command, operand, ...rest] = args;
    const usage = () =>
      Object.assign(
        new Error(
          "usage: cms interactions privacy-preview|privacy-apply <request.json> | privacy-get <case_id> | privacy-ack <case_id> <delivery_id> <decision.json>",
        ),
        { code: "CLI_USAGE_INVALID" },
      );
    if (!command || !operand) throw usage();
    if (command === "privacy-apply" || command === "privacy-ack") {
      const refusal = requireTargetSafety(options, `cms interactions ${command}`);
      if (refusal) return refusal;
    }
    const client = resolveApiClient(options, env);
    if (typeof client === "string")
      throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
    const base = "/interactions/privacy";
    let path: string;
    let body: unknown;
    if (command === "privacy-preview" || command === "privacy-apply") {
      if (rest.length) throw usage();
      path = `${base}/${command === "privacy-preview" ? "preview" : "apply"}`;
      body = JSON.parse(await readFile(operand, "utf8"));
    } else if (command === "privacy-get") {
      if (
        rest.length ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operand)
      )
        throw usage();
      path = `${base}/cases/${operand}`;
    } else if (command === "privacy-ack") {
      const [deliveryId, file] = rest;
      if (
        rest.length !== 2 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operand) ||
        !deliveryId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          deliveryId,
        ) ||
        !file
      )
        throw usage();
      path = `${base}/cases/${operand}/deliveries/${deliveryId}/acknowledge`;
      body = JSON.parse(await readFile(file, "utf8"));
    } else throw usage();
    const response = await apiCall(client, command === "privacy-get" ? "GET" : "POST", path, body);
    if (!response.ok) return response.result;
    return options.json
      ? machineResult(response.body as object)
      : humanResult([JSON.stringify(response.body, null, 2)]);
  } catch (error) {
    return failureResult(error, options);
  }
}
