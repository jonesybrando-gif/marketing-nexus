import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth";
import { visibleClientsWhere } from "@/server/access";

/**
 * A client's logo as an image, so lists of clients don't carry every inline
 * logo in their HTML. Uploaded logos are stored as data URLs; linked ones
 * (https) redirect. The ?v= the directory adds changes whenever the logo does,
 * so the browser can keep it cached.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const client = await prisma.client.findFirst({ where: { ...visibleClientsWhere(user), id }, select: { logoUrl: true } });
  const logo = client?.logoUrl;
  if (!logo) return new Response(null, { status: 404 });
  if (logo.startsWith("https://")) return Response.redirect(logo, 302);
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(logo);
  if (!m) return new Response(null, { status: 404 });
  return new Response(Buffer.from(m[2], "base64"), {
    headers: { "Content-Type": m[1], "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  });
}
