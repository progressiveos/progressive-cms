// Local wall-clock → UTC instant conversion (PCMS-PUB-T021, spec §27).
// Persisted instants are always UTC; schedule INPUT may be local wall-clock
// in the plan timezone. Implemented with Intl offset probing — no timezone
// library dependency (owner instruction #54): civil additions re-resolve
// their offset so DST transitions land on the correct instant.
import { PublicationError } from "./errors.js";

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (formatter === undefined) {
    try {
      // Formation call validates the zone identifier (fail-secure).
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new PublicationError("PLAN_INVALID", `unknown IANA timezone "${timeZone}"`, {
        details: { timeZone },
      });
    }
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Offset (ms) of `timeZone` at the given instant. */
export function zoneOffsetMilliseconds(instant: Date, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour?: number;
  readonly minute?: number;
}

/** Local wall-clock time in `timeZone` → exact UTC instant. Two-pass offset
 * resolution; non-existent spring-forward times resolve just after the
 * transition (documented baseline semantics, tested). */
export function zonedWallClockToInstant(wall: WallClock, timeZone: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0, 0);
  let offset = zoneOffsetMilliseconds(new Date(guess), timeZone);
  let instant = guess - offset;
  offset = zoneOffsetMilliseconds(new Date(instant), timeZone);
  instant = guess - offset;
  return new Date(instant);
}

/** Add `days` calendar days to a wall-clock date (no time-of-day drift). */
export function addDaysToWallClock(wall: WallClock, days: number): WallClock {
  const utc = Date.UTC(wall.year, wall.month - 1, wall.day + days);
  const shifted = new Date(utc);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    ...(wall.hour !== undefined && { hour: wall.hour }),
    ...(wall.minute !== undefined && { minute: wall.minute }),
  };
}

/** Wall-clock representation of an instant in `timeZone` (scheduling UIs,
 * calendar rendering, tests). */
export function instantToZonedWallClock(
  instant: Date,
  timeZone: string,
): WallClock & {
  readonly hour: number;
  readonly minute: number;
} {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}
