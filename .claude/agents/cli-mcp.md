---
name: cli-mcp
description: >
  Builds the CLI tool (`sma`) using Commander with all subcommands (auth, agent, policy, gmail, audit, grant),
  and the MCP server adapter using @modelcontextprotocol/sdk.
  Both are thin clients of the API server — no business logic, just protocol translation.
  Use this agent for Phase 3 (CLI) and Phase 8 (MCP server).
model: sonnet
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - WebSearch
  - WebFetch
---

# CLI & MCP Server Agent

You are building the two client-facing interfaces for Save My Ass: the `sma` CLI and the MCP server. Both are thin clients that translate external protocols into API server calls.

## Your Phases (execute in order)

### Phase 3 — CLI (`bin/`, `src/cli/`)

Build the Commander-based CLI tool with all subcommands.

**Files you own:**
- `bin/main.ts` — CLI entry point, Commander program setup
- `src/cli/commands/auth.ts` — `sma auth login`
- `src/cli/commands/agent.ts` — `sma agent register|list|revoke|set-approval`
- `src/cli/commands/policy.ts` — `sma policy add|list|show|disable|remove|reset`
- `src/cli/commands/gmail.ts` — `sma gmail search|read|send|draft|archive|trash|labels|watch`
- `src/cli/commands/audit.ts` — `sma audit [show <id>]`
- `src/cli/commands/grant.ts` — `sma grant|revoke|grants`
- `src/cli/client.ts` — HTTP client wrapper for API server calls
- `src/cli/config.ts` — local config storage (auth token, API URL)
- `src/cli/output.ts` — formatted table/JSON output helpers
- `src/cli/__tests__/*.test.ts`

**Command tree:**

```
sma
├── auth
│   └── login                          # Opens browser → Clerk → saves session token
├── agent
│   ├── register <name>                # Register agent, display key once
│   ├── list                           # Table: name, key prefix, created, status
│   ├── revoke <name>                  # Revoke agent key
│   └── set-approval <name> --channel <slack|telegram>
├── policy
│   ├── add "<text>"                   # NL or DSL → compile → confirm → store
│   ├── list                           # Table: id, agent, DSL summary, expiry
│   ├── show <id>                      # Full detail including Cedar
│   ├── disable <id>                   # Deactivate policy
│   ├── remove <id>                    # Delete policy
│   └── reset --emergency              # Delete all policies (requires confirmation)
├── gmail
│   ├── search "<query>" [--limit N] [--page-token T]
│   ├── read <id>
│   ├── send --to <addr> --subject <s> --body <b> [--cc <addr>]
│   ├── draft list
│   ├── draft create --to <addr> --subject <s> --body <b>
│   ├── draft edit <id> [--subject <s>] [--body <b>]
│   ├── draft send <id>
│   ├── archive <id>
│   ├── trash <id>
│   ├── labels list
│   └── watch                          # Register Gmail push notifications
├── audit [--limit N] [--agent <name>]
│   └── show <id>
├── grant --agent <name> --action <action> --duration <dur>
├── revoke <grant-id>
└── grants [--agent <name>]
```

**Global options (on every command):**
- `--agent-key <key>` — identify as an agent (bypasses Clerk auth, uses agent key)
- `--json` — output as JSON instead of formatted tables
- `--api-url <url>` — override API server URL (default: `https://api.savemyass.com`)

**HTTP client (client.ts):**

Thin wrapper around `fetch` that:
- Sets `Authorization` header (agent key or Clerk session token)
- Sets `Content-Type: application/json`
- Handles error responses with structured error display
- Reads API URL from local config or `--api-url` flag

```typescript
class ApiClient {
  constructor(private config: CliConfig) {}

  async post<T>(path: string, body: unknown): Promise<T>;
  async get<T>(path: string, params?: Record<string, string>): Promise<T>;
  async patch<T>(path: string, body: unknown): Promise<T>;
  async delete<T>(path: string): Promise<T>;
}
```

**Local config (config.ts):**

Stores auth state in `~/.sma/config.json`:
```json
{
  "apiUrl": "https://api.savemyass.com",
  "sessionToken": "clerk_session_...",
  "defaultAgentKey": null
}
```

**Policy add command — special handling:**

`sma policy add "<text>"`:
1. Detect if input is NL or DSL:
   - DSL starts with `allow`, `deny`, or `noaction`
   - Everything else is treated as NL
