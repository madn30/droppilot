import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listUpcomingHolidays } from "@/features/seasonal/queries";
import { requireAdmin } from "@/server/auth/session";

export const dynamic = "force-dynamic";

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function SeasonalPage() {
  await requireAdmin();
  const holidays = await listUpcomingHolidays(new Date());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Seasonal</h1>
        <p className="text-sm text-muted-foreground">
          Upcoming holidays, soonest first. Inside a holiday&apos;s listing window the daily job discovers products with
          its keywords. Each listing stops selling on its cut-off date: processing + delivery + 2 days before the holiday.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {holidays.map(({ holiday, date, listStart, inWindow, daysUntil }) => (
          <Card key={holiday.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {holiday.name}
                <Badge variant={inWindow ? "default" : "secondary"}>{inWindow ? "Listing now" : "Upcoming"}</Badge>
              </CardTitle>
              <CardDescription>
                {formatDate(date)} · in {daysUntil} {daysUntil === 1 ? "day" : "days"} · listing window opens {formatDate(listStart)}
                {holiday.retargetToCode ? ` · afterwards re-targets to ${holiday.retargetToCode}` : " · afterwards listings end"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">Keywords: {holiday.keywords.join(", ")}</p>
              {holiday.listings.length === 0 ? (
                <p className="text-muted-foreground">Nothing listed for this holiday yet.</p>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1 font-medium">Listing</th>
                      <th className="py-1 font-medium">Status</th>
                      <th className="py-1 font-medium">Cut-off</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holiday.listings.map((listing) => (
                      <tr key={listing.id}>
                        <td className="py-0.5 pr-4">{listing.title}</td>
                        <td className="py-0.5 pr-4">
                          {listing.status.toLowerCase().replaceAll("_", " ")}
                          {listing.pauseReason && ` (${listing.pauseReason.toLowerCase().replaceAll("_", " ")})`}
                        </td>
                        <td className="py-0.5 tabular-nums">{listing.cutoffDate ? formatDate(listing.cutoffDate) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
