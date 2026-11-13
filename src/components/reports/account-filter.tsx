"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { PLATFORM_LABEL, type PlatformKey } from "@/lib/platforms";
import { cn } from "@/components/ui/cn";

/**
 * Which paid media accounts the report adds up: all by default. Small and
 * optional; the choice is kept in the URL (?accounts=) so tiles, charts,
 * comparisons and the summary all follow it, and so it can be shared.
 */
export function AccountFilter({ accounts, selected }: { accounts: { id: string; name: string; platform: string; currency: string }[]; selected: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  if (accounts.length < 2) return null;
  const value = selected.length === 1 ? selected[0] : selected.length > 1 ? "__many" : "";
  const label = (a: (typeof accounts)[number]) => `${PLATFORM_LABEL[a.platform as PlatformKey] ?? a.platform} · ${a.name}`;
  return (
    <label className="flex min-w-0 items-center gap-2 text-xs text-text-2">
      <span className="sr-only">Ad accounts in this report</span>
      <select
        value={value}
        disabled={pending}
        onChange={(e) => {
          const q = new URLSearchParams(sp.toString());
          q.delete("edit");
          if (e.target.value) q.set("accounts", e.target.value);
          else q.delete("accounts");
          start(() => router.push(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }));
        }}
        className={cn("h-8 max-w-72 truncate rounded-md border border-border bg-surface px-2 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring", pending && "opacity-60")}
      >
        <option value="">All paid media accounts</option>
        {value === "__many" && <option value="__many">{selected.length} accounts selected</option>}
        {accounts.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
      </select>
    </label>
  );
}
