import { Suspense } from "react";
import { prisma } from "@/server/db";
import { metricTotals } from "@/server/metrics/query";
import { linkedSources } from "@/server/dashboards/sources";
import { resolveWidgets } from "@/server/dashboards/data";
import { callrailTemplate } from "@/lib/dashboards/templates/callrail";
import { dateToIso, type IsoDate } from "@/lib/pacing/dates";
import type { CompareMode, DateRange } from "@/lib/date-ranges";
import { formatDate } from "@/lib/time";
import { SectionSkeleton } from "@/components/ui/skeleton";
import { DashboardGrid } from "@/components/dashboards/dashboard-grid";
import { LeadSentence, NotConnected } from "@/components/channel/parts";
import { callLead } from "@/lib/callrail-lead";

// The client's CallRail tab: the same CallRail metrics, widgets and call log as
// the Report builder's CallRail widgets (one metric registry, one widget
// system), for every CallRail company linked to this client. Each call belongs
// to exactly one CallRail company, so adding companies never counts a call twice.

const short = (d: IsoDate) => formatDate(d, { month: "short", day: "numeric" });

export interface CallRailTabProps {
  clientId: string;
  currency: string;
  today: IsoDate;
  range: DateRange;
  cmpRange: DateRange | null;
  compareMode: CompareMode;
  canEdit: boolean;
  /** Agency staff: call recordings are shown to staff only. */
  staff: boolean;
}

export function CallRailTab(props: CallRailTabProps) {
  return (
    <Suspense fallback={<SectionSkeleton tiles={6} cards={2} tallFirst={false} />}>
      <CallRailContent {...props} />
    </Suspense>
  );
}

async function CallRailContent({ clientId, currency, today, range, cmpRange, compareMode, canEdit, staff }: CallRailTabProps) {
  const [linked, companies] = await Promise.all([
    linkedSources(clientId),
    prisma.dataAsset.findMany({ where: { clientId, kind: "CALLRAIL_COMPANY" }, select: { name: true, dataCompleteThrough: true }, orderBy: { name: "asc" } }),
  ]);
  if (!linked.includes("callrail") || companies.length === 0) {
    return (
      <NotConnected
        title="CallRail isn't connected for this client"
        body={staff ? "Link this client's CallRail company to see calls, answered and missed calls, first-time callers, call sources, tracking numbers, qualified calls and the call log." : "Call tracking isn't set up for your reporting yet. Your agency can connect it."}
        actions={staff ? [{ href: "/integrations", label: canEdit ? "Connect CallRail" : "Open connections", primary: canEdit }] : []}
      />
    );
  }

  const keys = ["callrail.calls", "callrail.firstTimeCallers", "callrail.missed"];
  const [data, now, before] = await Promise.all([
    resolveWidgets(callrailTemplate.widgets, { clientId, today, range, cmpRange, compareMode, ads: null, linked, staff }),
    metricTotals(clientId, keys, range.from, range.to),
    cmpRange ? metricTotals(clientId, keys, cmpRange.from, cmpRange.to) : Promise.resolve(null),
  ]);
  const through = companies.map((c) => (c.dataCompleteThrough ? dateToIso(c.dataCompleteThrough) : null)).filter((d): d is IsoDate => !!d).sort()[0];

  return (
    <div className="flex flex-col gap-5">
      <LeadSentence
        note={
          <>
            CallRail · {companies.map((c) => c.name).join(", ")} · {through ? `through ${short(through)}` : "not synced yet"} ({short(range.from)}–{short(range.to)}
            {cmpRange ? `, vs ${short(cmpRange.from)}–${short(cmpRange.to)}` : ""}). &ldquo;Leads&rdquo; are calls marked as a good lead in CallRail; other calls aren&apos;t counted as leads. Ad platforms may also count some of these calls as conversions, so don&apos;t add the two together.
          </>
        }
      >
        {callLead(now, before)}
      </LeadSentence>
      <DashboardGrid widgets={callrailTemplate.widgets} data={data} currency={currency} staff={staff} />
    </div>
  );
}
