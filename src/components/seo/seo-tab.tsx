import { Suspense } from "react";
import Link from "next/link";
import { prisma } from "@/server/db";
import { metricBreakdown, metricTotals } from "@/server/metrics/query";
import { keywordRankTable, type KeywordRankRow } from "@/server/metrics/rankings";
import { addDays, dateToIso, diffDays, minDate, type IsoDate } from "@/lib/pacing/dates";
import type { DateRange } from "@/lib/date-ranges";
import { formatDate } from "@/lib/time";
import { formatNumber, formatPct } from "@/lib/money";
import { SectionSkeleton } from "@/components/ui/skeleton";
import { change, ChangeText, Figure, FigureRow, LeadSentence, NotConnected, ResponsiveRows, Section } from "@/components/channel/parts";

// The client's SEO tab: Search Console (what people searched, clicks, pages)
// and tracked keyword positions (DataForSEO), read together. Every sentence is
// built from the figures shown; nothing here is AI-written.

const n0 = (n: number | null) => (n === null ? "—" : formatNumber(n, 0));
const pos = (n: number | null) => (n === null ? "—" : formatNumber(n, 1));
const short = (d: IsoDate) => formatDate(d, { month: "short", day: "numeric" });

export function SeoTab(props: { clientId: string; range: DateRange; cmpRange: DateRange | null; canEdit: boolean; settingsHref: string }) {
  return (
    <Suspense fallback={<SectionSkeleton tiles={4} cards={2} tallFirst={false} />}>
      <SeoContent {...props} />
    </Suspense>
  );
}

