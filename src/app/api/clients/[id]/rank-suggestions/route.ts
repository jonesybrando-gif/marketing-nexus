import { requireClientEdit } from "@/server/access";
import { clientRankProject } from "@/server/data-sources/dataforseo/projects";
import { rankSuggestions } from "@/server/metrics/rank-suggestions";
import { readRankSettings } from "@/lib/rankings";

export const dynamic = "force-dynamic";

/**
 * Search Console keyword suggestions for a client's rank tracking, each with a
 * suggested location. Loaded after the Rankings page renders, since the first
 * call may load DataForSEO's US locations list.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireClientEdit(id);
  const asset = await clientRankProject(id);
  const s = readRankSettings(asset?.settings);
  try {
    return Response.json(await rankSuggestions(id, user.agencyId, { code: s.locationCode, name: s.locationName ?? "United States" }), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ hasSearchConsole: false, suggestions: [], marketCities: [], error: (e as Error).message.slice(0, 200) });
  }
}
