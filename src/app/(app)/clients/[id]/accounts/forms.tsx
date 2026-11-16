"use client";

import { useActionState, useState } from "react";
import { linkClientAccountAction, removeStoppedAccountAction } from "./actions";
import { useFormSubmit } from "@/components/use-form-submit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface PickRow {
  externalId: string;
  display: string;
  name: string;
  currency: string;
  timezone: string;
  isTestAccount: boolean;
  statusNote: string | null;
  /** Other clients this account is already live under (it can be shared). */
  linkedElsewhere: string | null;
  current: boolean;
}

export function AccountChoice({ clientId, connectionId, rows, google, defaultLsa }: { clientId: string; connectionId: string; rows: PickRow[]; google: boolean; defaultLsa: boolean }) {
  const [state, action, pending] = useActionState(linkClientAccountAction.bind(null, clientId, connectionId), undefined);
  const form = useFormSubmit(action);
  const [chosen, setChosen] = useState(rows.find((r) => r.current)?.externalId ?? (rows.length === 1 ? rows[0].externalId : ""));
  return (
    <form {...form} className="flex flex-col gap-4">
      <fieldset className="flex flex-col divide-y divide-border rounded-lg border border-border">
        <legend className="sr-only">Advertising account</legend>
        {rows.map((r) => (
          <label key={r.externalId} className="flex cursor-pointer items-start gap-3 px-4 py-3 text-sm hover:bg-surface-2">
            <input type="radio" name="account" value={r.externalId} checked={chosen === r.externalId} onChange={() => setChosen(r.externalId)} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium">
                {r.name} {r.isTestAccount && <Badge variant="info">Test account</Badge>} {r.current && <Badge variant="good">Linked now</Badge>}
              </span>
              <span className="text-xs text-text-3">{r.display} · {r.currency} · {r.timezone}</span>
              {r.statusNote && <span className="text-xs text-warning-ink">{r.statusNote}</span>}
              {r.linkedElsewhere && !r.current && <span className="text-xs text-text-3">Also tracked by {r.linkedElsewhere}. Linking shares it: you then choose which of its campaigns count for this client.</span>}
            </span>
          </label>
        ))}
      </fieldset>
      {google && (
        <fieldset className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <legend className="mb-1 text-xs font-medium text-text-2">Track from this account</legend>
          <label className="flex items-center gap-2"><input type="checkbox" name="ads" defaultChecked className="h-4 w-4 accent-[var(--brand)]" /> Google Ads campaigns</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="lsa" defaultChecked={defaultLsa} className="h-4 w-4 accent-[var(--brand)]" /> Local Services Ads</label>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !chosen}>{pending ? "Linking…" : "Link to this client"}</Button>
        {state?.error && <p className="text-sm text-critical-ink" role="alert">{state.error}</p>}
      </div>
      <p className="text-xs text-text-3">A client has one account per platform. Linking a different one replaces the current one, which stops syncing and keeps its history. One account can be shared by several clients, each counting only the campaigns chosen for it. About 13 months of history imports in the background.</p>
    </form>
  );
}

export function StopTrackingButton({ action }: { action: () => Promise<void> }) {
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm("Stop tracking this account? It stops syncing; its history stays in reports.")) e.preventDefault(); }}>
      <Button type="submit" variant="outline" size="sm">Stop tracking</Button>
    </form>
  );
}

export function RemoveAccountButton({ clientId, accountId, name }: { clientId: string; accountId: string; name: string }) {
  const [state, action, pending] = useActionState(removeStoppedAccountAction.bind(null, clientId, accountId), undefined);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Remove ${name} from this client? Its stored history is deleted, so past months will no longer include its spend. This can't be undone.`)) e.preventDefault();
      }}
      className="flex items-center gap-2"
    >
      {state?.error && <span className="text-xs text-critical-ink" role="alert">{state.error}</span>}
      <Button type="submit" variant="outline" size="sm" disabled={pending}>{pending ? "Removing…" : "Remove"}</Button>
    </form>
  );
}