async function SeoContent({ clientId, range, cmpRange, canEdit }: { clientId: string; range: DateRange; cmpRange: DateRange | null; canEdit: boolean; settingsHref: string }) {
  const assets = await prisma.dataAsset.findMany({
    where: { clientId, kind: { in: ["GSC_SITE", "RANK_PROJECT"] } },
    select: { kind: true, name: true, status: true, dataCompleteThrough: true },
  });
  const gsc = assets.find((a) => a.kind === "GSC_SITE");
  const rank = assets.find((a) => a.kind === "RANK_PROJECT");

  if (!gsc && !rank) {
    return (
      <NotConnected
        title="SEO isn't connected for this client yet"
        body="Connect Google Search Console to see what people search for and how often they click through to the site, and add keyword tracking to follow daily Google positions for the searches that matter most."
        actions={canEdit ? [{ href: "/integrations", label: "Connect Search Console", primary: true }, { href: `/clients/${clientId}/rankings`, label: "Track keywords" }] : [{ href: "/integrations", label: "Open connections" }]}
      />
    );
  }

  // Search Console publishes data 2–3 days late: end at its last complete day and compare the same number of days.
  const gscThrough = gsc?.dataCompleteThrough ? dateToIso(gsc.dataCompleteThrough) : null;
  const to = gscThrough ? minDate(range.to, gscThrough) : range.to;
  const days = diffDays(range.from, to) + 1;
  const rangeDays = Math.max(diffDays(range.from, range.to) + 1, 1);
  const cur = { from: range.from, to };
  // Same number of days as the current window, never past the comparison range's own end.
  const prev = cmpRange ? { from: cmpRange.from, to: minDate(addDays(cmpRange.from, days - 1), cmpRange.to) } : null;

  if (gsc && days < 1 && !rank) {
    return <NotConnected title="No complete Search Console days in this range yet" body={`Google publishes Search Console data 2–3 days late${gscThrough ? `; the latest complete day is ${short(gscThrough)}` : ""}. Choose a longer range, such as the last 30 days.`} actions={[]} />;
  }
  const keys = ["gsc.clicks", "gsc.impressions", "gsc.ctr", "gsc.position"];
  const [now, before, queriesNow, queriesBefore, pagesNow, pagesBefore, keywords] = await Promise.all([
    gsc && days >= 1 ? metricTotals(clientId, keys, cur.from, cur.to) : null,
    gsc && prev && days >= 1 ? metricTotals(clientId, keys, prev.from, prev.to) : null,
    gsc && days >= 1 ? metricBreakdown(clientId, "query", ["gsc.clicks", "gsc.impressions", "gsc.position"], cur.from, cur.to, 200) : [],
    gsc && prev && days >= 1 ? metricBreakdown(clientId, "query", ["gsc.clicks", "gsc.position"], prev.from, prev.to, 400) : [],
    gsc && days >= 1 ? metricBreakdown(clientId, "page", ["gsc.clicks", "gsc.impressions"], cur.from, cur.to, 10) : [],
    gsc && prev && days >= 1 ? metricBreakdown(clientId, "page", ["gsc.clicks"], prev.from, prev.to, 200) : [],
    // Change is measured from the day before the range starts, so "was" and "now" share one baseline.
    rank ? keywordRankTable(clientId, { to: range.to, days: rangeDays, changeDays: rangeDays }) : [],
  ]);

  const qBefore = new Map(queriesBefore.map((q) => [q.value, q.metrics]));
  const pBefore = new Map(pagesBefore.map((p) => [p.value, p.metrics]));
  const clicks = now?.["gsc.clicks"] ?? null;
  const clicksBefore = before?.["gsc.clicks"] ?? null;

  // The query behind most of the change in clicks, when one stands out. Only queries in this period's
  // list count (one missing from it isn't necessarily at zero), and only when clicks really moved.
  const net = clicks !== null && clicksBefore !== null ? clicks - clicksBefore : null;
  const changed = net !== null && clicksBefore ? Math.abs(net / clicksBefore) >= 0.05 : false;
  const movers = queriesNow.map((q) => ({ query: q.value, now: q.metrics["gsc.clicks"] ?? 0, before: qBefore.get(q.value)?.["gsc.clicks"] ?? 0 })).map((q) => ({ ...q, delta: q.now - q.before }));
  const driver = changed && net ? movers.filter((m) => Math.sign(m.delta) === Math.sign(net)).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] : undefined;
  const driverShare = driver && net ? Math.min(driver.delta / net, 1) : 0;

  // Tracked keywords: where they rank now vs just before the period (the same baseline as `change`).
  // A keyword that dropped out of the top 100 keeps its last known position as its start.
  const lastKnown = (k: KeywordRankRow) => [...k.history].reverse().find((h) => h.position !== null)?.position ?? null;
  const ranked = keywords.map((k) => ({ ...k, start: k.position !== null && k.change !== null ? k.position - k.change : k.position === null ? lastKnown(k) : null }));
  const inTop = (p: number | null, n: number) => p !== null && p <= n;
  const top3 = ranked.filter((k) => inTop(k.position, 3)).length;
  const top10 = ranked.filter((k) => inTop(k.position, 10)).length;
  const comparable = ranked.filter((k) => k.start !== null || k.position === null);
  const top10Before = ranked.filter((k) => inTop(k.start, 10)).length;
  const drop = (k: (typeof ranked)[number]) => (k.start === null ? 0 : (k.position ?? 101) - k.start);
  const biggestDrop = [...ranked].sort((a, b) => drop(b) - drop(a))[0];

  const lead: string[] = [];
  if (clicks !== null && clicksBefore !== null && clicksBefore > 0) {
    const pct = ((clicks - clicksBefore) / clicksBefore) * 100;
    lead.push(Math.abs(pct) < 5 ? `Clicks from Google search held steady at ${n0(clicks)}.` : `Clicks from Google search ${pct < 0 ? "fell" : "rose"} ${Math.round(Math.abs(pct))}%, from ${n0(clicksBefore)} to ${n0(clicks)}.`);
    if (driver && driverShare >= 0.3 && Math.abs(driver.delta) >= 10) {
      lead.push(`${driverShare >= 0.5 ? "Most of that" : "The biggest part"} is one search, “${driver.query}”: ${n0(driver.before)} → ${n0(driver.now)} clicks.`);
    }
  } else if (clicks !== null) {
    lead.push(`${n0(clicks)} clicks from Google search ${short(cur.from)}–${short(cur.to)}.`);
  }
  if (ranked.length) {
    lead.push(`${top10} of ${ranked.length} tracked keywords are on Google's first page${comparable.length === ranked.length && top10 !== top10Before ? ` (${top10Before} just before this period)` : ""}.`);
    if (biggestDrop && drop(biggestDrop) >= 3) lead.push(`“${biggestDrop.keyword}” moved from ${pos(biggestDrop.start)} to ${biggestDrop.position === null ? "outside the top 100" : pos(biggestDrop.position)}.`);
  }

  const cmp = prev ? `vs ${short(prev.from)}–${short(prev.to)}` : null;
  const ctrNow = now?.["gsc.ctr"] ?? null;
  const ctrBefore = before?.["gsc.ctr"] ?? null;

  const multiLocation = new Set(ranked.map((k) => k.locationCode)).size > 1;
  const movedKeywords = [...ranked].sort((a, b) => Math.abs(drop(b)) - Math.abs(drop(a)) || (a.position ?? 999) - (b.position ?? 999)).slice(0, 10);
  const clicksFor = (k: KeywordRankRow) => queriesNow.find((q) => q.value.toLowerCase() === k.keyword.toLowerCase())?.metrics["gsc.clicks"] ?? null;
  const topQueries = queriesNow.slice(0, 10);

  return (
    <div className="flex flex-col gap-6">
      <LeadSentence
        note={
          <>
            {gsc && <>Search Console {gscThrough ? `through ${short(gscThrough)}` : "not synced yet"} ({short(cur.from)}–{short(cur.to)}{cmp ? `, ${cmp}` : ""}).</>}
            {rank && <> Keyword positions checked daily{rank.dataCompleteThrough ? `, last on ${short(dateToIso(rank.dataCompleteThrough))}` : ""}.</>}
          </>
        }
      >
        {lead.join(" ") || "No search data for this period yet."}
      </LeadSentence>

      {gsc && now && (
        <FigureRow>
          <Figure label="Clicks from Google" info="Times someone clicked through to the site from regular (not paid) Google search results, as reported by Search Console." value={n0(clicks)} sub={<ChangeText c={change(clicks, clicksBefore, "up", (x) => formatNumber(x, 0))} />} />
          <Figure label="Times shown in Google" info="Impressions: how often the site appeared in Google search results." value={n0(now["gsc.impressions"])} sub={<ChangeText c={change(now["gsc.impressions"], before?.["gsc.impressions"] ?? null, "up", (x) => formatNumber(x, 0))} />} />
          <Figure label="Click rate" info="Clicks ÷ times shown." value={ctrNow === null ? "—" : formatPct(ctrNow)} sub={ctrBefore !== null && <span className="text-[13px] text-text-2">was {formatPct(ctrBefore)}</span>} />
          {ranked.length ? (
            <Figure label="Tracked keywords in top 10" info="Keywords you track whose latest daily check is on Google's first page." value={<>{top10} <span className="text-base font-medium text-text-3">of {ranked.length}</span></>} sub={<span className="text-[13px] text-text-2">{top3} in the top 3{comparable.length === ranked.length ? ` · was ${top10Before} in top 10` : ""}</span>} />
          ) : (
            <Figure label="Average position" info="Average Search Console position across all searches, weighted by times shown. Lower is better." value={pos(now["gsc.position"])} sub={before?.["gsc.position"] != null && <span className="text-[13px] text-text-2">was {pos(before["gsc.position"])} · lower is better</span>} />
          )}
        </FigureRow>
      )}

      {ranked.length > 0 && (
        <Section title="Tracked keywords" aside={<>Biggest moves first · <Link href={`/clients/${clientId}/rankings`} className="text-brand-text hover:underline">All {ranked.length}</Link></>} footer="Positions are checked daily for each keyword's location and device. Clicks come from Search Console when Google reports that exact search.">
          <ResponsiveRows
            rows={movedKeywords}
            rowKey={(k) => k.keywordId}
            head={[{ label: "Keyword" }, { label: "Position", align: "right" }, { label: "Change", align: "right" }, { label: "Clicks", align: "right" }, { label: "Ranking page" }]}
            cells={(k) => [
              <span key="k" className="font-medium">{k.keyword}{multiLocation && <span className="block text-xs font-normal text-text-3">{k.locationName} · {k.device}</span>}</span>,
              k.position === null ? <span key="p" className="text-text-3">Not in top 100</span> : formatNumber(k.position, 0),
              <PositionChange key="c" change={k.change} out={k.position === null && k.start !== null} />,
              n0(clicksFor(k)),
              <span key="u" className="block max-w-64 truncate text-text-2" title={k.url ?? undefined}>{k.url ? pathOf(k.url) : "—"}</span>,
            ]}
            mobile={(k) => (
              <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 [&>*:nth-child(even)]:text-right">
                <span className="text-sm font-medium">{k.keyword}{multiLocation && <span className="block text-xs font-normal text-text-3">{k.locationName}</span>}</span>
                <span className="text-lg font-semibold tabular">{k.position ?? "—"}</span>
                <span className="text-[13px] text-text-2">{clicksFor(k) !== null ? `${n0(clicksFor(k))} clicks` : k.url ? pathOf(k.url) : ""}</span>
                <PositionChange change={k.change} out={k.position === null && k.start !== null} />
              </div>
            )}
          />
        </Section>
      )}

      {gsc && topQueries.length > 0 && (
        <Section title="What people searched" aside={<>From Search Console · top {topQueries.length} by clicks</>} footer="Every search Google reports for the site, including ones you don't track. Average position here covers all locations and devices, so it won't match a tracked position.">
          <ResponsiveRows
            rows={topQueries}
            rowKey={(q) => q.value}
            head={[{ label: "Search" }, { label: "Clicks", align: "right" }, { label: "Change", align: "right" }, { label: "Times shown", align: "right" }, { label: "Avg. position", align: "right" }]}
            cells={(q) => {
              const b = qBefore.get(q.value);
              return [
                <span key="q" className="font-medium">{q.value}</span>,
                n0(q.metrics["gsc.clicks"]),
                prev ? <DeltaCount key="d" now={q.metrics["gsc.clicks"]} before={b?.["gsc.clicks"] ?? 0} /> : "—",
                n0(q.metrics["gsc.impressions"]),
                pos(q.metrics["gsc.position"]),
              ];
            }}
            mobile={(q) => (
              <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 [&>*:nth-child(even)]:text-right">
                <span className="text-sm font-medium">{q.value}</span>
                <span className="text-sm font-semibold tabular">{n0(q.metrics["gsc.clicks"])} clicks</span>
                <span className="text-[13px] text-text-2">Position {pos(q.metrics["gsc.position"])} · shown {n0(q.metrics["gsc.impressions"])} times</span>
                {prev ? <DeltaCount now={q.metrics["gsc.clicks"]} before={qBefore.get(q.value)?.["gsc.clicks"] ?? 0} /> : <span />}
              </div>
            )}
          />
        </Section>
      )}

      {gsc && pagesNow.length > 0 && (
        <Section title="Pages people landed on from Google" aside="From Search Console">
          <ResponsiveRows
            rows={pagesNow}
            rowKey={(p) => p.value}
            head={[{ label: "Page" }, { label: "Clicks", align: "right" }, { label: "Change", align: "right" }, { label: "Times shown", align: "right" }]}
            cells={(p) => [
              <span key="p" className="block max-w-[28rem] truncate font-medium" title={p.value}>{pathOf(p.value)}</span>,
              n0(p.metrics["gsc.clicks"]),
              prev ? <DeltaCount key="d" now={p.metrics["gsc.clicks"]} before={pBefore.get(p.value)?.["gsc.clicks"] ?? 0} /> : "—",
              n0(p.metrics["gsc.impressions"]),
            ]}
            mobile={(p) => (
              <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 [&>*:nth-child(even)]:text-right">
                <span className="truncate text-sm font-medium">{pathOf(p.value)}</span>
                <span className="text-sm font-semibold tabular">{n0(p.metrics["gsc.clicks"])} clicks</span>
                <span />
                {prev ? <DeltaCount now={p.metrics["gsc.clicks"]} before={pBefore.get(p.value)?.["gsc.clicks"] ?? 0} /> : <span />}
              </div>
            )}
          />
        </Section>
      )}

      {!gsc && (
        <NotConnected title="Add Search Console for clicks and searches" body="Keyword positions are tracked, but without Search Console there are no clicks, searches or pages to show alongside them." actions={[{ href: "/integrations", label: "Connect Search Console", primary: true }]} />
      )}
      {!rank && gsc && canEdit && (
        <p className="text-sm text-text-2">Want daily Google positions for the searches that matter most? <Link href={`/clients/${clientId}/rankings`} className="font-medium text-brand-text hover:underline">Track keywords</Link>.</p>
      )}
    </div>
  );
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || "") || "/";
  } catch {
    return url;
  }
}

/** Position change: lower is better, so a negative change is an improvement. */
function PositionChange({ change, out = false }: { change: number | null; out?: boolean }) {
  if (out) return <span className="text-[13px] font-medium text-critical-ink">dropped out of the top 100</span>;
  if (change === null) return <span className="text-[13px] text-text-3">—</span>;
  if (change === 0) return <span className="text-[13px] text-text-2">no change</span>;
  const up = change < 0;
  return (
    <span className={`text-[13px] font-medium ${up ? "text-good-ink" : "text-critical-ink"}`}>
      <span aria-hidden>{up ? "▲" : "▼"} </span>
      {up ? "up" : "down"} {Math.abs(change)}
    </span>
  );
}

function DeltaCount({ now, before }: { now: number | null; before: number }) {
  const d = (now ?? 0) - before;
  if (d === 0) return <span className="text-[13px] text-text-2">same</span>;
  return <span className={`text-[13px] ${d > 0 ? "text-good-ink" : "text-critical-ink"}`}>{d > 0 ? "+" : "−"}{formatNumber(Math.abs(d), 0)} <span className="text-text-3">from {formatNumber(before, 0)}</span></span>;
}
