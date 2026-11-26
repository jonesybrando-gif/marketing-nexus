"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { LOCATION_COUNTRIES, type RankLocationOption } from "@/lib/rankings";

export interface PickedLocation { code: number; name: string }

/**
 * Type-ahead over DataForSEO's Google locations (cities, counties, DMAs,
 * states, ZIPs) for one country at a time. Submits through hidden inputs
 * `locationCode` and `locationName`, so it drops into a plain <form>.
 * Quick picks (the client default, cities the site has pages for) set the
 * location in one click.
 */
export function LocationPicker({
  id,
  defaultValue,
  quickPicks = [],
  onChange,
  className,
}: {
  id?: string;
  defaultValue: PickedLocation;
  quickPicks?: { label: string; location: PickedLocation }[];
  onChange?: (loc: PickedLocation) => void;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("US");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<RankLocationOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const inputId = id ?? `${listId}-input`;

  // Restore the default on form.reset() (after a successful add).
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const onReset = () => { setValue(defaultValue); setQuery(""); };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [defaultValue]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setError(null); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/rank-locations?q=${encodeURIComponent(q)}&country=${country}`, { signal: ctrl.signal });
        const json = (await res.json()) as { locations?: RankLocationOption[]; error?: string };
        setResults(json.locations ?? []);
        setError(json.error ?? null);
        setActive(0);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("Search failed. Try again.");
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query, country]);

  const codeOption = /^\d{4,9}$/.test(query.trim()) && !results.some((r) => r.code === Number(query.trim()))
    ? [{ code: Number(query.trim()), name: `Location code ${query.trim()}`, type: "Code", countryIso: country }]
    : [];
  const options = [...results, ...codeOption];

  const choose = (loc: PickedLocation) => {
    setValue(loc);
    setQuery("");
    setOpen(false);
    onChange?.(loc);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { if (open && options[active]) { e.preventDefault(); choose(options[active]); } }
    else if (e.key === "Escape") { setOpen(false); setQuery(""); }
  };

  return (
    <div ref={boxRef} className={cn("relative flex flex-col gap-1.5", className)}>
      <input type="hidden" name="locationCode" value={value.code} />
      <input type="hidden" name="locationName" value={value.name} />
      <div className="flex gap-1.5">
        <select
          aria-label="Country to search"
          value={country}
          onChange={(e) => { setCountry(e.target.value); setResults([]); }}
          className="h-9 w-[4.5rem] shrink-0 rounded-md border border-border bg-surface px-1.5 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {LOCATION_COUNTRIES.map((c) => <option key={c.iso} value={c.iso} title={c.name}>{c.iso}</option>)}
        </select>
        <div className="relative min-w-0 flex-1">
          <MapPin className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-3" aria-hidden />
          <input
            ref={inputRef}
            id={inputId}
            role="combobox"
            aria-expanded={open && query.trim().length >= 2}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
            autoComplete="off"
            value={open || query ? query : value.name}
            placeholder={value.name || "City, county, state or ZIP"}
            onFocus={() => { setOpen(true); setQuery(""); }}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onKeyDown={onKeyDown}
            className="h-9 w-full rounded-md border border-border bg-surface pl-8 pr-3 text-sm text-text placeholder:text-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
          {open && query.trim().length >= 2 && (
            <ul id={listId} role="listbox" aria-label="Locations" className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg">
              {options.map((o, i) => (
                <li
                  key={`${o.code}-${o.type}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={o.code === value.code}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose({ code: o.code, name: o.name })}
                  className={cn("flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-sm", i === active && "ui-selected")}
                >
                  <span className="truncate">{o.name}</span>
                  <span className="shrink-0 text-xs text-text-3">{o.type}</span>
                </li>
              ))}
              {!options.length && <li className="px-3 py-2 text-sm text-text-3">{searching ? "Searching…" : error ?? "No matching location. Try a city, county, state or ZIP."}</li>}
            </ul>
          )}
        </div>
      </div>
      {quickPicks.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Quick locations">
          {quickPicks.map((p) => (
            <button
              key={`${p.label}-${p.location.code}`}
              type="button"
              onClick={() => choose(p.location)}
              aria-pressed={value.code === p.location.code}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs",
                value.code === p.location.code ? "border-brand bg-brand/10 text-text" : "border-border text-text-2 hover:bg-surface-2",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
