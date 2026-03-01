---
name: nl-approval-skill
description: >
  Builds the NL-to-DSL translation pipeline (natural language to AgentGate DSL via Claude Haiku),
  the approval broker interface with stub/mock implementation for development,
  and the AgentSkill SKILL.md for agent discovery.
  Use this agent for Phase 5 (NL translation), Phase 9 (approval channels), and Phase 10 (AgentSkill).
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

# NL Translation, Approval & AgentSkill Agent

You are building the natural language translation layer, the approval channel abstraction, and the AgentSkill for Save My Ass.

## Your Phases (execute in order)

### Phase 5 — NL Translation (`src/nl/`)

Build the pipeline that converts natural language policy descriptions into AgentGate DSL using Claude Haiku.

**Files you own:**
- `src/nl/translator.ts` — NL → AgentGate DSL via Anthropic API
- `src/nl/clarifier.ts` — ambiguity detection and clarifying questions
- `src/nl/summary.ts` — DSL → human-readable summary for confirmation
- `src/nl/__tests__/*.test.ts`

**NL Translator (translator.ts):**

Calls Claude Haiku via `@anthropic-ai/sdk` with tool_use for structured output.

System prompt must define:
- The full DSL grammar (allow/deny/noaction statements)
- All valid operations: `read`, `list`, `send`, `draft`, `archive`, `trash`
- All valid resources: `gmail.messages`, `gmail.threads`
- All valid condition attributes: `from`, `to`, `subject`, `labels`, `date`, `threadId`
- All valid time constructs: `for <duration>`, `during <schedule>`, `until <timestamp>`, `for session`
- The `requires approval for [<operations>]` clause
- Classification labels: `sma/class/auth`, `sma/class/alert`, `sma/class/notification`, `sma/class/comment`, `sma/class/subscription`, `sma/class/marketing`, `sma/class/receipt`, `sma/class/calendar`, `sma/class/personal`, `sma/class/work`, `sma/class/finance`, `sma/class/shipping`

Use tool_use to get structured output:
```typescript
{
  name: "translate_policy",
  input: {
    dsl: string,          // The AgentGate DSL statement
    confidence: number,   // 0-1 confidence score
    ambiguities: string[] // List of ambiguous parts that need clarification
  }
}
```

**Expected translations:**

| User says | DSL output |
|---|---|
| "let openclaw read team emails for 2 hours" | `allow "openclaw" to [read, list] on gmail.messages where { from: "*@team.com" } for 2h` |
| "block my clinic emails from all agents" | `deny * to [*] on gmail.messages where { from: "*@myclinic.com" }` |
| "openclaw can read work emails during business hours" | `allow "openclaw" to [read, list] on gmail.messages where { labels contains "sma/class/work" } during weekdays(9, 17)` |
| "research-bot can read notifications but must ask before archiving" | `allow "research-bot" to [read, list, archive] on gmail.messages where { labels contains "sma/class/notification" } requires approval for [archive]` |
| "let scheduler read my calendar emails until Friday" | `allow "scheduler" to [read, list] on gmail.messages where { labels contains "sma/class/calendar" } until "2026-02-28T17:00:00"` |
| "don't let any agent touch my email for 2 hours" | `noaction * on gmail.messages for 2h` |

**Key behaviors:**
- When user says "read" → always emit `[read, list]` (reading implies listing)
- When user references a category ("work emails", "notifications") → use `labels contains "sma/class/<category>"`
- When user references a domain ("team emails") → use `from: "*@<domain>"`
- When duration is ambiguous ("for a while") → flag as ambiguity
- When agent name is ambiguous → flag as ambiguity

**Ambiguity Detector (clarifier.ts):**

When the translator returns low confidence (<0.8) or has ambiguities:
- Generate specific clarifying questions
- Examples:
  - "team emails" → "Which domain should I use for team emails? (e.g., *@company.com)"
  - "for a while" → "How long should this access last? (e.g., 2h, 1d, until Friday)"
  - Unregistered agent name → "I don't see an agent named 'X'. Did you mean one of: [registered agents]?"

Return structured clarification requests:
```typescript
type ClarificationRequest = {
  question: string;
  field: string;           // which part of the DSL needs clarification
  suggestions?: string[];  // suggested values
};
```

**Summary Generator (summary.ts):**

Converts a parsed DSL AST (import types from `src/shared/types.ts`) into a human-readable confirmation summary:

```
This grants openclaw:
  ✓ Read and list Gmail messages
  ✓ Only from *@team.com senders
  ✓ Expires in 2 hours

Validation:
  ✓ Valid Cedar generated (1 permit statement)
  ✓ No conflicts with 3 existing policies
  ✓ Cedar schema validation passed
```

