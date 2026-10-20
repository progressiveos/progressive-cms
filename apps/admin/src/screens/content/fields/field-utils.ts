// Pure field helpers (PCMS-ADMIN-T002) — DOM-free so the node test suite can
// exercise them. The server-side validator remains the authority; these only
// shape values before they are sent.
import { getLocale } from "../../../i18n/locale.js";

/** RFC 9562 UUIDv7 matching the M02 StableId contract (`7` + [89ab] bits). */
export function stableId(now: number = Date.now()): string {
  const ts = now.toString(16).padStart(12, "0").slice(-12);
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const g3 = `7${rand.slice(0, 3)}`;
  const g4 = `${(((bytes[4] ?? 0) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${rand.slice(3, 5)}`;
  const g5 = rand.slice(5, 17);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-${g3}-${g4}-${g5}`;
}

/** Empty value matching the field type's wire shape (never `undefined`). */
export function emptyFieldValue(type: string): unknown {
  switch (type) {
    case "media_list":
    case "relation_list":
    case "list":
    case "repeater":
      return [];
    case "boolean":
      return false;
    case "money":
      return { amount: "", currency: "" };
    case "rich_text":
      // v2 is the only accepted version (CORE-RICHTEXT-V2-ONLY): a new value
      // must declare it immediately, or the first save would be rejected.
      return { schema_version: 2, type: "document", content: [] };
    case "block_document":
      return { schema_version: 1, blocks: [] };
    default:
      return "";
  }
}

/**
 * Presentation metadata for known v1 field ids (redesign spec §6.4, G-UI-1):
 * the schema wire carries no human labels, so the Admin composition keeps a
 * declarative, version-controlled {ru,en} layer. Unknown ids fall back to
 * humanize() of the raw key. RU is the deployment default; tests rely on it.
 */
interface PresentationLabel {
  readonly ru: string;
  readonly en: string;
  /** Repeater/array entity label ("Feature" for "Features"). */
  readonly item?: { readonly ru: string; readonly en: string };
}

const PRESENTATION: Readonly<Record<string, PresentationLabel>> = {
  title: { ru: "Заголовок", en: "Title" },
  menu_title: { ru: "Заголовок в меню", en: "Menu title" },
  h1: { ru: "Заголовок H1", en: "Heading H1" },
  slug_hint: { ru: "Подсказка для адреса", en: "Address hint" },
  intro: { ru: "Вступление", en: "Intro" },
  hero_image: { ru: "Главное изображение", en: "Hero image" },
  body: { ru: "Содержимое", en: "Body" },
  featured: { ru: "Показывать на витрине", en: "Featured" },
  price: { ru: "Цена", en: "Price" },
  features: { ru: "Преимущества", en: "Features", item: { ru: "Преимущество", en: "Feature" } },
  feature_title: { ru: "Заголовок", en: "Title" },
  feature_text: { ru: "Описание", en: "Description" },
  related_services: { ru: "Связанные услуги", en: "Related services" },
  client: { ru: "Клиент", en: "Client" },
  completed_on: { ru: "Дата завершения", en: "Completed on" },
  gallery: { ru: "Галерея", en: "Gallery" },
  published_at: { ru: "Дата публикации", en: "Publication date" },
  teaser: { ru: "Тизер", en: "Teaser" },
  author: { ru: "Автор", en: "Author" },
  tags: { ru: "Теги", en: "Tags" },
};

const SEMANTIC_LABELS: Readonly<Record<string, { ru: string; en: string }>> = {
  title: { ru: "Заголовок", en: "Title" },
  menu_title: { ru: "Заголовок в меню", en: "Menu title" },
  h1: { ru: "Заголовок H1", en: "Heading H1" },
  slug_hint: { ru: "Подсказка для адреса", en: "Address hint" },
  intro: { ru: "Вступление", en: "Intro" },
  hero_image: { ru: "Главное изображение", en: "Hero image" },
  body: { ru: "Содержимое", en: "Body" },
};

export function fieldLabel(fieldId: string): string {
  const presentation = PRESENTATION[fieldId];
  if (presentation === undefined) {
    const semantic = SEMANTIC_LABELS[fieldId];
    if (semantic === undefined) return humanize(fieldId);
    return getLocale() === "en" ? semantic.en : semantic.ru;
  }
  return getLocale() === "en" ? presentation.en : presentation.ru;
}

/** Repeater entity label: «Преимущество» (item) for «Преимущества» (field). */
export function repeaterItemLabel(fieldId: string): string | null {
  const item = PRESENTATION[fieldId]?.item;
  if (item === undefined) return null;
  return getLocale() === "en" ? item.en : item.ru;
}

function humanize(id: string): string {
  const words = id.split("_").filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) return id;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

const DATETIME_WIRE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Converts `datetime-local` input ("2026-09-20T14:30") into the wire format
 * `YYYY-MM-DDTHH:MM:SS±HH:MM` in the user's local offset. Values already in
 * wire shape pass through; anything else returns null (server re-validates).
 */
export function toDatetimeWire(value: string): string | null {
  if (DATETIME_WIRE_RE.test(value)) return value;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(value);
  if (match === null) return null;
  const [, date, time, seconds = "00"] = match;
  const probe = new Date(`${date}T${time}:00`);
  const offsetMinutes = -probe.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const offsetRest = String(absolute % 60).padStart(2, "0");
  return `${date}T${time}:${seconds}${sign}${offsetHours}:${offsetRest}`;
}

/** `datetime-local` value for editing an existing wire datetime. */
export function fromDatetimeWire(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}/.exec(value);
  return match?.[1] ?? value.slice(0, 16);
}

const DECIMAL_RE = /^-?(0|[1-9]\d{0,17})(\.\d{1,6})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Light money shaping; the exact decimal contract is enforced by the server. */
export function moneyIssues(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null) return ["Enter the amount and currency"];
  const money = value as { amount?: unknown; currency?: unknown };
  const issues: string[] = [];
  if (typeof money.amount !== "string" || money.amount.length === 0) {
    issues.push("Enter the amount");
  } else if (!DECIMAL_RE.test(money.amount)) {
    issues.push("Amount must be a canonical number, e.g. 125000.00");
  }
  if (typeof money.currency !== "string" || !CURRENCY_RE.test(money.currency)) {
    issues.push("Currency must be a three-letter latin code, e.g. RUB");
  }
  return issues;
}

export function integerIssues(
  value: unknown,
  schema: { min?: number; max?: number },
): readonly string[] {
  if (typeof value !== "string" || value === "") return [];
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return ["Enter an integer"];
  const issues: string[] = [];
  if (schema.min !== undefined && parsed < schema.min) issues.push(`Minimum ${schema.min}`);
  if (schema.max !== undefined && parsed > schema.max) issues.push(`Maximum ${schema.max}`);
  return issues;
}
