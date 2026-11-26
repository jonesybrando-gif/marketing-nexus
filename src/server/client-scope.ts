import "server-only";
import type { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/access";

// Which clients a user may see, as a Prisma filter. Kept apart from ./access.ts
// (which imports next/navigation for its page guards) so jobs that run outside
// Next, such as `npm run alerts`, can use it without loading Next's client code.

/** Prisma filter for the clients a user may see. Mirrors canViewClient. */
export function visibleClientsWhere(user: SessionUser): Prisma.ClientWhereInput {
  const base: Prisma.ClientWhereInput = { agencyId: user.agencyId, archivedAt: null };
  switch (user.role) {
    case "AGENCY_ADMIN":
      return base;
    case "ACCOUNT_MANAGER":
      return { ...base, OR: [{ primaryManagerId: user.id }, { assignments: { some: { userId: user.id } } }] };
    case "CLIENT_USER":
      return { ...base, id: user.clientId ?? "__none__" };
  }
}
