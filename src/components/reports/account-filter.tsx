"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Check, ChevronDown } from "lucide-react";
import { PLATFORM_LABEL, type PlatformKey } from "@/lib/platforms";
import { PLATFORM_DOT } from "@/components/platform-badge";
import { cn } from "@/components/ui/cn";

export interface SelectorAccount {
  id: string;
  name: string;
  platform: string;
  currency: string;
}

/**
 * Which paid media accounts the client page adds up: all by default, or one
 * account. A compact dropdown showing each account's platform and name. The
 * choice lives in the URL (?accounts=), so every tab's figures, comparisons,
 * the AI summary and exports follow it, and it can be shared.
 */
export function AccountSelector({ accounts, selected, size = "sm" }: { accounts: SelectorAccount[]; selected: string[]; size?: "sm" | "md" }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  if (accounts.length < 2) return null;

  const current = selected.length === 1 ? accounts.find((a) => a.id === selected[0]) : null;
  const label = current ? current.name : selected.length > 1 ? `${selected.length} accounts` : "All accounts";
  const choose = (id: string | null) => {
    setOpen(false);
    const q = new URLSearchParams(sp.toString());
    q.delete("edit");
    if (id) q.set("accounts", id);
    else q.delete("accounts");
    start(() => router.push(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }));
  };
  const dot = (p: string) => <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PLATFORM_DOT[p as PlatformKey] ?? "var(--text-3)" }} aria-hidden />;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Ad accounts: ${label}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex max-w-80 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
          size === "md" ? "h-9 px-3 text-sm" : "h-8 px-2.5 text-xs",
          pending && "opacity-60",
        )}
      >
        {current ? dot(current.platform) : <span className="flex -space-x-0.5" aria-hidden>{[...new Set(accounts.map((a) => a.platform))].slice(0, 3).map((p) => <span key={p}>{dot(p)}</span>)}</span>}
        <span className="truncate font-medium">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
      </button>
      {open && (
        <ul role="listbox" aria-label="Ad accounts" className="absolute left-0 z-40 mt-1 max-h-80 w-max max-w-sm min-w-56 overflow-auto rounded-lg border border-border bg-surface p-1 shadow-lg">
          <Option selected={!current && selected.length === 0} onPick={() => choose(null)}>
            <span className="font-medium">All accounts</span>
            <span className="text-text-3">({accounts.length})</span>
          </Option>
          {accounts.map((a) => (
            <Option key={a.id} selected={current?.id === a.id} onPick={() => choose(a.id)}>
              {dot(a.platform)}
              <span className="min-w-0">
                <span className="block truncate">{a.name}</span>
                <span className="block text-xs text-text-3">{PLATFORM_LABEL[a.platform as PlatformKey] ?? a.platform}{a.currency ? ` · ${a.currency}` : ""}</span>
              </span>
            </Option>
          ))}
        </ul>
      )}
    </div>
  );
}

function Option({ selected, onPick, children }: { selected: boolean; onPick: () => void; children: React.ReactNode }) {
  return (
    <li role="option" aria-selected={selected}>
      <button type="button" onClick={onPick} className={cn("flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none", selected && "bg-surface-2")}>
        <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
        {selected && <Check className="h-3.5 w-3.5 shrink-0 text-brand-text" aria-hidden />}
      </button>
    </li>
  );
}

/** Older name, kept for existing imports. */
export const AccountFilter = AccountSelector;
