"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Platform } from "@prisma/client";
import { prisma } from "@/server/db";
import { requireAdmin } from "@/server/access";
import { getAdapter } from "@/server/integrations/registry";
import { withAccessToken } from "@/server/integrations/tokens";
import { IntegrationError } from "@/server/integrations/errors";
import { linkAccountToClient, removeStoppedAccount, stopTrackingAccount } from "@/server/client-accounts";
import { syncAccount } from "@/server/sync/sync-account";

export type PickState = { error?: string } | undefined;

/** Link the account chosen on a client's picker page (one per platform; replaces the previous one). The account may also be tracked by other clients. */
export async function linkClientAccountAction(clientId: string, connectionId: string, _prev: PickState, form: FormData): Promise<PickState> {
  const user = await requireAdmin();
  const [client, connection] = await Promise.all([
    prisma.client.findFirst({ where: { id: clientId, agencyId: user.agencyId }, select: { id: true } }),
    prisma.platformConnection.findFirst({ where: { id: connectionId, agencyId: user.agencyId, status: { not: "DISCONNECTED" } } }),
  ]);
  if (!client || !connection) return { error: "That client or connection no longer exists." };
  const externalId = String(form.get("account") ?? "");
  if (!externalId) return { error: "Choose an account." };
  const adapter = getAdapter(connection.platform);
  let remote;
  try {
    // Re-list so only accounts this login can actually reach are accepted.
    remote = (await withAccessToken(connection.id, adapter, (t) => adapter.listAccounts(t))).find((a) => a.externalId === externalId && !a.isManager);
  } catch (e) {
    return { error: e instanceof IntegrationError ? e.message : "Could not load accounts from the platform." };
  }
  if (!remote) return { error: "That account isn't available to this login any more." };
  const platforms: Platform[] =
    connection.platform === "GOOGLE_ADS"
      ? [...(form.get("ads") === "on" ? (["GOOGLE_ADS"] as const) : []), ...(form.get("lsa") === "on" ? (["GOOGLE_LSA"] as const) : [])]
      : [connection.platform];
  if (platforms.length === 0) return { error: "Choose Google Ads, Local Services Ads, or both." };
  const result = await linkAccountToClient({ agencyId: user.agencyId, clientId, connectionId: connection.id, remote, platforms });
  if (!result.ok) return { error: result.error };
  // Import history after the response is sent.
  after(async () => {
    for (const id of result.accountIds) await syncAccount(id, "scheduled");
  });
  revalidatePath(`/clients/${clientId}`, "layout");
  revalidatePath("/dashboard");
  if (result.sharedWith.length) {
    // Shared account: its campaigns all start out left out, so send the admin
    // straight to choosing this client's campaigns.
    const notice = `Linked ${remote.name}, which is shared with ${result.sharedWith.join(", ")}. Every campaign starts out left out of this client's reports so nothing is counted twice. Add this client's campaigns below; they appear once the first sync finishes (refresh in a minute or two).`;
    redirect(`/clients/${clientId}/campaigns?notice=${encodeURIComponent(notice)}`);
  }
  redirect(`/clients/${clientId}/accounts?linked=${result.accountIds.length}&replaced=${result.replaced}`);
}

export async function stopTrackingAction(clientId: string, accountId: string): Promise<void> {
  const user = await requireAdmin();
  await stopTrackingAccount(user.agencyId, clientId, accountId);
  revalidatePath(`/clients/${clientId}`, "layout");
  revalidatePath("/dashboard");
}

export type RemoveState = { error?: string } | undefined;

/** Permanently remove an account this client already stopped tracking, with its stored history. */
export async function removeStoppedAccountAction(clientId: string, accountId: string, _prev: RemoveState): Promise<RemoveState> {
  const user = await requireAdmin();
  const result = await removeStoppedAccount(user.agencyId, clientId, accountId);
  if (!result.ok) return { error: result.error };
  revalidatePath(`/clients/${clientId}`, "layout");
  revalidatePath("/dashboard");
  return undefined;
}
