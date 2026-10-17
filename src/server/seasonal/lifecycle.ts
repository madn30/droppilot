import type { Holiday, Marketplace } from "@prisma/client";
import { db } from "../db";
import type { MarketplaceAdapter } from "../marketplaces/types";
import { addDays, cutoffDate, occurrenceOnOrAfter, startOfDayUtc } from "./calendar";
import { MAX_TITLE_LENGTH, addHolidayKeyword, removeHolidayWords } from "./titles";

export interface LifecycleDeps {
  getMarketplace: (marketplace: Marketplace) => MarketplaceAdapter;
}

/**
 * Pauses seasonal listings whose cut-off has passed: an order taken today
 * could no longer arrive before the holiday. Returns the paused listing ids.
 */
export async function pauseListingsPastCutoff(now: Date, deps: LifecycleDeps): Promise<string[]> {
  const listings = await db.listing.findMany({
    where: { status: "ACTIVE", holidayId: { not: null }, cutoffDate: { lt: startOfDayUtc(now) } },
  });
  for (const listing of listings) {
    // Marketplace first: if it fails, the listing stays ACTIVE here and the next run retries.
    if (listing.externalId) {
      await deps.getMarketplace(listing.marketplace).updateListing({ externalId: listing.externalId, sku: listing.sku }, { quantity: 0 });
    }
    await db.listing.update({ where: { id: listing.id }, data: { status: "PAUSED", pauseReason: "HOLIDAY_CUTOFF" } });
  }
  return listings.map((listing) => listing.id);
}

/**
 * Handles listings whose holiday is over (holiday date + endAfterDays):
 * holiday words come out of the title, then the listing is either re-targeted
 * to the holiday's successor (e.g. Valentine's → Mother's Day) or ended.
 */
export async function handleEndedHolidays(now: Date, deps: LifecycleDeps): Promise<{ retargeted: string[]; ended: string[] }> {
  const today = startOfDayUtc(now);
  const holidays = await db.holiday.findMany();
  const holidayByCode = new Map(holidays.map((holiday) => [holiday.code, holiday]));

  const listings = await db.listing.findMany({
    where: { holidayId: { not: null }, cutoffDate: { not: null }, status: { not: "ENDED" } },
    include: { holiday: true, variant: true },
  });

  const retargeted: string[] = [];
  const ended: string[] = [];
  for (const listing of listings) {
    const holiday = listing.holiday;
    if (!holiday || !listing.cutoffDate) continue;
    // The cut-off was set for one specific occurrence: the first one after it.
    const occurrence = occurrenceOnOrAfter(holiday.dateRule, listing.cutoffDate);
    if (today < addDays(occurrence, holiday.endAfterDays)) continue;

    const adapter = listing.externalId ? deps.getMarketplace(listing.marketplace) : null;
    const ref = { externalId: listing.externalId ?? "", sku: listing.sku, groupKey: listing.groupKey };
    const next: Holiday | undefined = holiday.retargetToCode ? holidayByCode.get(holiday.retargetToCode) : undefined;

    if (!next?.enabled) {
      if (adapter) await adapter.endListing(ref);
      await db.listing.update({ where: { id: listing.id }, data: { status: "ENDED", pauseReason: null } });
      ended.push(listing.id);
      continue;
    }

    const title = addHolidayKeyword(removeHolidayWords(listing.title, holiday), next, MAX_TITLE_LENGTH[listing.marketplace]);
    const nextDate = occurrenceOnOrAfter(next.dateRule, today);
    // A listing paused only because the old holiday's cut-off passed can sell again.
    const resume = listing.status === "PAUSED" && listing.pauseReason === "HOLIDAY_CUTOFF";
    if (adapter) await adapter.updateListing(ref, resume ? { title, quantity: listing.quantity } : { title });
    await db.listing.update({
      where: { id: listing.id },
      data: {
        title,
        holidayId: next.id,
        cutoffDate: cutoffDate(nextDate, listing.variant.processingDays, listing.variant.deliveryDaysMax),
        ...(resume ? { status: "ACTIVE", pauseReason: null } : {}),
      },
    });
    retargeted.push(listing.id);
  }
  return { retargeted, ended };
}
