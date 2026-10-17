const DAY_MS = 24 * 60 * 60 * 1000;

/** Days kept in hand between the delivery estimate and the event. */
const DELIVERY_BUFFER_DAYS = 2;

export function startOfDayUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Whole days from `from` to `to`, by calendar date. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDayUtc(to).getTime() - startOfDayUtc(from).getTime()) / DAY_MS);
}

/**
 * The date a holiday falls on in a given year (UTC midnight).
 * Rules: "MM-DD" for fixed dates, or "nth:<month>:<n>:<weekday>[+days]" for
 * the n-th weekday (0 = Sunday) of a month plus an optional offset, e.g.
 * "nth:5:2:0" (second Sunday of May) or "nth:11:4:4+1" (day after the fourth Thursday of November).
 */
export function holidayDate(dateRule: string, year: number): Date {
  const fixed = /^(\d{2})-(\d{2})$/.exec(dateRule);
  if (fixed) return new Date(Date.UTC(year, Number(fixed[1]) - 1, Number(fixed[2])));

  const nth = /^nth:(\d{1,2}):([1-5]):([0-6])(?:\+(\d+))?$/.exec(dateRule);
  if (!nth) throw new Error(`Invalid holiday date rule "${dateRule}"`);
  const [month, n, weekday, offset] = [Number(nth[1]), Number(nth[2]), Number(nth[3]), Number(nth[4] ?? 0)];
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysToFirstWeekday = (weekday - first.getUTCDay() + 7) % 7;
  return addDays(first, daysToFirstWeekday + (n - 1) * 7 + offset);
}

/** The first occurrence of the holiday on or after `from`. */
export function occurrenceOnOrAfter(dateRule: string, from: Date): Date {
  const day = startOfDayUtc(from);
  const thisYear = holidayDate(dateRule, day.getUTCFullYear());
  return thisYear >= day ? thisYear : holidayDate(dateRule, day.getUTCFullYear() + 1);
}

/**
 * The last day an order can be taken and still arrive before the holiday:
 * processing + slowest delivery + buffer days ahead of it.
 */
export function cutoffDate(holiday: Date, processingDays: number, deliveryDaysMax: number): Date {
  return addDays(holiday, -(processingDays + deliveryDaysMax + DELIVERY_BUFFER_DAYS));
}

export interface HolidayWindow {
  /** The upcoming occurrence. */
  date: Date;
  /** First day products are discovered and listed for it. */
  listStart: Date;
  /** True from listStart through the holiday itself. */
  inWindow: boolean;
}

export function holidayWindow(holiday: { dateRule: string; listStartDaysBefore: number }, now: Date): HolidayWindow {
  const date = occurrenceOnOrAfter(holiday.dateRule, now);
  const listStart = addDays(date, -holiday.listStartDaysBefore);
  return { date, listStart, inWindow: startOfDayUtc(now) >= listStart };
}
