// MCP connector: protocol handling, secret check, and argument parsing (no database).
import { afterEach, describe, expect, it } from "vitest";
import { handleMcpMessage, ToolInputError, type McpTool } from "../mcp/protocol";
import { mcpAuthorized } from "../mcp/auth";
import { major, parseMonth, pacingSummary } from "../mcp/tools";

const echo: McpTool = {
  name: "echo",
  description: "Echo",
  inputSchema: { type: "object", properties: { v: { type: "string" } } },
  handler: async (a) => {
    if (a.v === "bad") throw new ToolInputError("bad input");
    if (a.v === "boom") throw new Error("secret internals");
    return { v: a.v };
  },
};

describe("MCP protocol", () => {
  it("initializes with a supported protocol version", async () => {
    const r = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, [echo])) as { result: { protocolVersion: string; capabilities: unknown } };
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it("falls back to its own version for an unknown one", async () => {
    const r = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, [echo])) as { result: { protocolVersion: string } };
    expect(r.result.protocolVersion).toBe("2025-06-18");
  });

  it("returns nothing for notifications", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, [echo])).toBeNull();
  });

  it("lists tools without their handlers", async () => {
    const r = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, [echo])) as { result: { tools: Record<string, unknown>[] } };
    expect(r.result.tools).toHaveLength(1);
    expect(r.result.tools[0].name).toBe("echo");
    expect(r.result.tools[0].handler).toBeUndefined();
  });

  it("calls a tool and returns text and structured content", async () => {
    const r = (await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { v: "hi" } } }, [echo])) as { result: { content: { text: string }[]; structuredContent: unknown } };
    expect(JSON.parse(r.result.content[0].text)).toEqual({ v: "hi" });
    expect(r.result.structuredContent).toEqual({ v: "hi" });
  });

  it("reports input errors as tool errors and hides internal ones", async () => {
    const bad = (await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { v: "bad" } } }, [echo])) as { result: { isError: boolean; content: { text: string }[] } };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toBe("bad input");
    const boom = (await handleMcpMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: { v: "boom" } } }, [echo])) as { result: { content: { text: string }[] } };
    expect(boom.result.content[0].text).not.toContain("secret internals");
  });

  it("rejects unknown tools and methods", async () => {
    const t = (await handleMcpMessage({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }, [echo])) as { error: { code: number } };
    expect(t.error.code).toBe(-32602);
    const m = (await handleMcpMessage({ jsonrpc: "2.0", id: 7, method: "resources/list" }, [echo])) as { error: { code: number } };
    expect(m.error.code).toBe(-32601);
  });

  it("handles batches", async () => {
    const r = (await handleMcpMessage([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }], [echo])) as unknown[];
    expect(r).toHaveLength(1);
  });
});

describe("MCP secret", () => {
  const original = process.env.MCP_SECRET;
  afterEach(() => {
    process.env.MCP_SECRET = original;
  });
  const S = "a".repeat(40);

  it("is off when MCP_SECRET is unset or short", () => {
    delete process.env.MCP_SECRET;
    expect(mcpAuthorized(S, null)).toBe(false);
    process.env.MCP_SECRET = "short";
    expect(mcpAuthorized("short", null)).toBe(false);
  });

  it("accepts the secret in the path or as a Bearer header", () => {
    process.env.MCP_SECRET = S;
    expect(mcpAuthorized(S, null)).toBe(true);
    expect(mcpAuthorized("x", `Bearer ${S}`)).toBe(true);
    expect(mcpAuthorized("b".repeat(40), null)).toBe(false);
    expect(mcpAuthorized(null, S)).toBe(false);
  });
});

describe("MCP tool helpers", () => {
  it("converts minor units", () => {
    expect(major(123456)).toBe(1234.56);
    expect(major(BigInt(500))).toBe(5);
    expect(major(null)).toBeNull();
  });

  it("parses months", () => {
    expect(parseMonth(undefined)).toBeUndefined();
    expect(parseMonth("2026-11")).toBe("2026-11-01");
    expect(() => parseMonth("2026-13")).toThrow(ToolInputError);
    expect(() => parseMonth("Nov")).toThrow(ToolInputError);
  });

  it("summarizes pacing in major units", () => {
    expect(pacingSummary(null)).toBeNull();
    const s = pacingSummary({
      phase: "ACTIVE", periodStart: "2026-11-01", periodEnd: "2026-11-30", asOf: "2026-11-15",
      budgetMinor: 300000, actualToDateMinor: 160000, expectedToDateMinor: 150000, remainingBudgetMinor: 140000,
      pctBudgetConsumed: 53.333, pctPeriodElapsed: 50, pacingPct: 106.666, status: "SLIGHTLY_OVER", forecastPct: 106.6,
      forecastStatus: "SLIGHTLY_OVER", projectedMinor: 320000, projectedVarianceMinor: 20000, forecastModel: "TRAILING_7D",
      totalDays: 30, elapsedDays: 15, remainingDays: 15, remainingActiveDays: 15, requiredDailyMinor: 9333,
      currentDailyRateMinor: 11000, recommendedDailyChangeMinor: -1667, recommendedDailyChangePct: -15.15, series: [],
    } as never);
    expect(s?.budget).toBe(3000);
    expect(s?.projectedMonthEnd).toBe(3200);
    expect(s?.pacingPct).toBe(106.7);
    expect(s?.recommendedDailyChange).toBe(-16.67);
  });
});
