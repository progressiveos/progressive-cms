/** Operator configuration, not an extension self-declaration. */
export function parseExtensionPaymentGrants(
  value: string | undefined,
): Readonly<Record<string, readonly string[]>> {
  if (value === undefined || value === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PCMS_EXTENSION_PAYMENT_GRANTS must be a JSON object");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("PCMS_EXTENSION_PAYMENT_GRANTS must be a JSON object");
  const result: Record<string, readonly string[]> = Object.create(null);
  for (const [id, types] of Object.entries(parsed)) {
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(id) ||
      !Array.isArray(types) ||
      types.some(
        (type: unknown) => typeof type !== "string" || !/^[a-z][a-z0-9.-]{0,199}$/.test(type),
      )
    ) {
      throw new Error(
        "PCMS_EXTENSION_PAYMENT_GRANTS contains an invalid extension or subject type",
      );
    }
    result[id] = [...new Set(types as string[])];
  }
  return result;
}
