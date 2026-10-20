// Exact scalar serialization: money, decimal, integer, date, datetime, enum
// (PCMS-CONT-T008; Content spec §17/§18/§19/§20).
//
// Exactness rules: decimals/money are canonical decimal **strings** — IEEE
// floats never carry money or precise values (§17/§18). Dates are calendar
// dates without timezone, datetimes carry explicit timezone semantics, both
// ISO-8601 compatible (§19). Enum values are stable machine keys; a localized
// label is never a stored value (§20). Every validator is pure and returns
// JSON-pointer issues for the structured-validation pipeline.
import type { ReferenceIssue } from "./reference-fields.js";

export type { ReferenceIssue as ScalarIssue };

const DECIMAL_RE = /^-?(0|[1-9]\d{0,17})(\.\d{1,6})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function issue(code: string, path: string, message: string): ReferenceIssue {
  return { code, path, message };
}

export function decimalIssues(
  value: unknown,
  path: string,
  constraints?: { min?: string; max?: string; precision?: number; scale?: number },
): ReferenceIssue[] {
  if (typeof value === "number") {
    return [
      issue("DECIMAL_NOT_EXACT", path, "decimals are canonical strings; floats are not exact"),
    ];
  }
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
    return [
      issue(
        "DECIMAL_MALFORMED",
        path,
        'expected a canonical decimal string like "125000.00" (no exponent/comma/padding)',
      ),
    ];
  }
  const issues: ReferenceIssue[] = [];
  if (constraints !== undefined) {
    const [intPart, fracPart = ""] = value.replace("-", "").split(".");
    if (constraints.scale !== undefined && fracPart.length > constraints.scale) {
      issues.push(
        issue(
          "DECIMAL_SCALE_EXCEEDED",
          path,
          `at most ${constraints.scale} fractional digits allowed`,
        ),
      );
    }
    if (
      constraints.precision !== undefined &&
      intPart !== undefined &&
      intPart.length + fracPart.length > constraints.precision
    ) {
      issues.push(
        issue(
          "DECIMAL_PRECISION_EXCEEDED",
          path,
          `at most ${constraints.precision} significant digits allowed`,
        ),
      );
    }
    if (constraints.min !== undefined && compareDecimals(value, constraints.min) < 0) {
      issues.push(issue("DECIMAL_OUT_OF_RANGE", path, `value must be ≥ ${constraints.min}`));
    }
    if (constraints.max !== undefined && compareDecimals(value, constraints.max) > 0) {
      issues.push(issue("DECIMAL_OUT_OF_RANGE", path, `value must be ≤ ${constraints.max}`));
    }
  }
  return issues;
}

/** Exact string-decimal comparison without float involvement. */
function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  const parse = (text: string): { negative: boolean; units: bigint; scale: number } => {
    const negative = text.startsWith("-");
    const unsigned = negative ? text.slice(1) : text;
    const [intPart, fracPart = ""] = unsigned.split(".");
    return {
      negative,
      units: BigInt(`${intPart ?? "0"}${fracPart}`),
      scale: fracPart.length,
    };
  };
  const left = parse(a);
  const right = parse(b);
  const scale = Math.max(left.scale, right.scale);
  const normLeft = left.units * 10n ** BigInt(scale - left.scale) * (left.negative ? -1n : 1n);
  const normRight = right.units * 10n ** BigInt(scale - right.scale) * (right.negative ? -1n : 1n);
  if (normLeft < normRight) return -1;
  if (normLeft > normRight) return 1;
  return 0;
}

export function moneyIssues(value: unknown, path: string): ReferenceIssue[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [issue("TYPE_MISMATCH", path, 'money is {"amount": decimal string, "currency": "XXX"}')];
  }
  const issues: ReferenceIssue[] = [];
  const money = value as { amount?: unknown; currency?: unknown };
  if (!("amount" in money)) {
    issues.push(issue("MONEY_AMOUNT_REQUIRED", `${path}/amount`, "money amount is required"));
  } else {
    issues.push(
      ...decimalIssues(money.amount, `${path}/amount`).map((item) =>
        item.code === "DECIMAL_NOT_EXACT"
          ? issue("MONEY_NOT_EXACT", item.path, item.message)
          : issue("MONEY_AMOUNT_MALFORMED", item.path, item.message),
      ),
    );
  }
  if (typeof money.currency !== "string" || !CURRENCY_RE.test(money.currency)) {
    issues.push(
      issue(
        "MONEY_CURRENCY_INVALID",
        `${path}/currency`,
        "currency must be an ISO-4217 alpha-3 code",
      ),
    );
  }
  return issues;
}

export function integerIssues(
  value: unknown,
  path: string,
  bounds?: { min?: number; max?: number },
): ReferenceIssue[] {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    return [issue("INTEGER_MALFORMED", path, "expected a JSON integer within the safe range")];
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    return [issue("INTEGER_OUT_OF_RANGE", path, `integer must be ≥ ${bounds.min}`)];
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    return [issue("INTEGER_OUT_OF_RANGE", path, `integer must be ≤ ${bounds.max}`)];
  }
  return [];
}

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const max = month === 2 && leap ? 29 : (daysInMonth[month - 1] ?? 0);
  return day <= max;
}

export function dateIssues(value: unknown, path: string): ReferenceIssue[] {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    return [
      issue("DATE_MALFORMED", path, 'expected a calendar date "YYYY-MM-DD" without timezone'),
    ];
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (!isRealCalendarDate(year, month, day)) {
    return [issue("DATE_NON_EXISTENT", path, `"${value}" is not a real calendar date`)];
  }
  return [];
}

export function datetimeIssues(value: unknown, path: string): ReferenceIssue[] {
  if (typeof value !== "string" || !DATETIME_RE.test(value)) {
    return [
      issue(
        "DATETIME_MALFORMED",
        path,
        'expected ISO-8601 "YYYY-MM-DDTHH:mm:ss(.ffffff)?(Z|±HH:MM)" with explicit timezone',
      ),
    ];
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (
    !isRealCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 60 // leap second is tolerated by ISO-8601
  ) {
    return [issue("DATETIME_NON_EXISTENT", path, `"${value}" is not a real date/time`)];
  }
  const offset = value.slice(value.search(/([+-]\d{2}:\d{2}|Z)$/));
  if (offset.length === 6) {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      return [issue("DATETIME_NON_EXISTENT", path, `invalid UTC offset "${offset}"`)];
    }
  }
  return [];
}

/** Enum values are stable machine keys; localized labels are never values (§20). */
export function enumIssues(
  value: unknown,
  path: string,
  allowedValues: readonly string[],
): ReferenceIssue[] {
  if (typeof value !== "string" || !allowedValues.includes(value)) {
    return [
      issue(
        "ENUM_VALUE_INVALID",
        path,
        `value must be one of the stable machine keys: ${allowedValues.join(", ")}`,
      ),
    ];
  }
  return [];
}
