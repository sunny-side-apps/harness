
## Overview

**Mailcloak.ai** is a secure proxy and policy enforcement layer that allows users to grant AI agents controlled, auditable, and selective access to their email and other services.

It acts as an invisible access control plane between AI agents and service providers (Gmail initially, expanding to Slack, GitHub, Google Calendar, Google Drive, Stripe), enforcing user-defined policies, delegation chains, cross-service flow rules, and just-in-time approvals.

Mailcloak ensures that AI agents can only see and act on resources they are explicitly allowed to access — and only for as long as they are allowed.

---

## Vision

Enable safe, autonomous AI agents by providing a secure abstraction layer over sensitive systems, starting with email.

Long-term, Mailcloak expands into a universal access control layer for AI agents across:

- Email (initial focus)
- Cloud storage (Google Drive, Dropbox)
- Messaging (Slack, Teams)
- Documents (Notion, Confluence)
- Source code (GitHub, GitLab)
- Payments (Stripe)

---

## Core Goals

### Primary goals (MVP)

- Allow AI agents to safely read and search user email
- Enforce fine-grained access policies using Cedar
- Prevent agents from seeing unauthorized emails
- Provide full auditability and transparency
- Enable safe agent actions via draft-first and approval workflows
- Operate statelessly without syncing or storing emails internally
- Support timeboxed access that automatically expires

### Trust and safety goals

- Default-deny: if no Cedar policy matches, the action is blocked
- Default read-only access
- Draft-first model for outgoing email
- Just-in-time approval for sensitive actions
- Live audit feed of agent activity
- No internal storage of email bodies (Gmail remains source of truth)
- Delegation narrowing: sub-agents never exceed parent permissions
- Cross-service flow isolation: data from one service can be blocked from leaking to another

### User focus

Initial target users:

- Founders
- Executives
- Individual professionals using AI assistants

Expansion target:

- Small teams
- AI-native companies

---

## Problem

AI agents that access email and other APIs get full account access. There is no way to scope what they can see or do, or for how long. Specifically:

- **OAuth scopes are too coarse.** `gmail.modify` grants access to everything — read, send, delete, forward, modify filters, change vacation settings. There is no way to say "read-only, only from my team, for 2 hours."
- **Policy languages are API-unaware.** Cedar, Rego, and Polar evaluate policies against abstract entities. They don't know that `gmail.users.messages.get` and `gmail.users.settings.getAutoForwarding` are both GETs but very different security-wise.
- **Agents exceed user permissions.** An agent delegated by Alice should never have more access than Alice. With multi-agent orchestration (agent A spawns agent B), permissions should narrow at each hop.
- **No time boundaries.** Agents hold standing access indefinitely. There is no built-in way to grant "read access for 2 hours" or "only during business hours."
- **No cross-service isolation.** An agent that reads medical emails can immediately post that content to Slack. There is no data flow control across API boundaries.

---

## Solution

