// Readable lead representation (PCMS→HQ, owner refinement): the submission's
// title, labeled questions and answers — built ONCE at lead creation from the
// fixed answers of that submission/run, stored immutably on the lead, and
// shipped by the connector as HQ initial_message. Rules pinned here:
//   - service fields are excluded (hidden_controlled, consent);
//   - per-answer and total length limits are explicit, deterministic and
//     marked with a visible truncation marker — never a silent crop;
//   - empty answers are skipped, answered questions keep definition order.

const PRESENTATION_LIMIT = 20_000;
const VALUE_LIMIT = 1000;
const TRUNCATED_SUFFIX = "…[truncated]";
const PRESENTATION_TRUNCATION_MARKER = "\n…[presentation truncated at 20000 characters]";

export interface PresentationEntry {
  readonly label: string;
  readonly value: unknown;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) {
    return value
      .map((item) => formatValue(item))
      .filter((text) => text !== "")
      .join(", ");
  }
  return "";
}

function boundedValue(value: string): string {
  return value.length > VALUE_LIMIT ? `${value.slice(0, VALUE_LIMIT)}${TRUNCATED_SUFFIX}` : value;
}

export function renderLeadPresentation(input: {
  readonly title: string;
  readonly entries: readonly PresentationEntry[];
}): string {
  const lines: string[] = [input.title];
  for (const entry of input.entries) {
    const value = boundedValue(formatValue(entry.value));
    if (value === "") continue;
    lines.push(`${entry.label}: ${value}`);
  }
  const rendered = lines.join("\n");
  if (rendered.length <= PRESENTATION_LIMIT) return rendered;
  const cut = rendered.slice(0, PRESENTATION_LIMIT - PRESENTATION_TRUNCATION_MARKER.length);
  return `${cut}${PRESENTATION_TRUNCATION_MARKER}`;
}
