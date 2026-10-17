"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ items }: { items: { href: string; label: string; alert?: boolean }[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap gap-1 md:flex-col">
      {items.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className="rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
          >
            {item.label}
            {item.alert && (
              <>
                <span aria-hidden className="ml-1.5 inline-block size-2 rounded-full bg-destructive align-middle" />
                <span className="sr-only">needs your attention</span>
              </>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
