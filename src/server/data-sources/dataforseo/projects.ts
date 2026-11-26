import "server-only";
import type { DataAsset, Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { MAX_KEYWORDS_PER_CLIENT, type RankDevice, type RankProjectSettings } from "@/lib/rankings";

// Rank projects: one DataAsset (kind RANK_PROJECT) per client on the agency's
// DATAFORSEO connection. externalId = target domain; settings = the client's
// defaults (RankProjectSettings) plus the sync's pendingTasks/taskErrors.
//
// The unit of tracking is a TrackedKeyword row: keyword × location × device.
// "Both" devices are two rows. Rows are never repurposed: changing an item's
// location or device creates (or revives) the target row and archives the old
// one, so every combination keeps its own history.

export function clientRankProject(clientId: string): Promise<DataAsset | null> {
  return prisma.dataAsset.findFirst({ where: { clientId, kind: "RANK_PROJECT" }, orderBy: { createdAt: "asc" } });
}

/** Distinct keyword texts with at least one item that isn't archived. */
export async function activeKeywordTexts(assetId: string): Promise<string[]> {
  const rows = await prisma.trackedKeyword.findMany({ where: { assetId, archivedAt: null }, select: { keyword: true }, distinct: ["keyword"], orderBy: { keyword: "asc" } });
  return rows.map((r) => r.keyword);
}

/** Items checked daily (active, not paused or archived). */
export const activeItemCount = (assetId: string) => prisma.trackedKeyword.count({ where: { assetId, active: true } });

export interface ItemLocation { code: number; name: string }

export interface AddItemsResult {
  /** New rows created. */
  added: number;
  /** Paused or archived rows switched back on (their history continues). */
  revived: number;
  /** Already tracked and active. */
  already: number;
  /** Not added because the client is at MAX_KEYWORDS_PER_CLIENT. */
  skipped: number;
}

/**
 * Track `keywords` at `location` on each of `devices`. Existing combinations are
 * reactivated rather than duplicated (unique on asset, keyword, location, device).
 */
export async function addTrackedItems(
  asset: Pick<DataAsset, "id" | "clientId" | "externalId">,
  keywords: string[],
  location: ItemLocation,
  devices: RankDevice[],
  languageCode = "en",
): Promise<AddItemsResult> {
  const wanted = keywords.flatMap((keyword) => devices.map((device) => ({ keyword, device })));
  if (!wanted.length) return { added: 0, revived: 0, already: 0, skipped: 0 };
  const existing = await prisma.trackedKeyword.findMany({
    where: { assetId: asset.id, locationCode: location.code, keyword: { in: keywords }, device: { in: devices } },
    select: { id: true, keyword: true, device: true, active: true },
  });
  const byKey = new Map(existing.map((e) => [`${e.keyword}\u0000${e.device}`, e]));
  let room = MAX_KEYWORDS_PER_CLIENT - (await activeItemCount(asset.id));
  const create: Prisma.TrackedKeywordCreateManyInput[] = [];
  const revive: string[] = [];
  let already = 0;
  let skipped = 0;
  for (const w of wanted) {
    const e = byKey.get(`${w.keyword}\u0000${w.device}`);
    if (e?.active) { already++; continue; }
    if (room <= 0) { skipped++; continue; }
    room--;
    if (e) revive.push(e.id);
    else create.push({ assetId: asset.id, clientId: asset.clientId, keyword: w.keyword, locationCode: location.code, locationName: location.name, languageCode, device: w.device, targetDomain: asset.externalId, active: true });
  }
  await prisma.$transaction([
    prisma.trackedKeyword.updateMany({ where: { id: { in: revive } }, data: { active: true, archivedAt: null, locationName: location.name, targetDomain: asset.externalId } }),
    prisma.trackedKeyword.createMany({ data: create, skipDuplicates: true }),
  ]);
  return { added: create.length, revived: revive.length, already, skipped };
}

export interface MoveTarget {
  /** New location, or undefined to keep each item's own. */
  location?: ItemLocation;
  /** New device(s), or undefined to keep each item's own. */
  devices?: RankDevice[];
}

/**
 * Change location and/or device for selected items: the target combinations are
 * added (or revived) and the originals archived when they differ. History stays
 * with each original row.
 */
export async function moveTrackedItems(asset: Pick<DataAsset, "id" | "clientId" | "externalId">, ids: string[], target: MoveTarget): Promise<{ moved: number; added: number; skipped: number }> {
  const rows = await prisma.trackedKeyword.findMany({ where: { assetId: asset.id, id: { in: ids }, archivedAt: null } });
  let moved = 0, added = 0, skipped = 0;
  for (const r of rows) {
    const loc = target.location ?? { code: r.locationCode, name: r.locationName ?? "" };
    const devices = target.devices ?? [r.device === "mobile" ? "mobile" : "desktop"];
    const same = loc.code === r.locationCode && devices.length === 1 && devices[0] === r.device;
    if (same) continue;
    // Free the original's slot first so moving at the limit works.
    const keepsOriginal = loc.code === r.locationCode && devices.includes(r.device as RankDevice);
    if (!keepsOriginal) await prisma.trackedKeyword.update({ where: { id: r.id }, data: { active: false, archivedAt: new Date() } });
    const res = await addTrackedItems(asset, [r.keyword], { code: loc.code, name: loc.name || `Location ${loc.code}` }, devices, r.languageCode);
    added += res.added + res.revived;
    skipped += res.skipped;
    if (res.skipped && !keepsOriginal && res.added + res.revived === 0) {
      // Nothing could be created: put the original back rather than lose the item.
      await prisma.trackedKeyword.update({ where: { id: r.id }, data: { active: r.active, archivedAt: null } });
      continue;
    }
    moved++;
  }
  return { moved, added, skipped };
}

/** Pause (keep in the table, stop checks) or resume items. Resuming respects the per-client limit. */
export async function setItemsPaused(assetId: string, ids: string[], paused: boolean): Promise<number> {
  if (paused) {
    const r = await prisma.trackedKeyword.updateMany({ where: { assetId, id: { in: ids }, archivedAt: null }, data: { active: false } });
    return r.count;
  }
  const room = MAX_KEYWORDS_PER_CLIENT - (await activeItemCount(assetId));
  const toResume = (await prisma.trackedKeyword.findMany({ where: { assetId, id: { in: ids }, active: false }, select: { id: true }, orderBy: { createdAt: "asc" } })).slice(0, Math.max(0, room));
  const r = await prisma.trackedKeyword.updateMany({ where: { id: { in: toResume.map((x) => x.id) } }, data: { active: true, archivedAt: null } });
  return r.count;
}

/** Archive items: hidden from tables and reports, history kept, no checks. */
export async function archiveItems(assetId: string, ids: string[]): Promise<number> {
  const r = await prisma.trackedKeyword.updateMany({ where: { assetId, id: { in: ids } }, data: { active: false, archivedAt: new Date() } });
  return r.count;
}

/** Delete items and their rank history. */
export async function deleteItems(assetId: string, ids: string[]): Promise<number> {
  const r = await prisma.trackedKeyword.deleteMany({ where: { assetId, id: { in: ids } } });
  return r.count;
}

/** Keep every item's target domain in step with the project's. */
export async function setProjectDomain(assetId: string, domain: string) {
  await prisma.trackedKeyword.updateMany({ where: { assetId }, data: { targetDomain: domain } });
}

/** Settings JSON for a project, keeping the sync's bookkeeping fields. */
export function mergeRankSettings(current: unknown, next: RankProjectSettings): Prisma.InputJsonValue {
  const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  return { ...base, ...next } as Prisma.InputJsonValue;
}
