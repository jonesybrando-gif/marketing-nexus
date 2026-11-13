"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { LayoutGrid, List, Search } from "lucide-react";
import { loadOnHover } from "@/lib/link-hover";
import { cn } from "@/components/ui/cn";
import { CLIENTS_VIEW_COOKIE, type DirectoryLayout } from "@/lib/client-directory";

export interface DirectoryClient {
  id: string;
  name: string;
  /** Logo URL (cached image route), or null when the client has no logo. */
  logo: string | null;
}

/**
 * The Clients page: find a client and open its dashboard. Grid (default) or
 * list, filtered as you type; the chosen layout is remembered in a cookie so
 * the server renders it straight away next time.
 */
export function ClientDirectory({ clients, initialLayout, actions }: { clients: DirectoryClient[]; initialLayout: DirectoryLayout; actions?: React.ReactNode }) {
  const [q, setQ] = useState("");
  const [layout, setLayout] = useState<DirectoryLayout>(initialLayout);
  const shown = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return needle ? clients.filter((c) => c.name.toLocaleLowerCase().includes(needle)) : clients;
  }, [clients, q]);

  const choose = (l: DirectoryLayout) => {
    setLayout(l);
    document.cookie = `${CLIENTS_VIEW_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-full sm:w-72">
          <span className="sr-only">Search clients</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-3" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search clients..."
            className="h-9 w-full rounded-lg border border-border bg-surface pr-3 pl-9 text-sm text-text placeholder:text-text-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </label>
        <div role="group" aria-label="Layout" className="inline-flex rounded-lg bg-track/50 p-0.5">
          {(["grid", "list"] as const).map((l) => {
            const Icon = l === "grid" ? LayoutGrid : List;
            return (
              <button
                key={l}
                type="button"
                aria-pressed={layout === l}
                aria-label={l === "grid" ? "Grid view" : "List view"}
                title={l === "grid" ? "Grid view" : "List view"}
                onClick={() => choose(l)}
                className={cn(
                  "inline-flex h-8 w-9 cursor-pointer items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  layout === l ? "bg-surface text-text shadow-sm" : "text-text-2 hover:text-text",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </button>
            );
          })}
        </div>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-5 py-10 text-center text-sm text-text-3">{clients.length === 0 ? "No clients yet." : "No clients found"}</p>
      ) : layout === "grid" ? (
        <ul className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {shown.map((c) => (
            <li key={c.id}>
              <Link
                {...loadOnHover}
                href={`/clients/${c.id}`}
                className="flex h-28 flex-col items-center justify-center gap-2.5 rounded-xl sm:h-32 border border-border bg-surface px-4 text-center transition hover:border-text-3/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                {c.logo ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.logo} alt="" loading="lazy" decoding="async" className="h-12 max-w-[85%] object-contain" />
                    <span className="line-clamp-2 text-sm font-medium leading-snug text-text">{c.name}</span>
                  </>
                ) : (
                  <span className="line-clamp-3 text-base font-semibold leading-snug text-text">{c.name}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {shown.map((c) => (
            <li key={c.id}>
              <Link
                {...loadOnHover}
                href={`/clients/${c.id}`}
                className="flex min-h-12 items-center gap-3 px-4 py-2 hover:bg-surface-2/70 focus-visible:bg-surface-2/70 focus-visible:outline-none sm:px-5"
              >
                <span className="flex h-7 w-14 shrink-0 items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {c.logo && <img src={c.logo} alt="" loading="lazy" decoding="async" className="max-h-7 max-w-14 object-contain" />}
                </span>
                <span className="min-w-0 truncate text-sm font-medium text-text">{c.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
