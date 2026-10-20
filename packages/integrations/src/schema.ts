// Bounded JSON-schema subset validation for connector config / action
// payloads (Integrations spec §6/§16: declarative allowlisted shapes, no
// arbitrary code). Deliberately NOT a full JSON Schema engine — only the
// keywords connector contracts use: type, properties, required,
// additionalProperties:false, enum, minLength/maxLength, minimum/maximum,
// items, format:"uri", format:"identifier".
export type SchemaIssues = readonly string[];

export function validateAgainstSchema(
  schema: Record<string, unknown> | undefined,
  value: unknown,
  path = "$",
): SchemaIssues {
  if (schema === undefined) return [];
  const issues: string[] = [];
  collectIssues(schema, value, path, issues, 0);
  return issues;
}

const MAX_DEPTH = 8;

function collectIssues(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: string[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    issues.push(`${path}: schema nesting exceeds ${MAX_DEPTH} levels`);
    return;
  }
  const type = schema["type"];
  if (typeof type === "string" && !matchesType(type, value)) {
    issues.push(`${path}: expected ${type}`);
    return;
  }
  const enumerated = schema["enum"];
  if (Array.isArray(enumerated) && !enumerated.some((option) => option === value)) {
    issues.push(`${path}: must be one of ${enumerated.map((o) => JSON.stringify(o)).join(", ")}`);
    return;
  }
  if (typeof value === "string") {
    const minLength = schema["minLength"];
    if (typeof minLength === "number" && value.length < minLength) {
      issues.push(`${path}: shorter than ${minLength} characters`);
    }
    const maxLength = schema["maxLength"];
    if (typeof maxLength === "number" && value.length > maxLength) {
      issues.push(`${path}: longer than ${maxLength} characters`);
    }
    const format = schema["format"];
    if (format === "uri" && !isHttpUri(value)) {
      issues.push(`${path}: must be an absolute http(s) URL`);
    }
    if (format === "identifier" && !/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
      issues.push(`${path}: must match [a-z0-9][a-z0-9._-]*`);
    }
  }
  if (typeof value === "number") {
    const minimum = schema["minimum"];
    if (typeof minimum === "number" && value < minimum) {
      issues.push(`${path}: below minimum ${minimum}`);
    }
    const maximum = schema["maximum"];
    if (typeof maximum === "number" && value > maximum) {
      issues.push(`${path}: above maximum ${maximum}`);
    }
  }
  if (type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
    for (const key of required) {
      if (record[key] === undefined) issues.push(`${path}/${key}: required`);
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(record)) {
        if (properties[key] === undefined) issues.push(`${path}/${key}: unknown property`);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties[key];
      if (childSchema !== undefined)
        collectIssues(childSchema, child, `${path}/${key}`, issues, depth + 1);
    }
  }
  if (type === "array" && Array.isArray(value)) {
    const maxItems = schema["maxItems"];
    if (typeof maxItems === "number" && value.length > maxItems) {
      issues.push(`${path}: more than ${maxItems} items`);
    }
    const items = schema["items"] as Record<string, unknown> | undefined;
    if (items !== undefined) {
      for (const [index, item] of value.entries()) {
        collectIssues(items, item, `${path}/${index}`, issues, depth + 1);
      }
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isHttpUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
