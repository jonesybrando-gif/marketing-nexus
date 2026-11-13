"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/server/db";
import { logoUrlSchema } from "@/lib/logo";
import { requireAdmin } from "@/server/access";
import { archiveClient, bulkLabel, ClientAdminError, findOrCreateLabel, createLabel, deleteClientPermanently, deleteLabel, restoreClient, setClientLabels } from "@/server/client-admin";

export type ClientFormState = { errors?: string[] } | undefined;

const schema = z.object({
  name: z.string().trim().min(1, "Enter a client name").max(120),
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid timezone"),
  managerId: z.string().optional(),
  logoUrl: logoUrlSchema.optional(),
});

export async function createClient(_prev: ClientFormState, form: FormData): Promise<ClientFormState> {
  const user = await requireAdmin();
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => i.message) };
  const managerId = parsed.data.managerId
    ? (await prisma.user.findFirst({ where: { id: parsed.data.managerId, agencyId: user.agencyId, role: "ACCOUNT_MANAGER" } }))?.id ?? null
    : null;
  const client = await prisma.client.create({
    data: {
      agencyId: user.agencyId,
      name: parsed.data.name,
      timezone: parsed.data.timezone,
      primaryManagerId: managerId,
      logoUrl: parsed.data.logoUrl || null,
      assignments: managerId ? { create: [{ userId: managerId }] } : undefined,
    },
  });
  revalidatePath("/clients");
  redirect(`/clients/${client.id}`);
}

// --- Removing clients and labels -------------------------------------------

function back(notice: { notice?: string; error?: string }, view?: string, keep = ""): never {
  // Keep the list's search, filter, sort and grouping when they came with the form.
  const q = new URLSearchParams(/^[\w=&%.+-]*$/.test(keep) ? keep : "");
  q.delete("notice");
  q.delete("error");
  q.set("view", view ?? "manage");
  if (notice.notice) q.set("notice", notice.notice);
  if (notice.error) q.set("error", notice.error);
  revalidatePath("/", "layout");
  redirect(`/clients?${q}`);
}

async function run(fn: (agencyId: string) => Promise<string>, view?: string, keep?: string): Promise<never> {
  const user = await requireAdmin();
  let message: string;
  try {
    message = await fn(user.agencyId);
  } catch (e) {
    if (e instanceof ClientAdminError) back({ error: e.message }, view, keep);
    throw e;
  }
  back({ notice: message }, view, keep);
}

export async function removeClientAction(clientId: string): Promise<void> {
  await run(async (agencyId) => `${await archiveClient(agencyId, clientId)} was removed. You can restore it from Removed clients.`);
}

export async function restoreClientAction(clientId: string): Promise<void> {
  await run(async (agencyId) => `${await restoreClient(agencyId, clientId)} was restored. Link its ad accounts again under Ad accounts.`, "removed");
}

export async function deleteClientAction(clientId: string): Promise<void> {
  await run(async (agencyId) => `${await deleteClientPermanently(agencyId, clientId)} and all its data were deleted.`, "removed");
}

export async function createLabelAction(form: FormData): Promise<void> {
  await run(async (agencyId) => `Label “${(await createLabel(agencyId, String(form.get("name") ?? ""), String(form.get("color") ?? "neutral"))).name}” created.`);
}

export async function deleteLabelAction(labelId: string): Promise<void> {
  await run(async (agencyId) => {
    await deleteLabel(agencyId, labelId);
    return "Label deleted. Clients that had it keep everything else.";
  });
}

export async function setClientLabelsAction(clientId: string, form: FormData): Promise<void> {
  const user = await requireAdmin();
  await setClientLabels(user.agencyId, clientId, form.getAll("label").map(String));
  revalidatePath("/", "layout");
}

export async function bulkLabelAction(form: FormData): Promise<void> {
  const mode = form.get("mode") === "remove" ? "remove" : "add";
  const keep = String(form.get("return") ?? "");
  await run(async (agencyId) => {
    // "New label…" in the bar creates the label (or reuses one with that name) before applying it.
    let labelId = String(form.get("label") ?? "");
    if (labelId === "__new__") {
      if (mode === "remove") throw new ClientAdminError("Choose an existing label to remove.");
      if (!form.getAll("client").length) throw new ClientAdminError("Select at least one client.");
      labelId = await findOrCreateLabel(agencyId, String(form.get("newLabel") ?? ""));
    }
    const { label, changed } = await bulkLabel(agencyId, labelId, form.getAll("client").map(String), mode);
    const n = `${changed} client${changed === 1 ? "" : "s"}`;
    return mode === "add" ? `Added “${label}” to ${n}.` : `Removed “${label}” from ${n}.`;
  }, undefined, keep);
}
