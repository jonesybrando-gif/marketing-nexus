"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireClientEdit } from "@/server/access";
import { syncDataAsset } from "@/server/data-sources/sync";
import { agencyDataForSeoConnection } from "@/server/data-sources/dataforseo/account";
import { findLocation } from "@/server/data-sources/dataforseo/locations";
import {
  addTrackedItems, archiveItems, clientRankProject, deleteItems, mergeRankSettings, moveTrackedItems, setItemsPaused, setProjectDomain, type AddItemsResult,
} from "@/server/data-sources/dataforseo/projects";
import {
  DEFAULT_LOCATION_CODE, DEFAULT_LOCATION_NAME, devicesFor, MAX_KEYWORDS_PER_CLIENT, normalizeDomain, parseKeywordList, type RankDeviceSetting,
} from "@/lib/rankings";

export type RankFormState = { ok?: string; errors?: string[]; n?: number } | undefined;

/** Run a rank sync after the response (posts today's checks for new items). */
function syncSoon(assetId: string) {
  after(async () => {
    await syncDataAsset(assetId).catch(() => undefined);
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function readDevice(v: FormDataEntryValue | null, fallback: RankDeviceSetting = "mobile"): RankDeviceSetting {
  const d = String(v ?? "");
  return d === "desktop" || d === "mobile" || d === "both" ? d : fallback;
}

/**
 * Location from the picker's hidden fields. The code must be a DataForSEO
 * location code; the name is taken from our cached list when we have it, so a
 * tampered name can't be stored.
 */
async function readLocation(form: FormData, prefix = ""): Promise<{ code: number; name: string } | { error: string }> {
  const code = Number(form.get(`${prefix}locationCode`));
  if (!Number.isInteger(code) || code < 1000 || code > 99_999_999) return { error: "Choose a location from the list (or type a DataForSEO location code)." };
  const known = await findLocation(code);
  const typed = String(form.get(`${prefix}locationName`) ?? "").trim().slice(0, 200);
  const name = known?.name ?? (code === DEFAULT_LOCATION_CODE ? DEFAULT_LOCATION_NAME : typed || `Location ${code}`);
  return { code, name };
}

/** Create or update the client's rank tracking defaults: domain, default location and default device. */
export async function saveRankProject(clientId: string, _prev: RankFormState, form: FormData): Promise<RankFormState> {
  const user = await requireClientEdit(clientId);
  const domain = normalizeDomain(String(form.get("domain") ?? ""));
  if (!domain) return { errors: ["Enter the website's domain, e.g. example.com."] };
  const loc = await readLocation(form);
  if ("error" in loc) return { errors: [loc.error] };
  const device = readDevice(form.get("device"));
  const languageCode = /^[a-z]{2}(-[a-z]{2,4})?$/i.test(String(form.get("language") ?? "")) ? String(form.get("language")).toLowerCase() : "en";

  const connection = await agencyDataForSeoConnection(user.agencyId);
  if (!connection) return { errors: ["DataForSEO isn't connected. An administrator can connect it in Settings › Connections."] };
  const next = { locationCode: loc.code, locationName: loc.name, languageCode, device, searchEngine: "google" as const };
  const existing = await clientRankProject(clientId);
  const asset = existing
    ? await prisma.dataAsset.update({
        where: { id: existing.id },
        data: { externalId: domain, name: `Rankings: ${domain}`, connectionId: connection.id, settings: mergeRankSettings(existing.settings, next) },
      })
    : await prisma.dataAsset.create({
        data: { clientId, kind: "RANK_PROJECT", externalId: domain, name: `Rankings: ${domain}`, connectionId: connection.id, settings: next },
      });
  if (existing && existing.externalId !== domain) await setProjectDomain(asset.id, domain);
  revalidatePath(`/clients/${clientId}/rankings`);
  return { ok: existing ? "Saved. The defaults apply to keywords you add from now on." : "Rank tracking is set up. Add keywords below." };
}

function addMessage(r: AddItemsResult, location: string): string {
  const parts = [];
  if (r.added + r.revived) parts.push(`Tracking ${plural(r.added + r.revived, "new item")} in ${location}; first positions appear within an hour or two.`);
  if (r.already) parts.push(`${plural(r.already, "item")} already tracked there.`);
  if (r.skipped) parts.push(`${plural(r.skipped, "item")} not added: the limit is ${MAX_KEYWORDS_PER_CLIENT} tracked items per client.`);
  return parts.join(" ") || "Nothing to add.";
}

/** Add keywords (one per line) at the chosen location and device. "Both" devices = two items per keyword. */
export async function addKeywords(clientId: string, prev: RankFormState, form: FormData): Promise<RankFormState> {
  await requireClientEdit(clientId);
  const asset = await clientRankProject(clientId);
  if (!asset) return { errors: ["Set up the website domain first."] };
  const keywords = parseKeywordList(String(form.get("keywords") ?? ""));
  if (!keywords.length) return { errors: ["Enter at least one keyword, one per line."] };
  const loc = await readLocation(form);
  if ("error" in loc) return { errors: [loc.error] };
  const device = readDevice(form.get("device"));
  const r = await addTrackedItems(asset, keywords, loc, devicesFor(device));
  if (r.added + r.revived) syncSoon(asset.id);
  revalidatePath(`/clients/${clientId}/rankings`);
  const ok = addMessage(r, loc.name);
  return r.added + r.revived === 0 && r.skipped ? { errors: [ok] } : { ok, n: (prev?.n ?? 0) + 1 };
}

/** One-click add of a Search Console suggestion at its suggested location (client default device). */
export async function addSuggestion(clientId: string, keyword: string, locationCode: number): Promise<RankFormState> {
  await requireClientEdit(clientId);
  const asset = await clientRankProject(clientId);
  if (!asset) return { errors: ["Set up the website domain first."] };
  const [k] = parseKeywordList(keyword);
  if (!k) return { errors: ["That keyword can't be tracked."] };
  const form = new FormData();
  form.set("locationCode", String(locationCode));
  const loc = await readLocation(form);
  if ("error" in loc) return { errors: [loc.error] };
  const settings = (asset.settings ?? {}) as { device?: unknown };
  const r = await addTrackedItems(asset, [k], loc, devicesFor(readDevice(settings.device as string)));
  if (r.added + r.revived) syncSoon(asset.id);
  revalidatePath(`/clients/${clientId}/rankings`);
  return r.skipped && !(r.added + r.revived) ? { errors: [addMessage(r, loc.name)] } : { ok: `Added “${k}” in ${loc.name}.` };
}

export type BulkOp = "pause" | "resume" | "archive" | "restore" | "delete" | "move";

/**
 * Bulk actions on selected items (ids). "move" changes location and/or device:
 * the new combinations are created (or revived) and the originals archived,
 * keeping their history.
 */
export async function bulkKeywordAction(clientId: string, _prev: RankFormState, form: FormData): Promise<RankFormState> {
  await requireClientEdit(clientId);
  const asset = await clientRankProject(clientId);
  if (!asset) return { errors: ["Rank tracking isn't set up."] };
  const ids = form.getAll("ids").map(String).filter((x) => /^[a-z0-9]{10,40}$/i.test(x)).slice(0, 1000);
  const op = String(form.get("op") ?? "") as BulkOp;
  if (!ids.length) return { errors: ["Select at least one keyword."] };
  let ok: string;
  switch (op) {
    case "pause":
      ok = `Paused ${plural(await setItemsPaused(asset.id, ids, true), "item")}.`;
      break;
    case "resume":
    case "restore": {
      const n = await setItemsPaused(asset.id, ids, false);
      if (n) syncSoon(asset.id);
      ok = n < ids.length ? `Resumed ${plural(n, "item")}; the rest would go over the limit of ${MAX_KEYWORDS_PER_CLIENT} tracked items.` : `Resumed ${plural(n, "item")}.`;
      break;
    }
    case "archive":
      ok = `Archived ${plural(await archiveItems(asset.id, ids), "item")}. Their history is kept.`;
      break;
    case "delete":
      ok = `Deleted ${plural(await deleteItems(asset.id, ids), "item")} and their history.`;
      break;
    case "move": {
      const changeLoc = form.get("changeLocation") === "1";
      const deviceSel = String(form.get("device") ?? "keep");
      let location: { code: number; name: string } | undefined;
      if (changeLoc) {
        const loc = await readLocation(form);
        if ("error" in loc) return { errors: [loc.error] };
        location = loc;
      }
      const devices = deviceSel === "keep" ? undefined : devicesFor(readDevice(deviceSel));
      if (!location && !devices) return { errors: ["Choose a new location or device."] };
      const r = await moveTrackedItems(asset, ids, { location, devices });
      if (r.added) syncSoon(asset.id);
      ok = `Updated ${plural(r.moved, "item")}; the old ones are archived with their history.${r.skipped ? ` ${plural(r.skipped, "item")} not added: the limit is ${MAX_KEYWORDS_PER_CLIENT} tracked items.` : ""}`;
      break;
    }
    default:
      return { errors: ["Unknown action."] };
  }
  revalidatePath(`/clients/${clientId}/rankings`);
  return { ok };
}

/** Pause or resume daily checks for the client's whole project. */
export async function setRankProjectPaused(clientId: string, paused: boolean): Promise<void> {
  await requireClientEdit(clientId);
  const asset = await clientRankProject(clientId);
  if (!asset) return;
  await prisma.dataAsset.update({ where: { id: asset.id }, data: { status: paused ? "DISCONNECTED" : "ACTIVE" } });
  if (!paused) syncSoon(asset.id);
  revalidatePath(`/clients/${clientId}/rankings`);
}
