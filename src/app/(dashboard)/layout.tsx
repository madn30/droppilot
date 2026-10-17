import { Badge } from "@/components/ui/badge";
import { NavLinks } from "@/components/nav-links";
import { Button } from "@/components/ui/button";
import { getAttention } from "@/features/attention/queries";
import { logoutAction } from "@/features/auth/actions";
import { requireAdmin } from "@/server/auth/session";
import { getEnv } from "@/server/env";

const NAV_ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/products", label: "Products" },
  { href: "/seasonal", label: "Seasonal" },
  { href: "/settings", label: "Settings" },
];

export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await requireAdmin();
  const { MOCK_APIS } = getEnv();
  const attention = await getAttention();

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b p-4 md:sticky md:top-0 md:h-screen md:w-56 md:border-r md:border-b-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold">DropPilot</span>
          {MOCK_APIS && <Badge variant="secondary">Mock mode</Badge>}
        </div>
        <NavLinks items={NAV_ITEMS.map((item) => ({ ...item, alert: item.href === "/products" && attention.total > 0 }))} />
        <form action={logoutAction} className="md:mt-auto">
          <p className="mb-2 truncate text-xs text-muted-foreground">{session.email}</p>
          <Button type="submit" variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
