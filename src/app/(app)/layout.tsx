import { openAlertIssueCount } from "@/server/alerts";
import { brandStyle } from "@/lib/brand-color";
import Link from "next/link";
import { LogOut } from "lucide-react";
import { cookies } from "next/headers";
import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { visibleClientsWhere } from "@/server/access";
import { logout } from "@/app/login/actions";
import { CommandPalette, type PaletteItem } from "@/components/command-palette";
import { DesktopSidebar, MobileShell, SIDEBAR_COOKIE, type NavItem } from "@/components/app-nav";
import { NavigationProgress } from "@/components/navigation-progress";
import { Suspense } from "react";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [agency, clients, unread, jar] = await Promise.all([
    prisma.agency.findUniqueOrThrow({ where: { id: user.agencyId }, select: { name: true, brandColor: true, logoUrl: true } }),
    prisma.client.findMany({ where: visibleClientsWhere(user), select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // Integrator: swap for openAlertIssueCount() from src/server/alerts.ts once merged.
    user.role === "CLIENT_USER" ? Promise.resolve(0) : openAlertIssueCount(user.agencyId, user.id).then((r) => r.issues).catch(() => 0),
    cookies(),
  ]);
  const staff = user.role !== "CLIENT_USER";
  // Order: Clients (the landing page), Budget Pacing, AI Insights (issues and opportunities; formerly Alerts), Reports, Settings (incl. connections).
  // The former Home page stays reachable as "Agency overview" from search and the Clients page.
  const admin = user.role === "AGENCY_ADMIN";
  const nav: NavItem[] = staff
    ? [
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
        { href: "/dashboard", label: "Agency overview", kind: "Page" as const, hint: "Month so far, who needs attention, budget health" },
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

  // The agency's own branding (white-label settings): its logo, or its name when there is none.
  const agencyMark = agency.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={agency.logoUrl} alt={staff ? "" : agency.name} className="h-7 w-7 shrink-0 rounded object-contain" />
  ) : (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-brand text-xs font-bold text-brand-ink" aria-hidden>
      {agency.name.slice(0, 1)}
    </div>
  );
  const brand = (
    <>
      {agencyMark}
      <span className="truncate text-sm font-semibold">{agency.name}</span>
    </>
  );
  const signOut = (compact: boolean) => (
    <form action={logout}>
      <button
        title={compact ? "Sign out" : undefined}
        className={`inline-flex min-h-10 w-full cursor-pointer items-center gap-1.5 rounded-md text-sm text-text-2 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${compact ? "justify-center px-0" : "px-3"}`}
      >
        <LogOut className="h-4 w-4" aria-hidden /> <span className={compact ? "sr-only" : undefined}>Sign out</span>
      </button>
    </form>
  );
  const account = (
    <div className="flex flex-col">
      <Link href="/account" className="flex min-h-10 flex-col justify-center rounded-md px-3 py-1 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
        <span className="truncate text-sm font-medium">{user.name}</span>
        <span className="truncate text-xs text-text-3">{user.role.replace("_", " ").toLowerCase()}</span>
      </Link>
      {signOut(false)}
    </div>
  );
  const initials = user.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  const accountCompact = (
    <div className="flex flex-col items-stretch">
      <Link href="/account" title={`${user.name} (your account)`} className="flex min-h-10 items-center justify-center rounded-md hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
        <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-text-2">{initials}</span>
        <span className="sr-only">Your account: {user.name}</span>
      </Link>
      {signOut(true)}
    </div>
  );

  // Client logins: a full-width reporting portal. No agency sidebar or tools; the agency's
  // branding in the header (the reporting provider), the client's own logo on its dashboard.
  // Access is enforced on the server as well (requireAgencyStaff / requireClientView).
  if (!staff) {
    return (
      <div className="min-h-screen" style={brandStyle(agency.brandColor)}>
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4 md:px-10">
            <Link href={user.clientId ? `/clients/${user.clientId}` : "/"} className="flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
              {brand}
            </Link>
            <div className="ml-auto flex items-center gap-1">
              <Link href="/account" className="hidden min-h-10 items-center rounded-md px-3 text-sm text-text-2 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 sm:inline-flex">
                {user.name}
              </Link>
              {signOut(false)}
            </div>
          </div>
        </header>
        <main className="min-w-0 px-4 py-6 md:px-10 md:py-8">{children}</main>
      </div>
    );
  }

  return (
    <div className="min-h-screen md:flex" style={brandStyle(agency.brandColor)}>
      <Suspense fallback={null}>
        <NavigationProgress />
      </Suspense>
      <MobileShell brand={brand} search={<CommandPalette items={paletteItems} variant="icon" />} nav={nav} account={account} />
      <DesktopSidebar
        brand={brand}
        brandMark={agencyMark}
        search={<CommandPalette items={paletteItems} />}
        searchIcon={<CommandPalette items={paletteItems} variant="icon" />}
        nav={nav}
        account={account}
        accountCompact={accountCompact}
        initialCollapsed={jar.get(SIDEBAR_COOKIE)?.value === "collapsed"}
      />
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-8">{children}</main>
    </div>
  );
}
