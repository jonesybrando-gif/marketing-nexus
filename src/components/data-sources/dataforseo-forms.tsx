"use client";

import { useActionState } from "react";
import { connectDataForSeo, disconnectDataForSeo, setSiteAuditCap } from "@/server/data-sources/dataforseo/actions";
import { useFormSubmit } from "@/components/use-form-submit";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/** API login + password form. The password is sent once, checked with DataForSEO, encrypted, and never shown again. */
export function DataForSeoConnectForm({ reconnect, defaultLogin }: { reconnect?: boolean; defaultLogin?: string }) {
  const [state, action, pending] = useActionState(connectDataForSeo, undefined);
  const form = useFormSubmit(action, state?.ok && state);
  const body = (
    <form {...form} className="flex flex-col gap-2" autoComplete="off">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="dfs-login">API login</Label>
          <Input id="dfs-login" name="login" type="text" autoComplete="off" spellCheck={false} aria-describedby="dfs-login-help" defaultValue={defaultLogin} required />
          <span id="dfs-login-help" className="text-xs text-text-3">Shown under API Access in DataForSEO (not your account email)</span>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="dfs-password">API password</Label>
          <Input id="dfs-password" name="password" type="password" autoComplete="new-password" required />
        </div>
      </div>
      <p className="text-xs text-text-3">Find both under API Access in your DataForSEO dashboard. The password is checked with DataForSEO, encrypted, and never shown again.</p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Checking…" : reconnect ? "Update login" : "Connect DataForSEO"}</Button>
        {state?.ok && <span className="text-good-ink" role="status">{state.ok}</span>}
        {state?.errors?.map((e) => <span key={e} className="text-critical-ink" role="alert">{e}</span>)}
      </div>
    </form>
  );
  if (!reconnect) return body;
  return (
    <details className="rounded-lg border border-border p-3 text-xs">
      <summary className="cursor-pointer font-medium text-text-2">Change API login</summary>
      <div className="mt-2">{body}</div>
    </details>
  );
}

export function DataForSeoDisconnectButton() {
  return (
    <form action={disconnectDataForSeo}>
      <Button type="submit" size="sm" variant="ghost" title="Stops daily rank checks and removes the stored password. Keywords and history are kept.">Disconnect</Button>
    </form>
  );
}

/** Admin: Site Auditor monthly spending cap. */
export function SiteAuditCapForm({ cap }: { cap: number }) {
  const [state, action, pending] = useActionState(setSiteAuditCap, undefined);
  const form = useFormSubmit(action);
  return (
    <form {...form} className="flex flex-wrap items-end gap-2 text-xs" aria-label="Site audit monthly cap">
      <div className="flex flex-col gap-1">
        <Label htmlFor="dfs-audit-cap">Site audit monthly cap (USD)</Label>
        <Input id="dfs-audit-cap" name="cap" type="number" min={0} max={10000} step={1} defaultValue={cap} className="w-32" required />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>{pending ? "Saving…" : "Save cap"}</Button>
      {state?.ok && <span className="text-good-ink" role="status">{state.ok}</span>}
      {state?.errors?.map((e) => <span key={e} className="text-critical-ink" role="alert">{e}</span>)}
    </form>
  );
}
