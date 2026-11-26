import { getCurrentUser } from "@/server/auth";
import { searchLocations } from "@/server/data-sources/dataforseo/locations";

export const dynamic = "force-dynamic";

/** Type-ahead for rank tracking locations: GET ?q=dublin&country=US (agency staff only). */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.role === "CLIENT_USER") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const country = url.searchParams.get("country") ?? "US";
  try {
    return Response.json({ locations: await searchLocations(user.agencyId, q, country) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ locations: [], error: (e as Error).message.slice(0, 200) }, { status: 200 });
  }
}
