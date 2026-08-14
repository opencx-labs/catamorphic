/**
 * Minimal local-date helpers for the calendar components. Dates are ISO
 * `YYYY-MM-DD` strings everywhere in the public API — JSON-safe, timezone
 * free (v1 is date-only by design; no TZ machinery). Internally they round-
 * trip through local `Date` objects at noon to dodge DST edge cases.
 */

export interface DateRange {
  from: string;
  to: string;
}

export function toIsoDate(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local Date at noon for an ISO day (noon: DST shifts can't change the day). */
export function fromIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
}

export function todayIso(): string {
  return toIsoDate(new Date());
}

export function addDays(iso: string, days: number): string {
  const date = fromIsoDate(iso);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

export function addMonths(iso: string, months: number): string {
  const date = fromIsoDate(iso);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  // Clamp: Jan 31 + 1 month is Feb 28/29, never Mar 2/3.
  const last = daysInMonth(date.getFullYear(), date.getMonth());
  date.setDate(Math.min(day, last));
  return toIsoDate(date);
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** ISO strings compare correctly as strings; helpers for readability. */
export function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}

export function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

export function isoMonth(iso: string): string {
  return iso.slice(0, 7);
}

/** Human date, e.g. "Aug 14, 2026". */
export function formatIsoDate(iso: string): string {
  return fromIsoDate(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
