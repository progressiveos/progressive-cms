// Payments CLI commands (PCMS-PAY-T008; Payments spec §43).
//   cms payments providers                 provider catalog
//   cms payments instances                 configured provider instances
//   cms payments capabilities <type>       capability report
//   cms payments list [status]             payments (reliability surface)
//   cms payments get <paymentId>           one payment
//   cms payments events <paymentId>        append-only timeline
//   cms payments cancel <paymentId>        cancel (payments.cancel)
//   cms payments refund <paymentId> [amt]  refund (payments.refund)
// All operations run against the CMS API (PCMS_API_URL + PCMS_API_TOKEN).

import { apiCall, machineResult, resolveApiClient } from "../api-client.js";
import { type CliCommandResult, failureResult, type GlobalOptions } from "../framework.js";

function clientOrThrow(options: GlobalOptions, env: NodeJS.ProcessEnv) {
  const client = resolveApiClient(options, env);
  if (typeof client === "string") {
    throw Object.assign(new Error(client), { code: "API_CLIENT_UNCONFIGURED" });
  }
  return client;
}

const USAGE = `usage: cms payments <subcommand> [--json]
  providers | instances | capabilities <type> | list [status]
  get <paymentId> | events <paymentId> | cancel <paymentId> | refund <paymentId> [amount]
`;

export async function paymentsCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  const [subcommand, operand, extra] = args;
  try {
    const client = clientOrThrow(options, env);
    const get = async (path: string) => {
      const response = await apiCall(client, "GET", path);
      if (!response.ok) return response.result;
      return machineResult(response.body);
    };
    switch (subcommand) {
      case "providers":
        return await get("/payments/providers");
      case "instances":
        return await get("/payments/providers/instances");
      case "capabilities":
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        return await get(`/payments/providers/${encodeURIComponent(operand)}/capabilities`);
      case "list":
        return await get(
          operand === undefined || operand === ""
            ? "/payments"
            : `/payments?status=${encodeURIComponent(operand)}`,
        );
      case "get":
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        return await get(`/payments/${operand}`);
      case "events":
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        return await get(`/payments/${operand}/events`);
      case "cancel": {
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        const response = await apiCall(client, "POST", `/payments/${operand}/cancel`);
        if (!response.ok) return response.result;
        return machineResult(response.body);
      }
      case "refund": {
        if (operand === undefined || operand === "") {
          return { exitCode: 2, stdout: "", stderr: USAGE };
        }
        const amount = extra === undefined ? undefined : Number(extra);
        if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
          throw Object.assign(new Error("refund amount must be a finite positive number"), {
            code: "PAYMENT_REQUEST_INVALID",
          });
        }
        const response = await apiCall(client, "POST", `/payments/${operand}/refund`, {
          ...(amount === undefined ? {} : { amount }),
        });
        if (!response.ok) return response.result;
        return machineResult(response.body);
      }
      default:
        return { exitCode: 2, stdout: "", stderr: USAGE };
    }
  } catch (error) {
    return failureResult(error, options);
  }
}
