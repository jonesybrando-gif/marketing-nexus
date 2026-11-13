"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { campaignDetailAction, type CampaignDetail } from "@/app/(app)/clients/[id]/campaign-actions";
import type { ReportParams } from "@/server/client-report";
import { kpiValues, untrackedKpis, type KpiKey } from "@/lib/kpis";
import type { PlatformKey } from "@/lib/platforms";
import { formatDate } from "@/lib/time";
import { KpiCard, kpiNote } from "@/components/kpi/kpi-card";
import { TrendChart } from "@/components/charts/trend-chart";
import { PlatformLabel } from "@/components/platform-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const KEYS: KpiKey[] = ["spend", "conversions", "costPerConversion", "clicks", "ctr", "cpc", "impressions", "conversionRate", "conversionValue", "roas", "leads", "costPerLead"];

/** A campaign's figures and daily history for the page's range, in a side panel. */
export function CampaignDetailPanel({ clientId, params, campaign, onClose }: { clientId: string; params: ReportParams; campaign: { id: string; name: string }; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<CampaignDetail | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    setData(null);
    campaignDetailAction(clientId, campaign.id, params)
      .then((r) => live && setData(r))
      .catch(() => live && setData({ ok: false, error: "Couldn't load this campaign. Try again in a moment." }));
    return () => {
      live = false;
    };
    // params is a fresh object each render; its contents decide the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, campaign.id, JSON.stringify(params)]);

  const ok = data?.ok ? data : null;
  const hidden = ok ? untrackedKpis(ok.totals, ok.previous) : new Set<KpiKey>();
  const values = ok ? kpiValues(KEYS.filter((k) => !hidden.has(k)), ok.totals, ok.previous) : [];

  return (
    <dialog
      ref={ref}
      aria-label={`Campaign: ${campaign.name}`}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
      className="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-full max-w-2xl overflow-y-auto border-l border-border bg-bg p-0 text-text shadow-xl backdrop:bg-black/30"
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{campaign.name}</h2>
            {ok && (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-text-3">
                <PlatformLabel platform={ok.platform as PlatformKey} /> · {ok.account} · {ok.status.charAt(0) + ok.status.slice(1).toLowerCase()}
              </p>
            )}
            {ok && (
              <p className="mt-1 text-xs text-text-3">
                {formatDate(ok.range.from)} to {formatDate(ok.range.to)}
                {ok.cmpRange && <> · compared with {formatDate(ok.cmpRange.from)} to {formatDate(ok.cmpRange.to)}</>}
              </p>
            )}
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={() => ref.current?.close()} aria-label="Close campaign details" autoFocus>
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        {data === null && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-busy="true" aria-label="Loading campaign">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-20" />)}
          </div>
        )}
        {data && !data.ok && <p className="text-sm text-critical-ink">{data.error}</p>}
        {ok && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {values.map((kv) => <KpiCard key={kv.key} kv={kv} currency={ok.currency} note={kpiNote(kv)} />)}
            </div>
            <section className="rounded-lg border border-border bg-surface p-4">
              <h3 className="mb-3 text-sm font-semibold">Day by day</h3>
              {ok.daily.length ? (
                <TrendChart current={ok.daily} comparison={ok.cmpDaily} currency={ok.currency} metrics={["spend", "conversions", "costPerConversion", "clicks", "impressions"]} />
              ) : (
                <p className="text-sm text-text-3">No synced days for this campaign in this period.</p>
              )}
            </section>
            <p className="text-xs text-text-3">Figures are as the ad platform reports them. Recent conversions can still be counted for a few days.</p>
          </>
        )}
      </div>
    </dialog>
  );
}
