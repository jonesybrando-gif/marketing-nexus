# Claude connector (MCP)

Marketing Nexus exposes a **read-only** MCP server so Claude can read budgets and
pacing directly (for example, a weekly pacing review run as a scheduled task).
Nothing it offers can change budgets, campaigns or ad accounts.

## Tools

| Tool | What it returns |
|---|---|
| `list_clients` | Clients with labels, manager and linked ad accounts |
| `get_budget_pacing` | Per client and per budget line: monthly budget, spend to date, expected spend to date, projected month-end, pacing status, current platform daily budget, required daily spend, and the app's recommendation. Optional `client` and `month` (`YYYY-MM`). |
| `get_campaigns` | A client's campaigns with status, platform daily budget, and month spend, clicks, impressions, conversions and leads |

Amounts are in major units (dollars), not cents. The numbers come from the same
pacing service as the Budget Pacing dashboard.

## Turn it on

1. Generate a secret: `openssl rand -hex 32`
2. In Railway, add the variables:
   - `MCP_SECRET` = the secret (at least 32 characters; shorter values leave the connector off)
   - `MCP_AGENCY_SLUG` = your agency's slug (only needed if the database holds more than one agency)
3. Redeploy (Railway does this when variables change).
4. In Claude: **Settings → Connectors → Add custom connector**
   - Name: `Marketing Nexus`
   - URL: `https://app.marketingnexus.us/api/mcp/<MCP_SECRET>`

## Security

- The secret is the last part of the URL, because Claude custom connectors can't
  send a custom header. Treat the URL like a password. A `Authorization: Bearer <secret>`
  header is also accepted for other MCP clients.
- A wrong secret and a switched-off connector both return 404.
- To revoke access, change or delete `MCP_SECRET` in Railway and redeploy, then
  update the connector URL in Claude.
- The connector reads one agency only (`MCP_AGENCY_SLUG`, or the only agency).

## Protocol

Streamable HTTP, stateless, JSON responses (no SSE stream, no sessions).
Supports `initialize`, `ping`, `tools/list` and `tools/call`.
