import { getNotifiers } from "@/server/alerts/notifiers";
import { sendNotice } from "@/server/alerts/service";
import { db } from "@/server/db";
import { type TrendingDiscoveryResult, runTrendingDiscovery } from "@/server/discovery/trending";
import { runSeasonalDaily } from "@/server/seasonal/daily";
import { buildSeasonalDeps } from "@/server/seasonal/deps";

async function listingTitles(listingIds: string[]): Promise<string[]> {
  const listings = await db.listing.findMany({ where: { id: { in: listingIds } }, select: { title: true, sku: true } });
  return listings.map((listing) => `  ${listing.title} (SKU ${listing.sku})`);
}

/** Runs the daily seasonal job and returns a JSON-safe summary for the job log. */
export async function seasonalDaily() {
  const result = await runSeasonalDaily(new Date(), await buildSeasonalDeps());
  const lines = [
    ...(result.paused.length > 0 ? [`Paused, holiday cut-off passed (${result.paused.length}):`, ...(await listingTitles(result.paused))] : []),
    ...(result.retargeted.length > 0 ? [`Re-targeted to the next holiday (${result.retargeted.length}):`, ...(await listingTitles(result.retargeted))] : []),
    ...(result.ended.length > 0 ? [`Ended, holiday over (${result.ended.length}):`, ...(await listingTitles(result.ended))] : []),
    ...result.holidays.flatMap((holiday) =>
      holiday.discovered + holiday.failed.length + holiday.notListed.length === 0
        ? []
        : [
            `${holiday.code} (${holiday.date}): ${holiday.discovered} product(s) evaluated, ${holiday.listed.length} listed`,
            ...holiday.failed.map((failure) => `  Failed ${failure.externalId}: ${failure.error}`),
            ...holiday.notListed.map((refusal) => `  Not listed: ${refusal.error}`),
          ],
    ),
  ];
  if (lines.length > 0) await sendNotice({ title: "Daily seasonal run finished", message: lines.join("\n") }, getNotifiers());
  return {
    ...result,
    holidays: result.holidays.map((holiday) => ({
      ...holiday,
      candidates: holiday.candidates.map((candidate) => ({
        ...candidate,
        cutoffDate: candidate.cutoffDate.toISOString().slice(0, 10),
      })),
    })),
  };
}

/** The Telegram/email summary of a trending run, given the titles of the listings it created. */
export function trendingSummary(result: TrendingDiscoveryResult, listedTitles: string[]): string[] {
  let outcome: string;
  if (result.listed.length > 0) outcome = `Listed (${result.listed.length}):`;
  else if (result.notListed.length > 0) outcome = "Nothing was listed:";
  else if (result.evaluated > 0) outcome = "None reached the demand threshold, so nothing was listed.";
  else outcome = "Nothing was scored, so nothing was listed.";
  return [
    `${result.evaluated} trending supplier product(s) imported, matched and scored, ${result.failed.length} failed`,
    outcome,
    ...listedTitles,
    ...result.notListed.map((refusal) => `Not listed: ${refusal.error}`),
    ...result.failed.map((failure) => `Failed ${failure.externalId}: ${failure.error}`),
  ];
}

/** Runs the daily trending discovery. */
export async function trendingDiscovery() {
  const result = await runTrendingDiscovery(new Date(), await buildSeasonalDeps());
  if (result.evaluated + result.failed.length > 0) {
    await sendNotice(
      {
        title: "Daily trending discovery finished",
        message: trendingSummary(result, await listingTitles(result.listed)).join("\n"),
      },
      getNotifiers(),
    );
  }
  return { ...result };
}
