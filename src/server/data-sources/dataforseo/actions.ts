"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireAdmin } from "@/server/access";
import { storeDataSourceSecret } from "../credentials";
import { DataForSeoError, getUserData } from "./api";
import { agencyDataForSeoConnection, formatUsd } from "./account";

export type DataForSeoFormState = { ok?: string; errors?: string[] } | undefined;

/** Admin only: validate a DataForSEO API login/password with /appendix/user_data and store it encrypted. */
export async function connectDataForSeo(_prev: DataForSeoFormState, form: FormData): Promise<DataForSeoFormState> {
  const user = await requireAdmin();
  const login = String(form.get("login") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!login || login.length > 200) return { errors: ["Enter the API login shown under API Access in DataForSEO (not your account email)."] };
  if (!password || password.length > 500) return { errors: ["Enter the API password."] };
  const secret = `${login}:${password}`;
  let info: { login: string; balance: number | null };
  try {
    info = await getUserData(secret);
  } catch (e) {
    return { errors: [e instanceof DataForSeoError ? e.message : "Could not validate the DataForSEO login."] };
  }
  const label = info.login || login;
  const existing = await prisma.dataSourceConnection.findFirst({ where: { agencyId: user.agencyId, provider: "DATAFORSEO" }, orderBy: { createdAt: "desc" } });
  const connection = existing
    ? await prisma.dataSourceConnection.update({ where: { id: existing.id }, data: { label, externalId: label } })
    : await prisma.dataSourceConnection.create({ data: { agencyId: user.agencyId, provider: "DATAFORSEO", label, externalId: label, createdById: user.id } });
  await storeDataSourceSecret(connection.id, secret);
  revalidatePath("/integrations");
  return { ok: `Connected as ${label}. Balance ${formatUsd(info.balance)}.` };
}

/** Admin only: stop rank checks and forget the stored password. Rank projects and history are kept. */
export async function disconnectDataForSeo(): Promise<void> {
  const user = await requireAdmin();
  const c = await agencyDataForSeoConnection(user.agencyId);
  if (!c) return;
  await prisma.dataSourceConnection.update({ where: { id: c.id }, data: { status: "DISCONNECTED", encryptedSecret: null, lastError: null } });
  revalidatePath("/integrations");
}

/** Admin only: the agency's monthly spending cap for Site Auditor crawls (USD). */
export async function setSiteAuditCap(_prev: DataForSeoFormState, form: FormData): Promise<DataForSeoFormState> {
  const user = await requireAdmin();
  const cap = Number(form.get("cap"));
  if (!Number.isFinite(cap) || cap < 0 || cap > 10_000) return { errors: ["Enter a monthly cap between $0 and $10,000."] };
  const rounded = Math.round(cap * 100) / 100;
  await prisma.agency.update({ where: { id: user.agencyId }, data: { siteAuditMonthlyCapUsd: rounded } });
  revalidatePath("/integrations");
  revalidatePath("/site-audits");
  return { ok: `Saved. New crawls are skipped once this month's site audit spend would pass ${formatUsd(rounded)}.` };
}
