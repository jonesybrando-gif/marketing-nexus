"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { addKeywords, addSuggestion, saveRankProject, type RankFormState } from "./actions";
import { useFormSubmit } from "@/components/use-form-submit";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LocationPicker, type PickedLocation } from "@/components/rankings/location-picker";
import { DEVICE_OPTIONS, MAX_KEYWORDS_PER_CLIENT, parseKeywordList, rankCostEstimate, shortLocationName, trackedItemCount, type RankDeviceSetting } from "@/lib/rankings";

const usd = (n: number, digits = 2) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

function Status({ state }: { state: { ok?: string; errors?: string[] } | undefined }) {
  return (
    <>
      {state?.ok && <span className="text-xs text-good-ink" role="status">{state.ok}</span>}
      {state?.errors?.map((e) => <span key={e} className="text-xs text-critical-ink" role="alert">{e}</span>)}
    </>
  );
}

/** Client setup: domain plus the defaults that pre-fill the add panel. Never blocks adding keywords. */
export function RankProjectForm({ clientId, domain, location, device, isNew }: { clientId: string; domain?: string; location: PickedLocation; device: RankDeviceSetting; isNew: boolean }) {
  const [state, action, pending] = useActionState(saveRankProject.bind(null, clientId), undefined);
  const form = useFormSubmit(action);
  return (
    <form {...form} className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-[1fr_1.3fr_auto]">
        <div className="flex flex-col gap-1">
          <Label htmlFor="rank-domain">Website domain</Label>
          <Input id="rank-domain" name="domain" placeholder="example.com" defaultValue={domain} required />
          <span className="text-xs text-text-3">Matches www and any subdomain.</span>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rank-default-location">Default location</Label>
          <LocationPicker id="rank-default-location" defaultValue={location} />
          <span className="text-xs text-text-3">Pre-fills new keywords. Each keyword can have its own location.</span>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-medium text-text-2">Default device</legend>
          <div className="flex flex-col gap-1 pt-1 text-sm">
            {DEVICE_OPTIONS.map((o) => (
              <label key={o.value} className="flex items-center gap-2">
                <input type="radio" name="device" value={o.value} defaultChecked={o.value === device} /> {o.label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : isNew ? "Start tracking" : "Save defaults"}</Button>
        <Status state={state} />
      </div>
    </form>
  );
}

interface Suggestion {
  keyword: string;
  clicks: number;
  impressions: number;
  position: number | null;
  location: PickedLocation;
  fromCity: boolean;
}
interface SuggestionsResponse { hasSearchConsole: boolean; suggestions: Suggestion[]; marketCities: PickedLocation[]; error?: string }

/**
 * The main way to add keywords: paste a batch, pick where they're searched
 * from and on which device, see the cost, add. Below it, Search Console queries
 * not tracked yet, each with a suggested location, one click to add.
 */
export function AddKeywordsPanel({ clientId, tracked, defaultLocation, defaultDevice, pricePerCheck, agencyItems }: {
  clientId: string;
  /** Items checked daily now (this client). */
  tracked: number;
  defaultLocation: PickedLocation;
  defaultDevice: RankDeviceSetting;
  pricePerCheck: number;
  /** Items checked daily across all clients. */
  agencyItems: number;
}) {
  const [state, action, pending] = useActionState(addKeywords.bind(null, clientId), undefined);
  const form = useFormSubmit(action, state?.n);
  const [text, setText] = useState("");
  const [device, setDevice] = useState<RankDeviceSetting>(defaultDevice);
  const [location, setLocation] = useState<PickedLocation>(defaultLocation);
  const [data, setData] = useState<SuggestionsResponse | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setLoadingSuggestions(true);
    fetch(`/api/clients/${clientId}/rank-suggestions`)
      .then((r) => r.json() as Promise<SuggestionsResponse>)
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setData({ hasSearchConsole: false, suggestions: [], marketCities: [], error: "Couldn't load suggestions." }); })
      .finally(() => { if (live) setLoadingSuggestions(false); });
    return () => { live = false; };
  }, [clientId, reload]);

  // After a successful add the form resets: clear the preview and refresh suggestions.
  useEffect(() => {
    if (state?.n) { setText(""); setLocation(defaultLocation); setDevice(defaultDevice); setReload((x) => x + 1); }
  }, [state?.n, defaultLocation, defaultDevice]);

  const keywords = parseKeywordList(text).length;
  const items = trackedItemCount(keywords, device);
  const cost = rankCostEstimate(items, pricePerCheck);
  const after = rankCostEstimate(tracked + items, pricePerCheck);
  const room = Math.max(0, MAX_KEYWORDS_PER_CLIENT - tracked);
  const quickPicks = [
    { label: `Default: ${shortLocationName(defaultLocation.name, defaultLocation.code)}`, location: defaultLocation },
    ...(data?.marketCities ?? []).filter((c) => c.code !== defaultLocation.code).slice(0, 8).map((c) => ({ label: shortLocationName(c.name, c.code), location: c })),
  ];

  return (
    <div className="flex flex-col gap-5">
      <form {...form} className="flex flex-col gap-3" aria-label="Add keywords">
        <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
          <div className="flex flex-col gap-1">
            <Label htmlFor="rank-keywords">Keywords, one per line</Label>
            <textarea
              id="rank-keywords"
              name="keywords"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              placeholder={"reptile party\nkids party entertainment\npetting zoo rental"}
              required
            />
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="rank-add-location">Location</Label>
              <LocationPicker id="rank-add-location" defaultValue={defaultLocation} quickPicks={quickPicks} onChange={setLocation} key={`${defaultLocation.code}`} />
              <span className="text-xs text-text-3">Where the searcher is. Add the same keywords again with another location to track another market.</span>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="rank-add-device">Device</Label>
              <Select id="rank-add-device" name="device" value={device} onChange={(e) => setDevice(e.target.value as RankDeviceSetting)}>
                {DEVICE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </div>
          </div>
        </div>
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm" aria-live="polite">
          {items
            ? <><span className="font-medium">{items} tracked item{items === 1 ? "" : "s"}</span> ({keywords} keyword{keywords === 1 ? "" : "s"} × {device === "both" ? "2 devices" : "1 device"} in {shortLocationName(location.name, location.code)}) × 1 check/day ≈ <span className="font-semibold tabular">{usd(cost.perMonth)}</span>/month. This client would then be about <span className="tabular">{usd(after.perMonth)}</span>/month.</>
            : <>Each keyword × location × device is one tracked item, checked once a day at about {usd(pricePerCheck, 4)} per check. This client: {tracked} item{tracked === 1 ? "" : "s"} ≈ {usd(rankCostEstimate(tracked, pricePerCheck).perMonth)}/month; all clients: {agencyItems} ≈ {usd(rankCostEstimate(agencyItems, pricePerCheck).perMonth)}/month.</>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={pending || room === 0 || !keywords}>{pending ? "Adding…" : items ? `Add ${items} item${items === 1 ? "" : "s"}` : "Add keywords"}</Button>
          <span className="text-xs text-text-3">{tracked} of {MAX_KEYWORDS_PER_CLIENT} tracked items used{items > room ? ` · only ${room} more fit` : ""}</span>
          <Status state={state} />
        </div>
      </form>

      <SuggestionList clientId={clientId} data={data} loading={loadingSuggestions} onAdded={() => setReload((x) => x + 1)} />
    </div>
  );
}

function SuggestionList({ clientId, data, loading, onAdded }: { clientId: string; data: SuggestionsResponse | null; loading: boolean; onAdded: () => void }) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<RankFormState>(undefined);
  if (loading && !data) return <p className="text-sm text-text-3">Looking for keyword ideas in Search Console…</p>;
  if (!data?.hasSearchConsole) return <p className="text-sm text-text-3">Link this client&apos;s Search Console site to get keyword ideas from the searches that already find the site.</p>;
  if (!data.suggestions.length) return <p className="text-sm text-text-3">Every top Search Console query (last 90 days) is already tracked.</p>;
  const add = (s: Suggestion) => {
    setBusy(`${s.keyword}-${s.location.code}`);
    start(async () => {
      const r = await addSuggestion(clientId, s.keyword, s.location.code);
      setMsg(r);
      setBusy(null);
      if (r?.ok) onAdded();
    });
  };
  return (
    <section aria-labelledby="rank-suggestions-h" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="rank-suggestions-h" className="text-sm font-semibold">Ideas from Search Console</h3>
        <span className="text-xs text-text-3">Top searches in the last 90 days that aren&apos;t tracked yet. A city in the search sets the location.</span>
      </div>
      <Status state={msg} />
      <ul className="divide-y divide-border rounded-md border border-border">
        {data.suggestions.slice(0, 15).map((s) => (
          <li key={`${s.keyword}-${s.location.code}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <div className="min-w-0">
              <span className="font-medium">{s.keyword}</span>
              <span className="ml-2 text-xs text-text-3 tabular">{Math.round(s.clicks)} clicks · {Math.round(s.impressions)} impr.{s.position ? ` · avg pos ${s.position.toFixed(1)}` : ""}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={s.fromCity ? "info" : "neutral"} title={s.fromCity ? "The search names this city" : "Client default location"}>{shortLocationName(s.location.name, s.location.code)}</Badge>
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => add(s)} aria-label={`Track ${s.keyword} in ${s.location.name}`}>
                <Plus className="h-3.5 w-3.5" aria-hidden /> {busy === `${s.keyword}-${s.location.code}` ? "Adding…" : "Track"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