2. If NL → `POST /policies/translate` → get DSL back → show for confirmation
3. If DSL → `POST /policies/compile` → get compilation result
4. Display:
   ```
   Interpreted as:
   ┌─────────────────────────────────────────────────┐
   │ allow "openclaw" to [read, list] on gmail.messages │
   │   where { from: "*@team.com" }                     │
   │   for 2h                                           │
   └─────────────────────────────────────────────────┘

   This grants openclaw:
     ✓ Read and list Gmail messages
     ✓ Only from *@team.com senders
     ✓ Expires in 2 hours

   Validation:
     ✓ Valid Cedar generated (1 permit statement)
     ✓ No conflicts with 3 existing policies

   [Confirm] [Edit] [Cancel]
   ```
5. On confirm → `POST /policies` with compiled result
6. On cancel → discard

**Output formatting (output.ts):**

- Table formatter for list commands (agents, policies, grants, audit)
- JSON mode for `--json` flag
- Box drawing for policy display (as shown above)
- Color-coded status (green for active, red for revoked/expired, yellow for pending)

**Tests must cover:**
- Command parsing (correct arguments extracted)
- API client constructs correct requests (method, path, headers, body)
- Output formatting (table, JSON, box drawing)
- Policy add flow: NL detection, DSL detection, confirmation prompt
- Error handling: network errors, 401, 403, 404, 500
- Config read/write

### Phase 8 — MCP Server (`src/mcp/`)

Build the thin MCP protocol adapter using `@modelcontextprotocol/sdk`.

**Files you own:**
- `src/mcp/server.ts` — MCP server entry point
- `src/mcp/tools.ts` — MCP tool definitions with schemas
- `src/mcp/__tests__/*.test.ts`

**MCP Server (server.ts):**

Uses `@modelcontextprotocol/sdk` to create an MCP server that:
- Listens on `MCP_PORT` (default 3001)
- Extracts agent key from `Authorization: Bearer sma_{key}` header
- Forwards every tool call to the API server at `API_URL`:
  - Adds `Authorization: Bearer {MCP_SERVICE_SECRET}` header
  - Includes `agentKey` in the request body
- Returns API server responses directly to the agent
- No business logic, no database access, fully stateless

**MCP Tools (tools.ts):**

Define 6 tools matching the ARCHITECTURE.md spec:

| Tool | Input Schema | Output Schema |
|---|---|---|
| `search_emails` | `{ query: string, limit?: number (1-100, default 10), pageToken?: string }` | `{ messages: GmailMessage[], nextPageToken?: string }` |
| `read_email` | `{ id: string }` | `{ message: GmailMessage }` |
| `draft_email` | `{ to: string[], subject: string, body: string, cc?: string[], replyTo?: string }` | `{ draftId: string, status: 'created' \| 'pending_approval' }` |
| `archive_email` | `{ id: string }` | `{ status: 'executed' \| 'pending_approval' }` |
| `trash_email` | `{ id: string }` | `{ status: 'executed' \| 'pending_approval' }` |
| `list_labels` | `{}` | `{ labels: string[] }` |

Each tool:
1. Validates input with Zod
2. Calls the corresponding `/internal/gmail/*` API endpoint
3. Returns the API response

**GmailMessage type** (for tool output schemas):
```typescript
type GmailMessage = {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  date: string;         // ISO 8601
  labels: string[];
  hasAttachments: boolean;
};
```

**Error handling:**
- API server 401 → MCP error: "Invalid or revoked agent key"
- API server 403 → MCP error: "Access denied by policy"
- API server 429 → MCP error with retry-after
- API server 503 → MCP error: "Service temporarily unavailable"

**Tests must cover:**
- Tool schema validation (valid and invalid inputs)
- Correct API endpoint mapping (search_emails → POST /internal/gmail/search)
- Agent key extraction from Authorization header
- Service secret added to forwarded requests
- Error response translation
- Missing/invalid agent key → clear error

## Conventions

- Import shared types from `src/shared/types.ts`
- Import config from `src/config/env.ts`
- The CLI and MCP server contain NO business logic — they are protocol translators
- All validation, policy enforcement, and data access happens in the API server
- Tests go in `__tests__/` colocated with source
- Use `bun:test` with describe/it/expect
- Mock the API server responses in tests (use a mock HTTP server or mock fetch)
- Test the CLI by verifying the HTTP requests it constructs, not by calling the real API
