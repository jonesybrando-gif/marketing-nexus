import Link from "next/link";
import { prisma } from "@/server/db";
import { requireAgencyStaff, visibleClientsWhere } from "@/server/access";
import { agencyAuditList } from "@/server/site-audit/queries";
import { monthSpend } from "@/server/site-audit/jobs";
import { Card, CardContent } from "@/components/ui/card";
import { AuditList } from "./audit-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Site Audits" };

/** Every client's website health, worst first, so the sites that need work stand out. */
export default async function SiteAuditsPage() {
  const user = await requireAgencyStaff();
  const where = visibleClientsWhere(user);
  const [rows, agency, spent, unset] = await Promise.all([
    agencyAuditList(where),
    prisma.agency.findUniqueOrThrow({ where: { id: user.agencyId }, select: { siteAuditMonthlyCapUsd: true } }),
    monthSpend(user.agencyId),
    prisma.client.count({ where: { ...where, archivedAt: null, siteAuditConfig: null } }),
  ]);
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Site Audits</h1>
          <p className="text-sm text-text-2">Technical SEO health of each client&apos;s website from scheduled DataForSEO crawls. Lowest scores first.</p>
        </div>
        <p className="text-sm text-text-2">This month: <span className="font-semibold tabular text-text">${spent.toFixed(2)}</span> of the ${agency.siteAuditMonthlyCapUsd.toFixed(2)} cap{user.role === "AGENCY_ADMIN" && <> · <Link href="/integrations" className="text-brand-text hover:underline">change</Link></>}</p>
      </header>
      {rows.length ? (
        <AuditList rows={rows} />
      ) : (
        <Card><CardContent className="py-6 text-sm text-text-2">No client has a site audit yet. Open a client and choose the Site Audit tab to set one up.</CardContent></Card>
      )}
      {unset > 0 && rows.length > 0 && <p className="text-xs text-text-3">{unset} other client{unset === 1 ? " has" : "s have"} no site audit set up. Open the client&apos;s Site Audit tab to add one.</p>}
    </div>
  );
}
