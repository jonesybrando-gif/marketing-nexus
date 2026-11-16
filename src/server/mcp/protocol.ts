// Minimal MCP (Model Context Protocol) server over Streamable HTTP, stateless,
// JSON responses only. Kept dependency-free: the connector is read-only and
// only needs initialize, tools/list, tools/call and ping.

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const err = (id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const ok = (id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: id ?? null, result });

/** Thrown by a tool for a bad argument; returned to the model as a tool error, not a protocol error. */
export class ToolInputError extends Error {}

async function handleOne(msg: JsonRpcRequest, tools: McpTool[], serverName: string): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return err(msg?.id, -32600, "Invalid request");
  const isNotification = msg.id === undefined;
  if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
  switch (msg.method) {
    case "initialize": {
      const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : MCP_PROTOCOL_VERSION;
      return ok(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: "1.0.0" },
        instructions: "Read-only access to Marketing Nexus budgets and pacing. Amounts are in the account currency (major units, e.g. dollars). Nothing here can change budgets or ad accounts.",
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return err(msg.id, -32602, `Unknown tool: ${String(name)}`);
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const data = await tool.handler(args);
        return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data && typeof data === "object" && !Array.isArray(data) ? data : { result: data } });
      } catch (e) {
        const message = e instanceof ToolInputError ? e.message : "Internal error while running the tool.";
        if (!(e instanceof ToolInputError)) console.error(`[mcp] tool ${tool.name} failed`, e);
        return ok(msg.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/** Handles a JSON-RPC message or batch. Returns null when nothing needs to be sent back (only notifications). */
export async function handleMcpMessage(body: unknown, tools: McpTool[], serverName = "marketing-nexus"): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return err(null, -32600, "Invalid request");
    const out = (await Promise.all(body.map((m) => handleOne(m as JsonRpcRequest, tools, serverName)))).filter((r): r is JsonRpcResponse => r !== null);
    return out.length ? out : null;
  }
  return handleOne(body as JsonRpcRequest, tools, serverName);
}
