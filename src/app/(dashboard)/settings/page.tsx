import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toFormValues } from "@/features/settings/form";
import { SettingsForm } from "@/features/settings/settings-form";
import { requireAdmin } from "@/server/auth/session";
import { type Env, getEnv } from "@/server/env";
import { getSettings } from "@/server/settings/service";

export const dynamic = "force-dynamic";

const API_CONNECTIONS: { name: string; keys: (keyof Env)[] }[] = [
  { name: "CJ Dropshipping", keys: ["CJ_API_KEY"] },
  { name: "eBay", keys: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN"] },
  { name: "Amazon SP-API", keys: ["SPAPI_LWA_CLIENT_ID", "SPAPI_LWA_CLIENT_SECRET", "SPAPI_REFRESH_TOKEN"] },
  { name: "Keepa", keys: ["KEEPA_API_KEY"] },
  { name: "SerpApi (Google Trends)", keys: ["SERPAPI_KEY"] },
  { name: "Anthropic", keys: ["ANTHROPIC_API_KEY"] },
  { name: "Embeddings provider", keys: ["EMBEDDINGS_PROVIDER_KEY"] },
  { name: "Telegram alerts", keys: ["TELEGRAM_WEBHOOK_URL"] },
];

export default async function SettingsPage() {
  await requireAdmin();
  const env = getEnv();
  const settings = await getSettings();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>API connections</CardTitle>
          <CardDescription>
            {env.MOCK_APIS
              ? "Mock mode is on: every API below is served by built-in fake data, whether or not a key is set."
              : "Live mode: every API below is called for real."}{" "}
            Keys are read from the environment. eBay environment: {env.EBAY_ENV}.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {API_CONNECTIONS.map((connection) => {
            const configured = connection.keys.every((key) => Boolean(env[key]));
            return (
              <div key={connection.name} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                <span>{connection.name}</span>
                <Badge variant={configured ? "secondary" : "outline"}>{configured ? "Key set" : "No key"}</Badge>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <SettingsForm values={toFormValues(settings)} />
    </div>
  );
}
