import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

// Coarse gate: unauthenticated requests go to /login. Fine-grained role and
// client checks happen server-side in every page and action (src/server/access.ts).
export async function middleware(req: NextRequest) {
  const token = req.cookies.get("pm_session")?.value;
  if (token && process.env.AUTH_SECRET) {
    try {
      await jwtVerify(token, new TextEncoder().encode(process.env.AUTH_SECRET));
      return NextResponse.next();
    } catch {
      /* fall through */
    }
  }
  // Behind a proxy the request URL can be the internal address, so prefer APP_URL.
  const url = process.env.APP_URL ? new URL("/login", process.env.APP_URL) : req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // r/ = shared report links (token-checked in the page and route themselves).
  // api/mcp/ = read-only MCP connector (checks MCP_SECRET itself).
  matcher: ["/((?!$|privacy|terms|robots.txt|sitemap.xml|setup|login|accept-invite|reset-password|forgot-password|api/cron|api/mcp/|api/summary-status|r/|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png).*)"],
};
