"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BarChart3, Bell, Building2, FileText, Gauge, Home, Menu as MenuIcon, Plug, Settings, Sparkles, X } from "lucide-react";
import { cn } from "./ui/cn";
import { LinkPending } from "./link-pending";
import { loadOnHover } from "@/lib/link-hover";

const ICONS = { home: Home, clients: Building2, reports: BarChart3, report: FileText, insights: Sparkles, pacing: Gauge, alerts: Bell, integrations: Plug, settings: Settings } as const;

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  /** Unread count shown as a badge (alerts). */
  count?: number;
  /** Other path prefixes that belong to this section (e.g. /integrations under Settings). */
  match?: string[];
}

/** Is `href` the current section? Prefix match, so /clients/abc/budgets highlights Clients. */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Sidebar / drawer links with a clear current-page state. */
export function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname() ?? "";
  // The most specific match wins (a client login's /clients/<id> over nothing else).
  const hit = (i: NavItem) => [i.href, ...(i.match ?? [])].some((h) => isActive(pathname, h));
  const current = items.filter(hit).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map(({ href, label, icon, count = 0 }) => {
        const Icon = ICONS[icon];
        const active = href === current;
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              {...loadOnHover}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60",
                active ? "bg-surface-2 font-semibold text-text shadow-[inset_0_0_0_1px_var(--border)]" : "text-text-2 hover:bg-surface-2 hover:text-text",
              )}
            >
              <Icon className={cn("h-4 w-4 shrink-0", active && "text-brand-text")} aria-hidden />
              {label}
              <LinkPending />
              {count > 0 && (
                <span className="ml-auto text-xs font-semibold text-text-2 tabular">
                  <span aria-hidden>{count > 99 ? "99+" : count}</span>
                  <span className="sr-only">, {count} unread</span>
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Phones (below md): a compact sticky top bar with the agency, a search
 * button and a menu button that opens a drawer with the navigation and the
 * account. The drawer traps focus, closes on Escape, on navigation and on the
 * backdrop, and locks page scrolling while open.
 */
export function MobileShell({ brand, search, nav, account }: { brand: ReactNode; search?: ReactNode; nav: NavItem[]; account: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panel = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  // Close when the route changes (a link in the drawer was followed).
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const opener = menuButton.current;
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const els = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    // Widening past the phone layout hides the drawer: close it so the page can scroll again.
    const wide = window.matchMedia("(min-width: 768px)");
    const onWide = () => wide.matches && setOpen(false);
    wide.addEventListener("change", onWide);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
      opener?.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <>
      {/* A direct child of the page root, so it stays stuck for the whole page. */}
      <header className="sticky top-0 z-40 flex h-12 md:hidden items-center gap-1 border-b border-border bg-surface/95 px-2 backdrop-blur">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">{brand}</div>
        {search}
        <button
          ref={menuButton}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          aria-haspopup="dialog"
          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 cursor-pointer"
        >
          <MenuIcon className="h-5 w-5" aria-hidden />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-50 flex md:hidden" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="absolute inset-0 bg-black/40" aria-hidden onMouseDown={() => setOpen(false)} />
          <div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="relative ml-auto flex h-full w-[min(18rem,85vw)] flex-col overflow-y-auto border-l border-border bg-surface shadow-2xl"
          >
            <div className="flex h-12 items-center justify-between border-b border-border pl-4 pr-2">
              <span className="text-sm font-semibold">Menu</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 cursor-pointer"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <nav aria-label="Main" className="flex-1 p-2">
              <NavLinks items={nav} onNavigate={() => setOpen(false)} />
            </nav>
            <div className="border-t border-border p-2">{account}</div>
          </div>
        </div>
      )}
    </>
  );
}