A four-layer permission system built on **Cedar** (AWS's open-source authorization language) as the core evaluation engine:

- **Layer 0: Natural language interface** — the primary way users define policies. Users type plain English ("let openclaw read my team emails for 2 hours, but never touch anything from my clinic"). An LLM translates this into the AgentGate DSL, shows the user the structured result for confirmation, and compiles it.
- **Layer 1: Service bindings** — machine-readable mappings from API specs (OpenAPI, Google Discovery docs) to a normalized resource/operation model. Generated from specs, reviewed by humans, version-controlled.
- **Layer 2: AgentGate DSL** — a structured intermediate representation for expressing who can do what, on which resources, under what conditions, for how long. Compiles down to Cedar policies.
- **Layer 3: Application runtime** — session taint tracking, flow rules, delegation ceiling computation, timebox management, and audit logging.

The natural language layer provides accessibility. The binding layer guarantees correctness. The DSL provides auditability. Cedar provides the evaluation engine with formal analysis (SMT-based conflict detection), compile-time type safety, and 42-80x faster evaluation than alternatives.

### Core Invariant: Validated-or-Rejected

**No policy is ever activated unless it produces valid, conflict-free Cedar.** This is a hard gate, not a best-effort check. Regardless of how a policy enters the system (natural language, DSL file, CLI flags, API), it must pass the full compilation pipeline before it can affect any authorization decision.

- **Natural language that produces invalid DSL** → rejected with repair loop
- **Valid DSL that produces invalid Cedar** → rejected with exact error
- **Valid Cedar that conflicts with existing policies** → rejected with plain-English explanation
- **The active Cedar policy set is always the last successfully compiled set.** The swap is atomic.

### Why Cedar

Cedar wins for this use case because:

1. **Formal analysis.** SMT-based automated reasoning can mathematically prove that "no combination of policies ever allows any agent to access medical emails."
2. **Performance.** 42-80x faster than Rego. Policy structure allows indexed evaluation with bounded latency.
3. **Compile-time type safety.** Cedar schemas enforce typed entities and attributes. A policy referencing `resource.foo` on an entity without `foo` fails at authoring time.
4. **No vendor lock-in.** Apache 2.0 license. `@cedar-policy/cedar-wasm` runs locally.
5. **Industry momentum.** AWS Bedrock AgentCore uses Cedar for agent-to-tool authorization.

What Cedar lacks (datetime arithmetic, regex, cross-service flow tracking) is handled in our application layer. What Cedar provides (formal analysis, typed schemas) is impossible to replicate on top of other engines.

---

## Architecture

```
                    ┌──────────────────────────────────────────────────┐
   User ──────────> │  "let openclaw read my team emails for 2h"      │
   (natural         │                    │                             │
    language)       │               NL Translator (LLM)               │
                    │                    │                             │
   Advanced ──────> │  allow "openclaw" to [read, list] on gmail...   │
   user (DSL)       │                    │ ◄── confirm / edit         │
                    │                    ▼                             │
┌─────────────┐     │  ┌──────────┐  ┌───────────────────────────────┐│     ┌──────────────┐
│   Agent      │────>│  │ Compiler │  │     Service Bindings          ││────>│ Gmail API    │
│  (OpenClaw)  │<────│  │          │  │  gmail.binding                ││<────│ Slack API    │
└─────────────┘     │  │ parse    │  │  slack.binding                ││     │ GitHub API   │
                    │  │ resolve  │  │  github.binding               ││     │ Calendar API │
                    │  │ typecheck│  │  (generated from specs)       ││     │ Drive API    │
                    │  │ delegate │  └───────────────────────────────┘│     │ Stripe API   │
                    │  │ conflicts│                                    │     └──────────────┘
                    │  │ emit ────┼──> Cedar policies + schema        │
                    │  └──────────┘                                    │
                    │  ┌──────────────────┐  ┌───────────────────────┐│
                    │  │ Runtime Engine   │  │    Session State       ││
                    │  │                  │  │  delegation chains     ││
                    │  │ cedar-wasm       │  │  flow taint            ││
                    │  │  (policy eval)   │  │  timebox tracking      ││
                    │  │ app layer        │  │  audit log             ││
                    │  │  (flows, taint,  │  └───────────────────────┘│
                    │  │   timeboxes)     │                            │
                    │  └──────────────────┘                            │
                    └──────────────────────────────────────────────────┘
```

### Core Components

- **NL Translator** — Accepts natural language, converts to AgentGate DSL. Uses service bindings as context so it knows valid services, resources, operations, and attributes. Ambiguous input triggers clarifying questions.
- **Compiler** — 7-phase pipeline: parse → resolve → type-check → delegation → conflicts → emit Cedar → validate. No phase is optional. Failure at any phase rejects the policy.
- **Service Bindings** — Machine-readable mappings from API specs to a normalized resource/operation model. The binding is the gatekeeper — nothing passes without an explicit mapping.
- **Policy Engine** — Cedar WASM evaluation. Default-deny: if no rule matches, the action is blocked.
- **Runtime Engine** — Request evaluation hot path. Wraps Cedar with application-layer features (flows, taint, timeboxes).
- **Action Control** — Classifies actions by risk tier and enforces confirmation requirements.
- **Timebox Manager** — Creates time-bounded policies, runs expiry sweeps, handles pre-expiry notifications and extension prompts.
- **Approval Broker** — Sends approval requests via chat apps (Slack, Telegram). Issues temporary execution tokens.
- **Audit Log** — Records every agent request, the policy decision, and the outcome.

---

## Email Provider Integration

Initial provider:

- Gmail via OAuth and Gmail API

Future providers:

- IMAP
- Microsoft Outlook

Gmail remains the source of truth. Mailcloak does not replicate or store full inbox contents. Caching is used only for performance.

### Classification System

Hybrid approach:

- Deterministic rules (sender domains, patterns)
- LLM-based classification

Classification results are stored as Gmail labels:

```
mailcloak/classification/invoice
mailcloak/classification/travel
mailcloak/classification/personal
mailcloak/classification/financial
```

Gmail serves as the classification storage layer. Mailcloak does not store classification internally.

---

## The Permission Language (AgentGate DSL)

### How Users Define Policies

Most users write natural language. The system translates it to the AgentGate DSL, validates through the full compiler pipeline, shows the structured result with validation status, and asks for confirmation before activating:

```
$ mailcloak policy add "let openclaw read my team emails for the next 2 hours"

  Interpreted as:
  ┌─────────────────────────────────────────────────────────┐
  │ allow "openclaw" to [read, list] on gmail.messages      │
  │   where { from: "*@team.com" }                          │
  │   for 2h                                                │
  └─────────────────────────────────────────────────────────┘

  This grants openclaw:
    ✓ Read and list Gmail messages
    ✓ Only from *@team.com senders
    ✓ Expires in 2 hours

  Validation:
    ✓ Valid Cedar generated (1 permit statement)
    ✓ No conflicts with 3 existing policies
    ✓ Delegation ceiling OK (alice → openclaw)

  [Confirm] [Edit] [Cancel]
```

When validation fails, the policy is not activated and the user sees the exact problem:

```
$ mailcloak policy add "let openclaw send emails to anyone"

  Validation FAILED:
    ✗ Delegation ceiling violation: user "alice" only delegated [read, list, draft]
      to openclaw. "send" is not permitted.
    → Ask alice to update the delegation, or choose a permitted operation.

  Policy was NOT activated. [Edit] [Cancel]
```

### DSL Syntax

Every policy is an `allow` or `deny` statement:

```
allow <agent> to [<operations>] on <service>.<resource>
  [where { <conditions> }]
  [for <duration> | during <schedule> | until <timestamp>]
  [requires approval [for [<operations>]]]
  [as <user>]

deny <agent> to [<operations>] on <service>.<resource>
  [where { <conditions> }]
```

### Examples

| User says | DSL output |
|-----------|------------|
| "let openclaw read team emails for 2 hours" | `allow "openclaw" to [read, list] on gmail.messages where { from: "*@team.com" } for 2h` |
| "block my clinic emails from all bots" | `deny * to [*] on gmail.messages where { from: "*@myclinic.com" }` |
| "sales-bot can read and post in sales channels during work hours, but ask me before it posts" | `allow "sales-bot" to [read, send] on slack.messages where { channel: "#sales-*" } during weekdays(9, 17) requires approval for [send]` |
| "research-bot can read public repo issues tagged agent-ok" | `allow "research-bot" to [read, list, comment] on github.issues where { repo: "myorg/public-*", label: "agent-ok" }` |
| "scheduler can see my work calendar this session" | `allow "scheduler-agent" to [read, list] on calendar.events where { calendar: "work", visibility: "public" } for session` |
| "research-bot can download from /research/public until Friday" | `allow "research-bot" to [read, download] on drive.files where { folder: "/research/public/**" } until "2026-02-21T17:00:00"` |

### Design Choices

- **`*` is a wildcard** for agents, operations, and resources. `deny * to [*] on stripe.*` blocks everything on Stripe.
- **`deny` always wins over `allow`.** No ambiguity. If both match, deny takes precedence (Cedar semantics).
- **Operations are verbs from the service binding**, not HTTP methods. `read` not `GET`.
- **Conditions use the resource's own attributes** as defined in the binding. Referencing a nonexistent attribute is a compile-time error.
- **Time is first-class.** `for 2h`, `during weekdays(9, 17)`, `until <timestamp>`, `for session`.

### Condition Operators

| Type        | Operators                                              |
|-------------|--------------------------------------------------------|
| `string`    | `==`, `!=`, `matches` (glob), `like` (regex), `startsWith`, `endsWith` |
| `string[]`  | `contains`, `containsAny`, `containsAll`, `isEmpty`   |
| `number`    | `==`, `!=`, `>`, `<`, `>=`, `<=`                      |
| `timestamp` | `==`, `!=`, `>`, `<`, `>=`, `<=`, relative (`7d ago`, `now - 2h`) |
| `bool`      | `==`, `!=`                                             |
| `enum`      | `==`, `!=`, `in [a, b]`                                |

### Time Boundaries

| Construct             | Meaning                                  | Example                    |
|-----------------------|------------------------------------------|----------------------------|
| `for <duration>`      | Relative window from grant time          | `for 2h`, `for 30m`       |
| `until <timestamp>`   | Absolute expiry                          | `until "2026-03-01T00:00"` |
| `during <schedule>`   | Recurring time window                    | `during weekdays(9, 17)`  |
| `for session`         | Tied to proxy session lifetime           | `for session`              |

Time constructs compose with policies. An agent's effective access window is the intersection of all time constraints in its delegation chain.

---

## Cedar Entity Model

The compiler maps AgentGate concepts to Cedar's type system:

```cedar
namespace AgentGate {
  entity User;
  entity Agent in [User];

  entity Service;
  entity Resource in [Service];

  action "gmail.messages.read"
    appliesTo { principal: Agent, resource: Resource };
  action "gmail.messages.list"
    appliesTo { principal: Agent, resource: Resource };
  action "gmail.messages.send"
    appliesTo { principal: Agent, resource: Resource };
  // ... one action per operation in all service bindings
}
```

**Mapping table:**

| AgentGate concept      | Cedar concept                                           |
|------------------------|---------------------------------------------------------|
| Agent name             | `principal == Agent::"openclaw"`                        |
| User                   | `User::"alice"` (parent of agents in entity hierarchy)  |
| Service + resource     | `resource is gmail::Message`                            |
| Operation              | `action == Action::"gmail.messages.read"`               |
| Wildcard agent `*`     | No principal constraint (applies to all)                |
| Wildcard operation `*` | `action in` with all actions for that resource          |
| Condition attributes   | `resource.from`, `resource.labels`, etc.                |
| Time boundary          | `context.now`, `context.hourOfDay`, `context.dayOfWeek` |
| Glob pattern           | Cedar `like` operator (`"*@team.com"`)                  |
| `deny` policy          | Cedar `forbid` statement                                |
| `allow` policy         | Cedar `permit` statement                                |

### Full Pipeline Example (Natural Language → DSL → Cedar)

```
// 1. User types natural language:
"let openclaw read my team emails for 2 hours"

// 2. NL translator produces AgentGate DSL (shown to user for confirmation):
allow "openclaw" to [read, list] on gmail.messages
  where { from: "*@team.com" }
  for 2h

// 3. Compiler emits Cedar (internal):
permit(
  principal == AgentGate::Agent::"openclaw",
  action in [
    AgentGate::Action::"gmail.messages.read",
    AgentGate::Action::"gmail.messages.list"
  ],
  resource is AgentGate::gmail::Message
) when {
  resource.from like "*@team.com" &&
  context.now >= 1708171200 &&
  context.now <= 1708178400
};
```

---

## Service Bindings

A service binding is the contract between the permission language and a real API. It defines resources, attributes, operations, and how each maps to API endpoints.

### Gmail Binding (Example)

```
service gmail {
  version: "v1"
  spec: "https://gmail.googleapis.com/$discovery/rest?version=v1"

  resource Message {
    attributes {
      id:              from payload "id"                                    requires: minimal
      from:            from header "From"                                   requires: metadata
      to:              from header "To" split ","                           requires: metadata
      subject:         from header "Subject"                                requires: metadata
      labels:          from payload "labelIds" resolve labels.name          requires: minimal
      date:            from payload "internalDate" as timestamp             requires: minimal
      hasAttachment:   from payload "payload.parts[*].filename" as bool(any_nonempty)  requires: full
      snippet:         from payload "snippet"                               requires: minimal
      threadId:        from payload "threadId"                              requires: minimal
      size:            from payload "sizeEstimate"                          requires: minimal
    }

    operations {
      read {
        api: "gmail.users.messages.get"
        method: GET "/users/{userId}/messages/{id}"
        scopes: ["gmail.readonly", "gmail.modify"]
        risk: low
      }
      list {
        api: "gmail.users.messages.list"
        method: GET "/users/{userId}/messages"
        scopes: ["gmail.readonly"]
        risk: low
        pushdown to param "q" {
          from            -> "from:{value}"
          to              -> "to:{value}"
          subject         -> "subject:{value}"
          labels          -> "label:{value}"
          hasAttachment == true -> "has:attachment"
        }
      }
      send {
        api: "gmail.users.messages.send"
        method: POST "/users/{userId}/messages/send"
        scopes: ["gmail.send", "gmail.compose"]
        risk: high
      }
      delete {
        api: "gmail.users.messages.delete"
        method: DELETE "/users/{userId}/messages/{id}"
        scopes: ["gmail.modify"]
        risk: critical
        note: "Permanent delete, not trash."
      }
    }
  }

  resource Settings {
    operations {
      updateForwarding {
        api: "gmail.users.settings.updateAutoForwarding"
        method: PUT "/users/{userId}/settings/autoForwarding"
        risk: critical
        note: "Can redirect all email to external address."
      }
    }
  }
}
```

### Key Properties

1. **Attribute extraction is explicit.** `from: from header "From"` means the engine knows exactly how to pull the `from` field from the API response.
2. **Pushdown is an optimization, not enforcement.** The authoritative check always happens post-fetch.
3. **Coverage is verifiable.** A CI check diffs the binding against the live API spec and flags unbound methods.
4. **Format awareness.** The `requires` field tells the engine what API response detail level is needed to evaluate policies. The proxy upgrades requests to the minimum level needed, evaluates, then strips back.

### Binding Generation Pipeline

Service bindings are generated from API specs in three stages:

1. **Auto-derive** — Parse the API spec (Google Discovery doc, OpenAPI) and extract resources, operations, attributes mechanically.
2. **Heuristic classification** — LLM-assisted operation naming (GET + single item → "read"), attribute friendlification (labelIds → labels), and risk classification.
3. **Human review** — Generator outputs a diff-ready draft with `⚠ REVIEW` flags on items needing judgment. New API methods are always blocked until reviewed.

A weekly CI job fetches the latest API spec, diffs against the current binding, and opens a PR.

---

## Delegation Chains

Multi-agent orchestration is the norm. User Alice uses OpenClaw, which spawns a summarizer, which might call a translation sub-agent. Permissions must narrow at every hop.

### Syntax

```
delegate <user|agent> "<name>" to agent "<name>" {
  <allow statements>
}
```

### Example

```
// User Alice delegates to openclaw — sets the ceiling
delegate user "alice" to agent "openclaw" {
  allow [read, list, draft] on gmail.messages
  allow [read, list] on calendar.events
  allow [read] on drive.files
    where { folder: "/research/**" }
}

// openclaw delegates to summarizer — can only narrow, never widen
delegate agent "openclaw" to agent "summarizer" {
  allow [read] on gmail.messages
    where { labels contains "agent-visible" }
}

// This FAILS at compile time:
delegate agent "openclaw" to agent "summarizer" {
  allow [send] on gmail.messages   // ERROR: openclaw doesn't have "send"
}
```

### Rules

1. **Monotonic narrowing.** Each delegation level is a subset of the parent. Verified at compile time.
2. **Transitive ceiling.** Sub-agent's maximum = intersection of all parent permissions. Computed automatically.
3. **Time inheritance.** Sub-agent's grant cannot outlast the parent's.
4. **Audit chain.** Every action logs the full delegation path: `alice → openclaw → summarizer`.

---

## Cross-Service Flow Rules

When an agent reads sensitive data from one service, it should not freely post that data to another. Flow rules define information flow boundaries.

### Syntax

```
flow "<name>" {
  source: <service>.<resource> [where { <conditions> }]
  block: [<service>.* | <service>.<resource> [where { <conditions> }]]
  allow: [<service>.<resource> [where { <conditions> }]]   // exceptions to block
  retain: <duration> | session
  propagate: true | false
}
```

### Examples

```
// Medical data isolation
flow "medical-data" {
  source: gmail.messages where { from: "*@myclinic.com" }
  source: drive.files where { folder: "/medical/**" }
  block: [slack.*, github.*]
  allow: [drive.files where { folder: "/medical-summaries/**" }]
  retain: 1h
}

// Client confidentiality
flow "client-confidential" {
  source: gmail.messages where { labels contains "confidential" }
  source: github.issues where { label: "client-*" }
  block: [slack.messages where { channel.visibility: "public" }]
  retain: session
}

// Work-personal email wall
flow "work-personal-wall" {
  source: gmail.messages where { account: "personal" }
  block: [gmail.messages where { account: "work" }]
  retain: session
  bidirectional: true
}
```

### How It Works

1. Agent reads a resource matching a `source` condition.
2. The flow name is added to the agent's session taint with a TTL (`retain`).
3. On subsequent requests, the engine checks if the target service/resource is in any active flow's `block` list.
4. If blocked → deny with explanation. If in `allow` → permitted despite block.
5. Taint decays after `retain` duration, or when session ends.
6. If agent A delegates to agent B, B inherits taint by default (opt out with `propagate: false`).

---

## The Compiler

Seven phases transform user intent into Cedar policies, a Cedar schema, and an application sidecar.

```
Natural language → [NL Translate] → AgentGate DSL → Parse → Resolve → Type-check → Delegation → Conflicts → Emit Cedar → [Validate] → Activate
                        ↑                                                                           │                           │
                        └──── repair loop (up to 2×) ◄─────────────────────────────────────────────┘                           │
                                                                                                                  reject if invalid
```

### Phase 0: NL Translation

Natural language + service bindings → AgentGate DSL + human-readable summary. Guardrails: ambiguous input triggers clarifying questions; validation runs before the user sees the confirmation prompt; repair loop retries up to 2x on failure.

### Phases 1-2: Parse + Resolve

Parser produces AST. Resolver links references to service bindings (service, resource, operation, attribute, agent). Error messages are precise:

```
ERROR: Unknown operation "forward" on gmail.messages
  gmail.messages supports: read, list, send, draft, reply, trash, delete, modify, archive
  Did you mean "send"?
```

### Phase 3: Type-check

Validates that conditions use operators valid for the attribute's type.

### Phase 4: Delegation ceiling

Computes the effective permission ceiling for each agent. Rejects policies that exceed the delegation chain.

### Phase 5: Conflict detection (Cedar Analysis)

Cedar's SMT solver detects:

**Errors (block activation):**
- Shadowed allows — an allow that never takes effect because a deny always overrides it
- Delegation ceiling violations
- Cross-service escalation — broader permissions on a dangerous operation than on a safe one

**Warnings (require acknowledgment):**
- Redundancy — policy already covered by a broader one
- Existing policy shadowed by new deny
- Flow contradictions
- Time window overlap

### Phase 6: Emit Cedar

Produces three artifacts:
1. **Cedar schema** (`.cedarschema`) — entity types, action declarations, attribute types
2. **Cedar policy set** (`.cedar`) — `permit` and `forbid` statements
3. **Application sidecar** (`.agentgate.json`) — flow rules, taint config, delegation metadata, pushdown hints, audit config

Final validation: loads emitted Cedar into `cedar-wasm` and calls `validate()`. If it fails, the active set is untouched.

---

## The Runtime Engine

### Request Lifecycle

```
Agent request: "list gmail.messages"
    │
 1. Route — Parse → (service: gmail, resource: messages, action: list)
    │
 2. Load agent context — delegation chain, taint, timebox state
    │
 3. Pre-flight (fail fast) — Agent registered? Timebox expired? Flow-blocked?
    │
 4. Build Cedar request — Construct entities, inject context (now, hourOfDay, dayOfWeek)
    │
 5. Cedar pre-check (no resource attrs) — If unconditional forbid → DENIED (skip API call)
    │
 6. Build backend request — Compute pushdown query from sidecar hints
    │
 7. Call backend API — ~100-500ms (dominant cost)
    │
 8. Extract + Cedar evaluate per result — Build Cedar entity per result, evaluate
    │
 9. Flow taint check per permitted result — Update session taint
    │
10. Return filtered results + audit
```

### Session State

```typescript
interface AgentSession {
  agentId: string;
  sessionId: string;
  startedAt: Date;
  delegationChain: string[];

  // Cedar engine — frozen at compile time, atomic swap on recompilation
  cedarEngine: CedarEngine;
  sidecar: AgentGateSidecar;

  // Flow taint
  taint: Map<string, {
    activatedAt: Date;
    expiresAt: Date | null;
    triggeredBy: string;
  }>;

  // Timebox tracking
  activeGrants: Map<string, {
    expiresAt: Date;
    notifiedExpiring: boolean;
  }>;

  requestCount: number;
  deniedCount: number;
  lastRequestAt: Date;
}
```

### Policy Evaluation

Cedar's own evaluation engine handles policy indexing and matching internally. The application layer adds fast paths:

- Agent not registered → deny
- Service flow-blocked → deny (taint check)
- All grants expired → deny (timebox check)
- No policies reference this service → deny (compiled lookup table)

Policy set updates are atomic. In-flight requests finish with the old set; the next request uses the new one.

### Format Upgrade for Policy Evaluation

When a policy checks attributes that require a richer response format than the agent requested, the proxy upgrades the request, evaluates, then strips back. The agent cannot downgrade the format to evade policies.

---

## Timeboxed Access

Agents should never hold standing access indefinitely. Timeboxed access lets users grant scoped, time-limited permissions that automatically expire.

### Grant Types

| Type       | Description                                  | Example                                      |
|------------|----------------------------------------------|----------------------------------------------|
| `duration` | Relative window from grant time              | "2 hours from now"                           |
| `absolute` | Fixed start/end timestamps                   | "from 9am to 5pm on Feb 18"                  |
| `schedule` | Recurring time windows                       | "weekdays 9am-5pm", "every Monday"           |
| `session`  | Tied to proxy session lifetime               | "until mailcloak stops"                       |

### How It Works

Timeboxing is implemented as Cedar policy conditions on `context.now`, `context.hourOfDay`, and `context.dayOfWeek`. The proxy injects these values into every authorization request.

**Lazy evaluation** — Every request checks `context.now` against policy conditions. Expired policies naturally deny.

**Eager cleanup** — A periodic sweep (every 5 minutes) disables expired policies to keep the set clean.

### Expiry Notifications

```
  [mailcloak] Grant p-007 expires in 10 minutes
  openclaw's read access ends at 12:00 PM

  Options:
  1. Extend by 1 hour
  2. Extend by 2 hours
  3. Make permanent
  4. Let it expire
```

---

## Risk Tiers and Action Control

| Tier     | Behavior (strict)                | Behavior (yolo)          | Examples                                          |
|----------|----------------------------------|--------------------------|---------------------------------------------------|
| Low      | Auto-allow                       | Auto-allow               | read, list, viewEvent, viewFile                   |
| Medium   | Auto-allow, notify user          | Auto-allow               | draft, label, archive, rsvp, downloadFile         |
| High     | Require confirmation             | Auto-allow               | send, reply, createEvent, uploadFile, shareFile   |
| Critical | Always require confirmation      | Require confirmation     | delete, deleteEvent, deleteFile, updateForwarding |

Risk tiers are declared in the service binding per operation. Critical actions always require confirmation, even in yolo mode.

### Confirmation Responses

- **allow** — Execute and add a temporary permit for this action pattern for the session
- **deny** — Block and return denial to agent
- **allow-once** — Execute this one request only, ask again next time
- **edit** — Open the draft/message for the user to modify before executing

---

## Draft-First Safety Model

Default behavior:

- Agent requests to send email
- Mailcloak creates a Gmail draft instead of sending immediately
- Draft is labeled as pending approval

Optional approval paths:

- User approval via chat app (Slack, Telegram)
- Delayed automatic send after configurable time window
- Dead zones prevent sending during sleep hours

Users can always see and edit drafts directly in Gmail.

---

## Just-in-Time Approval System

Sensitive actions can require approval. Approval is delivered via chat platforms:

Initial integrations:

- Slack
- Telegram

Future integrations:

- WhatsApp
- Discord
- Viber

Approval grants a temporary execution token valid for a single operation.

---

## Agent Interface Model

Primary interface:

- Gmail API proxy

Agents interact using:

- Gmail API compatible interface
- IMAP proxy (future)

Optional interface:

- MCP server adapter

MCP is secondary and provided for users who prefer MCP-native agents.

### Agent Identity

Agent identity is bound to authenticated connections, not self-reported. Registration produces a secret token; the proxy resolves token → identity server-side.

```bash
$ mailcloak agent register "openclaw"
  Token: mc_sk_abc123...
```

### Virtual Inbox Abstraction

Each agent experiences a filtered virtual inbox. Mailcloak performs stateless filtering. Agents never see unauthorized emails. Unauthorized emails are completely invisible.

---

## Audit and Transparency System

Mailcloak maintains a complete audit log of all agent actions.

### Audit Entry

```json
{
  "id": "audit-20260217-001",
  "timestamp": "2026-02-17T10:32:15Z",
  "agent": "openclaw",
  "action": "read",
  "resource": {
    "type": "Email",
    "id": "msg-abc123",
    "from": "alice@work.com",
    "subject": "Project update"
  },
  "chain": ["user:alice", "agent:openclaw"],
  "policyDecision": {
    "effect": "permit",
    "matchedPolicies": ["p-001"],
    "tier": "low"
  },
  "flowsActivated": [],
  "confirmationRequired": false,
  "outcome": "executed"
}
```

### Storage Interface

```typescript
interface AuditStore {
  append(entry: AuditEntry): Promise<void>;
  query(filters: AuditFilters): Promise<AuditEntry[]>;
  retention(policy: RetentionPolicy): Promise<void>;
}
```

### Backends

- **File**: `~/.mailcloak/audit/<user>/audit.jsonl` — append-only, rotation by date
- **SQL**: `audit_entries` table
- **Cloud**: S3 or GCS, one file per day per user

### Redaction

```yaml
audit:
  redaction:
    enabled: true
    fields:
      subject: hash
      from: domain_only
      snippet: omit
```

Users can view live activity feed. Full detail via `mailcloak audit show <id> --reveal` with auto-purge after configurable retention.

---

## Security Model

Key principles:

- Zero internal email storage
- Gmail remains source of truth
- Default-deny policy enforcement on every access
- Draft-first sending model
- Explicit approval for sensitive actions
- Complete audit trail
- Delegation narrowing at every hop
- Cross-service flow isolation
- Agent identity via authenticated tokens
- Rate limiting and anomaly detection
- Validated-or-rejected: no policy activated without full compilation

### Abuse Detection

```yaml
security:
  rateLimit:
    perAgent:
      requestsPerMinute: 60
      deniedRequestsBeforeCooldown: 10
  anomalyDetection:
    enabled: true
```

### Lockout Recovery

Policy management commands (the control plane) never pass through the policy engine. Emergency reset:

```bash
$ mailcloak policy reset --emergency
```

---

## Policy Storage

### Policy Shape

```json
{
  "id": "p-001",
  "dsl": "allow \"openclaw\" to [read, list] on gmail.messages where { from: \"*@team.com\" } for 2h",
  "cedar": "permit(principal == AgentGate::Agent::\"openclaw\", action in [...], resource is AgentGate::gmail::Message) when { ... };",
  "naturalLanguage": "Allow openclaw to read team emails for 2 hours",
  "enabled": true,
  "createdAt": "2026-02-17T10:00:00Z",
  "version": 1,
  "timebox": {
    "type": "duration",
    "startsAt": "2026-02-17T10:00:00Z",
    "expiresAt": "2026-02-17T12:00:00Z",
    "autoDisable": true
  }
}
```

### Storage Interface

```typescript
interface PolicyStore {
  load(): Promise<PolicySet>;
  save(policies: PolicySet): Promise<void>;
  addPolicy(policy: Policy): Promise<void>;
  removePolicy(id: string): Promise<void>;
  list(): Promise<PolicySummary[]>;
  history(id: string): Promise<PolicyVersion[]>;
}
```

### Backends

- **File**: `~/.mailcloak/policies.json` — human-editable, git-friendly
- **SQL**: `policies` table with JSON fields
- **Cloud**: JSON blobs in S3 or GCS with bucket versioning

---

## Multi-Account and Multi-Service Support

### Multi-Account Config

```yaml
accounts:
  - name: work
    email:
      backend: gmail
      account: me@work.com
    calendar:
      backend: gcalcli
      account: me@work.com
    drive:
      backend: gdrive
      account: me@work.com
  - name: personal
    email:
      backend: himalaya
      account: me@proton.me
```

Each account is a separate security boundary. The `account` attribute is injected by the proxy (agents cannot forge it). Cross-account flows require explicit flow rules.

### Supported Service Bindings

| Service  | Resource Types | Status |
|----------|----------------|--------|
| Gmail    | Messages, Threads, Labels, Drafts, Settings | MVP |
| Slack    | Messages, Channels | Future |
| GitHub   | Issues, PRs, Repos | Future |
| Calendar | Events, Calendars | Future |
| Drive    | Files, Folders | Future |
| Stripe   | Invoices, Charges | Future |

---

## First-Run Setup Wizard

On first launch with no policies, an interactive wizard bootstraps safe defaults:

```
$ mailcloak setup

  Welcome to Mailcloak! No policies found.
  Let's set up safe defaults for agent access.

  Step 1 of 5 -- Trust mode
  > Strict / Moderate / Yolo

  Step 2 of 5 -- Default access
  > None / Only specific labels / All except specific labels

  Step 3 of 5 -- Sensitive senders
  > Type email addresses or domains to always block

  Step 4 of 5 -- Agent registration
  > Which agents will connect?

  Step 5 of 5 -- Default time limits
  > No time limits / Session-only / Custom duration (e.g., 4h)
  > Enable business-hours-only access? (weekdays 9am-5pm)
```

The wizard generates Cedar policies from answers, shows them in both plain English and Cedar, and asks for confirmation before saving.

---

## CLI Commands

### Policy Management

```bash
# Natural language (primary interface)
mailcloak policy add "let openclaw read my team emails for 2 hours"
mailcloak policy add "block all bots from my clinic emails"

# Advanced: DSL file
mailcloak policy add --file policy.agentgate

# Management
mailcloak policy list
mailcloak policy show p-001
mailcloak policy explain p-001
mailcloak policy disable p-001
mailcloak policy enable p-001
mailcloak policy remove p-001
mailcloak policy validate
mailcloak policy test --dry-run
mailcloak policy export > policies.agentgate
mailcloak policy import policies.agentgate
mailcloak policy migrate --all
```

### Timeboxed Grants

```bash
# Natural language
mailcloak grant "let openclaw read emails for 2 hours"
mailcloak grant "research-bot can view calendar until end of day Friday"

# Explicit flags
mailcloak grant openclaw read --duration 2h
mailcloak grant research-bot viewEvent --until "2026-02-21T17:00:00"
mailcloak grant data-agent viewFile --schedule "weekdays 9-17"
mailcloak grant openclaw read --session

# Management
mailcloak revoke p-007
mailcloak grants
mailcloak grants --expired
```

### Flow Rules

```bash
mailcloak flow add "if an agent reads medical emails, block it from posting to slack or github"
mailcloak flow add "keep work and personal email completely separate"
mailcloak flow list
mailcloak flow show medical-data
mailcloak flow remove medical-data
```

### Agent Management

```bash
mailcloak agent register "openclaw"
mailcloak agent list
mailcloak agent revoke "openclaw"
mailcloak agent sessions
```

### Proxy Control

```bash
mailcloak start
mailcloak start --yolo
mailcloak stop
mailcloak status
```

### Audit

```bash
mailcloak audit
mailcloak audit --agent openclaw
mailcloak audit --denied
mailcloak audit --flow medical-data
mailcloak audit show audit-001 --reveal
```

### Service Bindings

```bash
mailcloak binding list
mailcloak binding show gmail
mailcloak binding check
mailcloak binding generate gmail
mailcloak binding coverage
```

### Quick Thread Toggles

```bash
mailcloak allow thread 18e3f...
mailcloak block thread 18e3f...
```

---

## Edge Cases

### Policy Testing (Dry-Run)

Policies can be added in dry-run mode — compiled and evaluated alongside the active set, but not enforced. Dry-run policies auto-discard after 24 hours if not promoted.

### OAuth Scope Alignment

The compiler cross-references policy grants against OAuth scopes in the service binding. A policy granting `send` when the token only has `gmail.readonly` triggers a compile-time warning.

### Policy Migration

Policies store their AgentGate DSL version. New compilers support all prior versions. The `migrate` command rewrites policies to the latest version with a diff and confirmation.

### Partial API Responses

Missing attributes → default-deny for that condition. The proxy upgrades the API request to the minimum detail level needed for policy evaluation.

### Response Injection

Attribute extraction is type-safe and bounded. String values truncated at `MAX_ATTRIBUTE_LENGTH`. No `eval()`, no interpolation.

### Pagination

Post-fetch filtering can reduce page sizes. Optionally, the proxy fetches additional pages to fill the gap:

```yaml
pagination:
  fillPages: true
  maxFetches: 3
```

---

## MVP Scope

Included:

- Gmail OAuth integration
- Gmail API proxy (search, read, archive)
- Classification and Gmail labels
- Cedar policy engine with AgentGate DSL compiler
- Natural language policy definition
- Service binding for Gmail
- Draft creation (no auto-send initially)
- Timeboxed access
- Audit logging
- Slack or Telegram approval integration
- First-run setup wizard

Excluded initially:

- Outlook support
- IMAP proxy
- Automatic send without approval
- Multi-service integrations (Slack, GitHub, Drive, Calendar, Stripe bindings)
- Delegation chains
- Cross-service flow rules
- Binding generation pipeline

---

## Project Structure

```
mailcloak/
├── package.json
├── tsconfig.json
├── bin/
│   └── mailcloak.ts                       # CLI entry point
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── start.ts                  # Proxy start/stop
│   │   │   ├── policy.ts                 # Policy CRUD
│   │   │   ├── grant.ts                  # Timeboxed grants
│   │   │   ├── flow.ts                   # Flow rule management
│   │   │   ├── agent.ts                  # Agent registration
│   │   │   ├── binding.ts               # Service binding management
│   │   │   ├── audit.ts                 # Audit queries
│   │   │   └── setup.ts                 # First-run wizard
│   │   └── confirmation.ts              # User prompts for high-risk actions
│   ├── nl/
│   │   ├── translator.ts               # Natural language → AgentGate DSL
│   │   ├── prompt.ts                   # LLM prompt templates with binding context
│   │   ├── clarifier.ts               # Detect ambiguity, generate follow-up questions
│   │   └── summary.ts                 # DSL → human-readable confirmation summary
│   ├── compiler/
│   │   ├── parser.ts                    # Source → AST
│   │   ├── resolver.ts                  # AST → Resolved AST (bind to services)
│   │   ├── typechecker.ts              # Validate conditions against attribute types
│   │   ├── delegation.ts               # Compute + verify delegation ceilings
│   │   ├── conflicts.ts                # Cedar Analysis — SMT-based conflict detection
│   │   ├── emitter.ts                  # Resolved AST → Cedar policies + schema + sidecar
│   │   ├── cedar-schema.ts             # Generate .cedarschema from service bindings
│   │   ├── validator.ts                # Final gate: load emitted Cedar, validate
│   │   └── errors.ts                   # Rich error messages with suggestions
│   ├── runtime/
│   │   ├── engine.ts                   # Request evaluation hot path (wraps cedar-wasm)
│   │   ├── cedar.ts                    # Cedar engine init, schema/policy loading, swap
│   │   ├── session.ts                  # Per-agent session state
│   │   ├── context.ts                  # Build Cedar context (now, hourOfDay, dayOfWeek)
│   │   ├── extractor.ts               # Extract attributes → Cedar entity attrs
│   │   ├── pushdown.ts                # Generate backend query params from sidecar hints
│   │   └── filter.ts                  # Post-fetch result filtering
│   ├── timebox/
│   │   ├── grants.ts                  # Grant creation, duration/schedule parsing
│   │   ├── expiry.ts                  # Lazy eval + eager cleanup sweep
│   │   └── notifications.ts          # Pre-expiry warnings, extension prompts
│   ├── flows/
│   │   ├── taint.ts                   # Session taint tracking
│   │   ├── propagation.ts            # Delegation-linked taint propagation
│   │   └── matcher.ts                # Match resources against flow sources
│   ├── bindings/
│   │   ├── loader.ts                  # Load + validate service bindings
│   │   ├── generator/
│   │   │   ├── discovery.ts          # Parse Google Discovery docs
│   │   │   ├── openapi.ts            # Parse OpenAPI specs
│   │   │   ├── heuristics.ts         # Operation naming, attribute classification
│   │   │   └── reviewer.ts           # Flag items for human review
│   │   └── diff.ts                   # Diff binding against live API spec
│   ├── backends/
│   │   ├── types.ts                  # ResourceBackend interface
│   │   ├── gmail/                    # Gmail API
│   │   ├── slack/                    # Slack API (future)
│   │   └── github/                   # GitHub API (future)
│   ├── security/
│   │   ├── auth.ts                   # Agent token authentication
│   │   ├── rate-limiter.ts           # Per-agent rate limiting
│   │   ├── anomaly.ts               # Query probing detection
│   │   └── redaction.ts             # Audit log redaction
│   ├── storage/
│   │   ├── types.ts                  # PolicyStore, AuditStore, SessionStore
│   │   ├── file.ts                   # File backend
│   │   ├── sql.ts                    # SQL backend
│   │   └── cloud.ts                 # S3/GCS backend
│   └── config/
│       └── loader.ts                 # Config file loading
├── bindings/
│   ├── gmail.binding                 # Gmail service binding
│   ├── slack.binding                 # Slack service binding (future)
│   ├── github.binding                # GitHub service binding (future)
│   ├── calendar.binding              # Google Calendar binding (future)
│   ├── drive.binding                 # Google Drive binding (future)
│   └── stripe.binding                # Stripe binding (future)
├── schemas/
│   ├── agentgate.grammar             # Formal grammar for the permission language
│   └── agentgate.cedarschema         # Generated Cedar schema
├── policies/                            # Compiled output (gitignored)
│   ├── compiled.cedar
│   ├── schema.cedarschema
│   └── sidecar.agentgate.json
├── test/
│   ├── compiler/
│   ├── runtime/
│   ├── cedar/
│   ├── timebox/
│   ├── flows/
│   ├── bindings/
│   ├── security/
│   └── fixtures/
└── defaults/
    ├── base-policies.agentgate
    └── base-flows.agentgate
```

### Key Dependencies

- `@cedar-policy/cedar-wasm` — Cedar evaluation engine + schema validation + analysis
- `@anthropic-ai/sdk` — LLM for natural language → DSL translation, binding generation heuristics
- `commander` — CLI framework
- `inquirer` — Interactive prompts (wizard, confirmations, NL policy review)
- `zod` — Runtime validation for API response shapes + sidecar config
- `luxon` — Timezone-aware date/time for schedules and timebox computation
- `nearley` or `chevrotain` — Parser generator for the AgentGate DSL grammar

---

## Business Model

Pricing model:

- Per connected inbox per month
- Includes email usage quota
- Additional usage billed as overage

Target positioning:

Serious SaaS product with potential expansion into platform infrastructure.

---

## Brand

Product name:

Mailcloak.ai

Positioning:

Secure email access layer for AI agents.

Core value proposition:

Control what AI agents can see and do in your inbox.

---

## Summary

Mailcloak.ai provides a secure, policy-driven, stateless proxy layer that enables safe AI agent access to email and other services.

It enforces fine-grained permissions through the AgentGate permission language — a natural language → DSL → Cedar compilation pipeline with formal verification, delegation chains, cross-service flow isolation, and timeboxed access.

It protects sensitive information, enables safe automation, and builds user trust through transparency, auditability, and control.

It serves as foundational infrastructure for the future of autonomous AI systems.
