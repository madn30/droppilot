import { db } from "../db";
import { type ListingDeps, createListing } from "../listing/service";
import { logger } from "../logger";
import { holidayWindow } from "./calendar";
import { type DiscoveryDeps, type HolidayCandidate, discoverForHoliday, pickHolidayCandidates } from "./discovery";
import { type LifecycleDeps, handleEndedHolidays, pauseListingsPastCutoff } from "./lifecycle";

export interface SeasonalDeps extends DiscoveryDeps, LifecycleDeps {
  listing: ListingDeps;
}

// Seasonal picks are listed on eBay; Amazon listings are created separately.
const SEASONAL_MARKETPLACE = "EBAY";

export interface SeasonalDailyResult {
  paused: string[];
  retargeted: string[];
  ended: string[];
  holidays: {
    code: string;
    date: string;
    discovered: number;
    failed: { externalId: string; error: string }[];
    candidates: HolidayCandidate[];
    /** Listings created (or already existing) for the candidates. */
    listed: string[];
    notListed: { variantId: string; error: string }[];
  }[];
}

/**
 * The daily seasonal job:
 *  1. pause listings that can no longer arrive before their holiday;
 *  2. re-target or end listings whose holiday is over;
 *  3. for every holiday inside its listing window, discover products and list the top N
 *     (as drafts awaiting approval while manual approve is on).
 */
export async function runSeasonalDaily(now: Date, deps: SeasonalDeps): Promise<SeasonalDailyResult> {
  const paused = await pauseListingsPastCutoff(now, deps);
  const { retargeted, ended } = await handleEndedHolidays(now, deps);

  const holidays: SeasonalDailyResult["holidays"] = [];
  for (const holiday of await db.holiday.findMany({ where: { enabled: true }, orderBy: { code: "asc" } })) {
    const window = holidayWindow(holiday, now);
    if (!window.inWindow) continue;
    const discovery = await discoverForHoliday(holiday, deps);
    const candidates = await pickHolidayCandidates(
      holiday,
      window.date,
      discovery.productIds,
      deps.demand.settings,
      now,
    );
    const listed: string[] = [];
    const notListed: { variantId: string; error: string }[] = [];
    for (const candidate of candidates) {
      try {
        const listing = await createListing(candidate.variantId, SEASONAL_MARKETPLACE, deps.listing, { holiday });
        listed.push(listing.id);
      } catch (error) {
        // A compliance refusal or a marketplace error for one product must not block the others; it is reported in the job result.
        logger.error({ holiday: holiday.code, variantId: candidate.variantId, err: error }, "seasonal listing was not created");
        notListed.push({ variantId: candidate.variantId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    holidays.push({
      code: holiday.code,
      date: window.date.toISOString().slice(0, 10),
      discovered: discovery.productIds.length,
      failed: discovery.failed,
      candidates,
      listed,
      notListed,
    });
  }
  return { paused, retargeted, ended, holidays };
}