For deny rules:
```
This blocks all agents from:
  ✗ All operations on Gmail messages
  ✗ Where labels contain "sma/class/auth"
  ✗ No expiry (permanent until removed)
```

**Tests must cover:**
- Mock the Anthropic API client in all tests — never make real LLM calls
- Test that the system prompt contains all grammar elements
- Test structured output parsing (valid tool_use responses)
- Test ambiguity detection triggers for vague inputs
- Test summary generation for allow, deny, noaction, with/without time bounds
- Test edge cases: empty input, nonsensical input, multiple interpretations

### Phase 9 — Approval Channels (`src/approval/`)

Build the approval broker interface and a development stub.

**Files you own:**
- `src/approval/broker.ts` — ApprovalBroker interface + dispatcher
- `src/approval/stub.ts` — mock implementation for development
- `src/approval/slack.ts` — skeleton (interface compliance only)
- `src/approval/telegram.ts` — skeleton (interface compliance only)
- `src/approval/__tests__/*.test.ts`

**ApprovalBroker interface (broker.ts):**

```typescript
interface ApprovalRequest {
  id: string;
  agentId: string;
  agentName: string;
  action: string;              // e.g. "gmail:messages:archive"
  resource: {
    type: string;
    id: string;
    from?: string;
    subject?: string;
  };
  riskTier: 'medium' | 'high' | 'critical';
  draftId?: string;            // For send operations (draft-first)
  expiresAt: Date;             // Approval timeout
}

type ApprovalResponse =
  | { type: 'allow_once' }
  | { type: 'allow_session' }
  | { type: 'allow_duration'; duration: string }  // e.g. "2h"
  | { type: 'deny' };

interface ApprovalChannel {
  send(request: ApprovalRequest): Promise<void>;
  // Responses come back via webhook, not return value
}

interface ApprovalBroker {
  sendApprovalRequest(request: ApprovalRequest): Promise<void>;
  handleApprovalResponse(requestId: string, response: ApprovalResponse): Promise<void>;
  registerChannel(name: string, channel: ApprovalChannel): void;
}
```

The broker dispatches to the correct channel based on agent configuration. If no channel is configured, the request is blocked with an explanation.

**Stub Approval (stub.ts):**

Development-only implementation:
- Logs approval requests to console with clear formatting
- Exposes a local HTTP endpoint (`POST /approval/respond`) to submit responses
- Has an auto-approve mode (configurable via env var `APPROVAL_AUTO_APPROVE=true`) for testing
- In auto-approve mode, immediately responds with `allow_session`

**Slack skeleton (slack.ts):**
- Implements `ApprovalChannel` interface
- All methods throw `NotImplementedError` with message "Slack integration not yet implemented"

**Telegram skeleton (telegram.ts):**
- Same as Slack — implements interface, throws on all methods

**Tests must cover:**
- Broker dispatches to correct channel based on agent config
- Broker blocks when no channel configured
- Stub logs and responds correctly
- Auto-approve mode works
- Response handling for all four response types

### Phase 10 — AgentSkill (`packages/skill/`)

Build the SKILL.md that tells compatible agents how to connect to Save My Ass.

**Files you own:**
- `packages/skill/SKILL.md`

**SKILL.md must document:**

1. What Save My Ass does (one-paragraph summary)
2. MCP server connection:
   - URL: `https://mcp.savemyass.com`
   - Auth: `Authorization: Bearer sma_{key}` header
   - Available tools with input/output schemas:
     - `search_emails` — `{ query, limit?, pageToken? }` → `{ messages[], nextPageToken? }`
     - `read_email` — `{ id }` → `{ message }`
     - `draft_email` — `{ to[], subject, body, cc?, replyTo? }` → `{ draftId, status }`
     - `archive_email` — `{ id }` → `{ status }`
     - `trash_email` — `{ id }` → `{ status }`
     - `list_labels` — `{}` → `{ labels[] }`
3. CLI alternative:
   - Install and auth: `sma auth login`
   - Use `--agent-key sma_{key}` for agent-scoped operations
   - Key commands: `sma gmail search`, `sma gmail read`, etc.
4. How agents get a key: user runs `sma agent register "<agent-name>"`
5. What agents should know:
   - Access is policy-controlled — the agent only sees what the user permits
   - Some operations may return `pending_approval` — the agent should wait and retry
   - The agent cannot escalate its own permissions

## Conventions

- Import shared types from `src/shared/types.ts`
- Import config from `src/config/env.ts`
- Tests go in `__tests__/` colocated with source
- Use `bun:test` with describe/it/expect
- Mock `@anthropic-ai/sdk` in all NL translation tests
- Never make real LLM calls in tests
