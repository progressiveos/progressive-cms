export const MEDIA_VARIANT_FAILURES_SCHEMA: Record<string, unknown> = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["media_id", "preset", "error"],
    properties: {
      media_id: { type: "string" },
      preset: { type: "string" },
      error: { type: "string" },
    },
  },
};

export function mediaResponseSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [...required],
    properties: {
      ...properties,
      media_variant_failures: MEDIA_VARIANT_FAILURES_SCHEMA,
    },
  };
}
