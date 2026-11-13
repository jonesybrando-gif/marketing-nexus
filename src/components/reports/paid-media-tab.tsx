import type { ReactNode } from "react";
import { LineChart } from "lucide-react";
import type { ClientReport, ReportParams } from "@/server/client-report";
import { kpiValues, type KpiKey } from "@/lib/kpis";
import { stillCounting } from "@/lib/results";
import { formatDate } from "@/lib/time";
import { KpiCard, kpiNote } from "@/components/kpi/kpi-card";
import { TrendChart } from "@/components/charts/trend-chart";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { AccountSelector } from "./account-filter";
import { CampaignsSection, noActivity, notesFor } from "./report-sections";

const CARDS: KpiKey[] = ["spend", "conversions", "costPerConversion"];
const TREND_METRICS: KpiKey[] = ["spend", "conversions", "costPerConversion", "clicks", "impressions", "ctr", "cpc", "conversionRate", "leads", "costPerLead"];

/**
 * Paid Media: which accounts and campaigns drive results. Account selector,
 * three headline figures, the campaign table, and Performance Trends (closed
 * by default) with dated annotations.
 */
export function PaidMediaTab({ rep, basePath, params, annotations }: { rep: ClientReport; basePath: string; params: ReportParams; annotations: ReactNode }) {
  const scope = rep.accountScope;
  const c = rep.client.currency;
  const prev = rep.cmpPerf?.totals ?? null;
  const kvs = kpiValues(CARDS, rep.perf.totals, prev, { stillCounting: stillCounting(rep.range.to, rep.today) });
  const detailParams: ReportParams = { range: params.range, compare: params.compare, from: params.from, to: params.to };

  return (
    <div className="flex flex-col gap-4">
      {(scope.all.length > 1 || scope.otherCurrency.length > 0) && (
        <div className="flex flex-col gap-1">
          <AccountSelector accounts={scope.all} selected={scope.selected} size="md" />
          {scope.otherCurrency.length > 0 && (
            <p className="text-xs text-text-3">
              Not included: {scope.otherCurrency.map((a) => `${a.name} (${a.currency})`).join(", ")}. Amounts in different currencies aren&apos;t added together; pick the account to see it on its own.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {kvs.map((kv) => <KpiCard key={kv.key} kv={kv} currency={c} note={kpiNote(kv)} />)}
      </div>

      <CampaignsSection
        rep={rep}
        staff
        basePath={basePath}
        detail={{ clientId: rep.client.id, params: detailParams }}
        description="Sorted by spend. Click a campaign for its details and history; use Columns for more figures."
      />

      <CollapsibleSection
        storageKey="paid-trends"
        title="Performance trends"
        icon={<LineChart className="h-4 w-4 text-text-2" aria-hidden />}
        hint={`Daily figures, ${formatDate(rep.range.from)} to ${formatDate(rep.range.to)}`}
        defaultOpen={false}
      >
        <div className="flex flex-col gap-4">
          {noActivity(rep) ? (
            <p className="py-6 text-center text-sm text-text-3">No activity in this period, so there is nothing to chart yet.</p>
          ) : (
            <TrendChart current={rep.perf.byDate} comparison={rep.cmpPerf?.byDate ?? null} currency={c} metrics={TREND_METRICS} notes={notesFor(rep, true)} />
          )}
          {annotations}
        </div>
      </CollapsibleSection>
    </div>
  );
}
