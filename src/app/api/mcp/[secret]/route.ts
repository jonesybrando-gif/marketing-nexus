import { NextResponse, type NextRequest } from "next/server";
import { mcpAuthorized } from "@/server/mcp/auth";
import { handleMcpMessage } from "@/server/mcp/protocol";
import { connectorInstructions, connectorTools } from "@/server/mcp";

// MCP connector (Streamable HTTP, stateless, JSON responses). Read tools plus
// write tools for Marketing Nexus's own records; MCP_READ_ONLY=true turns the
// write tools off. Connector URL: <APP_URL>/api/mcp/<MCP_SECRET>. Off until
// MCP_SECRET is set. See docs/mcp-connector.md.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ secret: string }> };

const NO_STORE = { "Cache-Control": "no-store" };

async function authorized(req: NextRequest, ctx: Ctx) {
  const { secret } = await ctx.params;
  return mcpAuthorized(secret, req.headers.get("authorization"));
}

export async function POST(req: NextRequest, ctx: Ctx) {
  // Same response for a wrong secret and a switched-off connector, so the URL can't be probed.
  if (!(await authorized(req, ctx))) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: NO_STORE });
  }
  const res = await handleMcpMessage(body, connectorTools(), "marketing-nexus", connectorInstructions());
  if (res === null) return new NextResponse(null, { status: 202, headers: NO_STORE });
  return NextResponse.json(res, { headers: NO_STORE });
}

// Stateless server: no server-initiated stream and no sessions to end.
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!(await authorized(req, ctx))) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  return new NextResponse(null, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  if (!(await authorized(req, ctx))) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  return new NextResponse(null, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}
