import "server-only";
import { timingSafeEqual } from "node:crypto";

/** Minimum length for MCP_SECRET; shorter values leave the connector switched off. */
export const MCP_SECRET_MIN_LENGTH = 32;

/**
 * The connector URL carries the secret as its last path segment
 * (/api/mcp/<MCP_SECRET>), because Claude custom connectors can't send a
 * custom header. A Bearer header with the same secret is also accepted.
 * Returns false (connector off) when MCP_SECRET is unset or too short.
 */
export function mcpAuthorized(pathSecret: string | null, authorizationHeader: string | null): boolean {
  const secret = process.env.MCP_SECRET;
  if (!secret || secret.length < MCP_SECRET_MIN_LENGTH) return false;
  const expected = Buffer.from(secret);
  const candidates = [pathSecret, authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.slice(7) : null];
  return candidates.some((c) => {
    if (!c) return false;
    const got = Buffer.from(c);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
