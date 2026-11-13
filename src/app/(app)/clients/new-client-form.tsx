"use client";

import { useActionState, useState } from "react";
import { createClient } from "./actions";
import { useFormSubmit } from "@/components/use-form-submit";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { LogoInput } from "@/components/logo-input";

const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Australia/Sydney"];

export function NewClientForm({ managers }: { managers: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createClient, undefined);
  const form = useFormSubmit(action);
  const [logo, setLogo] = useState("");
  return (
    <form {...form} className="grid gap-3 sm:grid-cols-4">
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="name">Client name</Label>
        <Input id="name" name="name" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="timezone">Reporting timezone</Label>
        <Select id="timezone" name="timezone" defaultValue="America/New_York">
          {TIMEZONES.map((tz) => <option key={tz}>{tz}</option>)}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="managerId">Account manager</Label>
        <Select id="managerId" name="managerId" defaultValue="">
          <option value="">Unassigned</option>
          {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
      </div>
      <div className="sm:col-span-4">
        <LogoInput id="new-client-logo" name="logoUrl" label="Logo (optional)" value={logo} onChange={setLogo} />
      </div>
      <div className="flex items-center gap-3 sm:col-span-4">
        <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create client"}</Button>
        {state?.errors?.map((e) => <p key={e} className="text-sm text-critical-ink">{e}</p>)}
      </div>
    </form>
  );
}
