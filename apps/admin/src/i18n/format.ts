// Locale-aware presentation formatting (dates, times, numbers, file sizes).
// Presentation only — persisted values are never localized. Uses the Admin
// locale, not the browser locale, so the RU/EN switch reformats everywhere.
import { getLocale } from "./locale.js";

type DateValue = Date | string | number;

function toDate(value: DateValue): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatDate(value: DateValue, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(getLocale(), options).format(toDate(value));
}

export function formatDateTime(value: DateValue, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "short",
    timeStyle: "medium",
    ...options,
  }).format(toDate(value));
}

export function formatTime(value: DateValue, options?: Intl.DateTimeFormatOptions): string {
  // Caller options replace the default wholesale: Intl throws when preset
  // styles (timeStyle) are mixed with explicit components (hour/minute).
  return new Intl.DateTimeFormat(getLocale(), options ?? { timeStyle: "medium" }).format(
    toDate(value),
  );
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}

const SIZE_STEPS: ReadonlyArray<readonly [number, string]> = [
  [1024 ** 3, "GB"],
  [1024 ** 2, "MB"],
  [1024, "KB"],
  [1, "B"],
];

export function formatFileSize(bytes: number): string {
  for (const [unit, suffix] of SIZE_STEPS) {
    if (bytes >= unit) {
      const rounded = Math.round((bytes / unit) * 10) / 10;
      return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(rounded)} ${suffix}`;
    }
  }
  return `${bytes} B`;
}
