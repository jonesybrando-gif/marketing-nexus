# Claude connector (MCP)

Marketing Nexus exposes an MCP server so Claude can read budgets and pacing
directly (for example, a weekly pacing review run as a scheduled task) and make
changes to Marketing Nexus's own records when you ask: pacing budgets, which
campaigns count for a client, and which ad accounts a client tracks.

**Nothing the connector does changes anything inside Google, Meta or Microsoft.**
Set `MCP_READ_ONLY=true` to switch the write tools off and go back to read-only.

## Tools

| Tool | What it returns |
|---|---|
| `list_clients` | Clients with labels, manager and linked ad accounts |
| `get_budget_pacing` | Per client and per budget line: monthly budget, spend to date, expected spend to date, projected month-end, pacing status, current platform daily budget, required daily spend, and the app's recommendation. Optional `client` and `month` (`YYYY-MM`). |
| `get_campaigns` | A client's campaigns with status, platform daily budget, and month spend, clicks, impressions, conversions and leads |
| `list_budgets` | A client's budgets for a month with ids, amounts, revision history and whether they repeat |
| `list_linkable_accounts` | Ad accounts each saved platform login can reach (calls the platform, read only) |

### Write tools (off when `MCP_READ_ONLY=true`)

| Tool | What it changes |
|---|---|
| `set_budget` | Creates a whole-month pacing budget (client, account or campaign level), or adds a revision if one already covers the month. Repeats monthly by default. |
| `delete_budget` | Deletes one budget (needs `confirm: true`) and stops last month's matching budget from re-creating it |
| `set_campaign_included` | Includes or leaves out a campaign from a client's reports, pacing and alerts |
| `set_include_new_campaigns` | Whether new campaigns in an account start out included |
| `link_ad_account` | Links an ad account to a client with a login already saved in the app, then imports history. Replacing a client's existing account on that platform needs `replace: true`. |
| `stop_tracking_ad_account` | Stops syncing an account (needs `confirm: true`); history stays |
| `remove_ad_account` | Permanently removes an account that is no longer tracked, with its stored history (needs `confirm: true`) |

The write tools follow the same rules as the app (one budget per target per
period, a campaign with its own budget can't be left out, one account per
platform per client). Every change is logged with a `[mcp]` prefix and budget
changes carry the note "Set via Claude connector". New platform logins (OAuth)
still have to be connected in the app.

Amounts are in major units (dollars), not cents. The numbers come from the same
pacing service as the Budget Pacing dashboard.

## Turn it on

1. Generate a secret: `openssl rand -hex 32`
2. In Railway, add the variables:
   - `MCP_SECRET` = the secret (at least 32 characters; shorter values leave the connector off)
   - `MCP_AGENCY_SLUG` = your agency's slug (only needed if the database holds more than one agency)
   - `MCP_READ_ONLY` = `true` (optional) to offer only the read tools
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
