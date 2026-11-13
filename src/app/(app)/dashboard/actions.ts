"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireAdmin } from "@/server/access";

/** Hides the setup checklist on Clients and the agency overview for everyone in the agency. */
export async function dismissSetupChecklist(): Promise<void> {
  const admin = await requireAdmin();
  await prisma.agency.update({ where: { id: admin.agencyId }, data: { setupChecklistDismissedAt: new Date() } });
  revalidatePath("/dashboard");
  revalidatePath("/clients");
}
