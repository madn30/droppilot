import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { daysBetween, holidayWindow } from "@/server/seasonal/calendar";

const holidayInclude = {
  listings: { where: { status: { not: "ENDED" } }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.HolidayInclude;

type HolidayWithListings = Prisma.HolidayGetPayload<{ include: typeof holidayInclude }>;

export interface UpcomingHoliday {
  holiday: HolidayWithListings;
  date: Date;
  listStart: Date;
  inWindow: boolean;
  daysUntil: number;
}

/** Enabled holidays with their next occurrence, soonest first. */
export async function listUpcomingHolidays(now: Date): Promise<UpcomingHoliday[]> {
  const holidays = await db.holiday.findMany({ where: { enabled: true }, include: holidayInclude });
  return holidays
    .map((holiday) => {
      const window = holidayWindow(holiday, now);
      return { holiday, ...window, daysUntil: daysBetween(now, window.date) };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
