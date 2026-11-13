import { openAlertIssueCount } from "@/server/alerts";
import { brandStyle } from "@/lib/brand-color";
import Link from "next/link";
import { LogOut } from "lucide-react";
import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { visibleClientsWhere } from "@/server/access";
import { logout } from "@/app/login/actions";
import { CommandPalette, type PaletteItem } from "@/components/command-palette";
import { MobileShell, NavLinks, type NavItem } from "@/components/app-nav";
import { NavigationProgress } from "@/components/navigation-progress";
import { Suspense } from "react";
import { ClientLogo } from "@/components/client-logo";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [agency, clients, unread] = await Promise.all([
    prisma.agency.findUniqueOrThrow({ where: { id: user.agencyId }, select: { name: true, brandColor: true, logoUrl: true } }),
    prisma.client.findMany({ where: visibleClientsWhere(user), select: { id: true, name: true, logoUrl: user.role === "CLIENT_USER" }, orderBy: { name: "asc" } }),
    // Integrator: swap for openAlertIssueCount() from src/server/alerts.ts once merged.
    user.role === "CLIENT_USER" ? Promise.resolve(0) : openAlertIssueCount(user.agencyId, user.id).then((r) => r.issues).catch(() => 0),
  ]);
  const staff = user.role !== "CLIENT_USER";
  // Order: Home, Clients, Budget Pacing, AI Insights (issues and opportunities; formerly Alerts), Reports, Settings (incl. connections).
  const admin = user.role === "AGENCY_ADMIN";
  const nav: NavItem[] = staff
    ? [
        { href: "/dashboard", label: "Home", icon: "home" },
        { href: "/clients", label: "Clients", icon: "clients" },
        { href: "/budget-pacing", label: "Budget Pacing", icon: "pacing" },
        { href: "/insights", label: "AI Insights", icon: "insights", count: unread, match: ["/alerts"] },
        { href: "/reports", label: "Reports", icon: "report" },
        // Account managers can't change agency settings, but they manage connections.
        { href: admin ? "/settings" : "/integrations", label: "Settings", icon: "settings", match: ["/settings", "/integrations"] },
      ]
    : [{ href: `/clients/${user.clientId}`, label: "My reports", icon: "reports" }];

  // Search / Cmd-K: every visible client (and its main sub-pages) plus the main pages.
  const paletteItems: PaletteItem[] = staff
    ? [
        { href: "/clients?new=1", label: "New client", kind: "Action" as const },
        ...nav.map((n) => ({ href: n.href, label: n.label, kind: "Page" as const })),
        { href: "/clients?view=performance", label: "Client performance", kind: "Page" as const, hint: "Clients" },
        { href: "/clients?view=manage", label: "Manage clients", kind: "Page" as const, hint: "Clients" },
        ...(user.role === "AGENCY_ADMIN"
          ? [
              { href: "/settings/team", label: "Team", kind: "Page" as const, hint: "Settings" },
              { href: "/settings/reports", label: "Reports and schedules", kind: "Page" as const, hint: "Settings" },
              { href: "/settings/alerts", label: "Alert settings and Slack", kind: "Page" as const, hint: "Settings" },
              { href: "/integrations", label: "Connections", kind: "Page" as const, hint: "Settings" },
            ]
          : []),
        { href: "/account", label: "Your account", kind: "Page" as const },
        ...clients.flatMap((c) => [
          { href: `/clients/${c.id}`, label: c.name, kind: "Client" as const },
          { href: `/clients/${c.id}?tab=settings`, label: `${c.name} — Settings`, kind: "Client" as const, searchOnly: true },
          { href: `/clients/${c.id}/budgets`, label: `${c.name} — Budgets`, kind: "Client" as const, searchOnly: true },
          { href: `/clients/${c.id}/share`, label: `${c.name} — Share`, kind: "Client" as const, searchOnly: true },
        ]),
      ]
    : [];

  // Client logins are branded as their own business, not the agency.
  const own = staff ? null : clients.find((c) => c.id === user.clientId) ?? clients[0] ?? null;
  const brand = own ? (
    <>
      <ClientLogo name={own.name} logoUrl={own.logoUrl} size="sm" />
      <span className="truncate text-sm font-semibold">{own.name}</span>
    </>
  ) : (
    <>
      {agency.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={agency.logoUrl} alt="" className="h-7 w-7 shrink-0 rounded" />
      ) : (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-brand text-xs font-bold text-brand-ink" aria-hidden>
          {agency.name.slice(0, 1)}
        </div>
      )}
      <span className="truncate text-sm font-semibold">{agency.name}</span>
    </>
  );
  const account = (
    <div className="flex flex-col">
      <Link href="/account" className="flex min-h-10 flex-col justify-center rounded-md px-3 py-1 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
        <span className="truncate text-sm font-medium">{user.name}</span>
        <span className="truncate text-xs text-text-3">{user.role.replace("_", " ").toLowerCase()}</span>
      </Link>
      <form action={logout}>
        <button className="inline-flex min-h-10 w-full items-center gap-1.5 rounded-md px-3 text-sm text-text-2 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 cursor-pointer">
          <LogOut className="h-4 w-4" aria-hidden /> Sign out
        </button>
      </form>
    </div>
  );

  return (
    <div className="min-h-screen md:flex" style={brandStyle(agency.brandColor)}>
      <Suspense fallback={null}>
        <NavigationProgress />
      </Suspense>
      <MobileShell brand={brand} search={staff ? <CommandPalette items={paletteItems} variant="icon" /> : undefined} nav={nav} account={account} />
      <aside className="hidden border-r border-border bg-surface md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col">
        <div className="flex items-center gap-2 px-4 py-4">{brand}</div>
        {staff && (
          <div className="px-3 pb-3">
            <CommandPalette items={paletteItems} />
          </div>
        )}
        <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-2">
          <NavLinks items={nav} />
        </nav>
        <div className="border-t border-border p-2">{account}</div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-8">{children}</main>
    </div>
  );
}
