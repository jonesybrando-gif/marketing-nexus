"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";

/**
 * A card with a clickable header that shows or hides its content. Each
 * viewer's open/closed choice is remembered in this browser (per storageKey);
 * without storage it simply starts in its default state. Used for the AI
 * Executive Summary, Performance Trends and Budget History.
 */
export function CollapsibleSection({
  storageKey,
  title,
  icon,
  hint,
  marker,
  actions,
  defaultOpen = true,
  children,
}: {
  storageKey: string;
  title: string;
  icon?: ReactNode;
  hint?: string;
  marker?: ReactNode;
  /** Shown in the header while open (buttons, toggles). */
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const key = `mn:disclosure:${storageKey}`;
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(key);
      if (v === "open") setOpen(true);
      if (v === "closed") setOpen(false);
    } catch {
      // Storage blocked: keep the default.
    }
  }, [key]);
  const toggle = () =>
    setOpen((o) => {
      try {
        window.localStorage.setItem(key, o ? "closed" : "open");
      } catch {
        // Not remembered; still toggles.
      }
      return !o;
    });
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5">
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} className="flex min-w-0 cursor-pointer items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
          {icon}
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold">{title}</span>
            {hint && !open && <span className="truncate text-xs text-text-3">{hint}</span>}
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-text-3 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} aria-hidden />
        </button>
        {marker}
        {open && actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div id={id} hidden={!open} className="border-t border-border px-4 pt-3 pb-4">
        {children}
      </div>
    </section>
  );
}
