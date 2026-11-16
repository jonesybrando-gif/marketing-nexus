import "server-only";
import type { McpTool } from "./protocol";
import { MCP_TOOLS } from "./tools";
import { MCP_LOOKUP_TOOLS, MCP_WRITE_TOOLS, writesEnabled } from "./write-tools";

/** Every tool the connector offers right now: reads always, writes unless MCP_READ_ONLY is set. */
export function connectorTools(): McpTool[] {
  return [...MCP_TOOLS, ...MCP_LOOKUP_TOOLS, ...(writesEnabled() ? MCP_WRITE_TOOLS : [])];
}

export function connectorInstructions(): string {
  const base = "Marketing Nexus budgets, pacing, campaigns and ad accounts. Amounts are in the account currency (major units, e.g. dollars).";
  return writesEnabled()
    ? `${base} Write tools change only Marketing Nexus records (pacing budgets, which campaigns count for a client, which ad accounts a client tracks); they never change budgets, campaigns or settings inside Google, Meta or Microsoft. Only make a change the user has asked for or approved, and confirm what changed afterwards.`
    : `${base} This connector is read-only: nothing here can change budgets or ad accounts.`;
}
