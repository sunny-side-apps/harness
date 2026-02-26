# Permission Language (AgentGate DSL)

## How Users Define Policies

Most users write natural language. The system translates it to the AgentGate DSL, validates through the full compiler pipeline, shows the structured result with validation status, and asks for confirmation before activating:

```
$ sma policy add "let openclaw read my team emails for the next 2 hours"

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
    ✓ Cedar schema validation passed

  [Confirm] [Edit] [Cancel]
```

When validation fails, the policy is not activated and the user sees the exact problem:

```
$ sma policy add "let openclaw send emails to anyone"

  Validation FAILED:
    ✗ "send" requires approval — openclaw has no approval channel configured.
    → Run: sma agent set-approval openclaw --channel slack

  Policy was NOT activated. [Edit] [Cancel]
```

---

## DSL Syntax

Every policy is an `allow` or `deny` statement:

```
allow <agent> to [<operations>] on <service>.<resource>
  [where { <conditions> }]
  [for <duration> | during <schedule> | until <timestamp> | for session]
  [requires approval [for [<operations>]]]

deny <agent> to [<operations>] on <service>.<resource>
  [where { <conditions> }]
```

---

## Examples

| User says | DSL output |
|-----------|------------|
| "let openclaw read team emails for 2 hours" | `allow "openclaw" to [read, list] on gmail.messages where { from: "*@team.com" } for 2h` |
| "block my clinic emails from all agents" | `deny * to [*] on gmail.messages where { from: "*@myclinic.com" }` |
| "openclaw can read work emails during business hours" | `allow "openclaw" to [read, list] on gmail.messages where { labels contains "sma/class/work" } during weekdays(9, 17)` |
| "research-bot can read notifications but must ask before archiving" | `allow "research-bot" to [read, list, archive] on gmail.messages where { labels contains "sma/class/notification" } requires approval for [archive]` |
| "let scheduler read my calendar emails until Friday" | `allow "scheduler" to [read, list] on gmail.messages where { labels contains "sma/class/calendar" } until "2026-02-28T17:00:00"` |

---

## Design Choices

- **`*` is a wildcard** for agents and operations. `deny * to [*] on gmail.messages` blocks all agents from all Gmail operations.
- **`deny` always wins over `allow`.** No ambiguity. If both match, deny takes precedence (Cedar `forbid` semantics).
- **Operations are known verbs** (read, list, send, draft, archive, trash), not raw HTTP methods.
- **Conditions use email attributes directly** (from, to, subject, labels, date). Referencing a nonexistent attribute is a compile-time error.
- **Time is first-class.** `for 2h`, `during weekdays(9, 17)`, `until <timestamp>`, `for session`.
- **`requires approval` is application-layer.** It produces a `pending_approval` outcome, not a Cedar permit or forbid.

---

## Condition Operators

| Type        | Operators                                                              |
|-------------|------------------------------------------------------------------------|
| `String`    | `==`, `!=`, `like` (glob with `*`), `startsWith`, `endsWith`          |
| `Set<String>` | `contains`, `containsAny`, `containsAll`, `isEmpty`                 |
| `Long`      | `==`, `!=`, `>`, `<`, `>=`, `<=`                                      |
| `Bool`      | `==`, `!=`                                                             |

---

## Time Boundaries

| Construct             | Compiles to                                              | Example                     |
|-----------------------|----------------------------------------------------------|-----------------------------|
| `for <duration>`      | `context.grantedAt + <seconds> > context.now`           | `for 2h`                    |
| `until <timestamp>`   | `context.now < <unix_timestamp>`                         | `until "2026-03-01T00:00"`  |
| `during <schedule>`   | `context.dayOfWeek` and `context.hourOfDay` conditions   | `during weekdays(9, 17)`    |
| `for session`         | Application sidecar — tied to agent session lifetime     | `for session`               |

`for session` cannot be expressed in Cedar. It is stored in the application sidecar and evaluated by the PolicyEngine at request time.

---

## What Cedar Handles vs the Application Sidecar

The compiler emits two artifacts:

**1. Cedar policy set** — evaluated by the Cedar policy engine on every request:
- `allow` / `deny` rules
- Attribute conditions (`where { from: "*@team.com" }`)
- Time windows (`for 2h`, `until`, `during weekdays`)

**2. Application sidecar** — evaluated by the PolicyEngine alongside Cedar:
- `requires approval` — produces `pending_approval` outcome instead of permit/deny
- `for session` — checked against active session state

The PolicyEngine exposes a single interface regardless of which layer produces the decision:

```typescript
type PolicyDecision =
  | { effect: 'permit' }
  | { effect: 'deny';             reason: string }
  | { effect: 'pending_approval'; approvalId: string };

PolicyEngine.evaluate(request: PolicyRequest): PolicyDecision
```

---

## Cedar Schema

```cedar
namespace AgentGate {

  // Agent is the principal — one entity per registered agent
  entity Agent;

  // Gmail message — attributes available in policy conditions
  entity GmailMessage {
    from:     String,
    to:       Set<String>,
    subject:  String,
    labels:   Set<String>,
    date:     Long,
    threadId: String,
  };

  // Gmail thread
  entity GmailThread {
    from:    Set<String>,
    subject: String,
    labels:  Set<String>,
    date:    Long,
  };

  // Gmail actions
  action "gmail:messages:read"
    appliesTo { principal: Agent, resource: GmailMessage };
  action "gmail:messages:list"
    appliesTo { principal: Agent, resource: GmailMessage };
  action "gmail:messages:draft"
    appliesTo { principal: Agent, resource: GmailMessage };
  action "gmail:messages:send"
    appliesTo { principal: Agent, resource: GmailMessage };
  action "gmail:messages:archive"
    appliesTo { principal: Agent, resource: GmailMessage };
  action "gmail:messages:trash"
    appliesTo { principal: Agent, resource: GmailMessage };
}
```

---

## Full Pipeline Example (NL → DSL → Cedar)

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
    AgentGate::Action::"gmail:messages:read",
    AgentGate::Action::"gmail:messages:list"
  ],
  resource is AgentGate::GmailMessage
) when {
  resource.from like "*@team.com" &&
  context.grantedAt + 7200 > context.now
};

// 4. Context injected on every request:
{
  "now":        1740571200,
  "grantedAt":  1740564000,
  "hourOfDay":  14,
  "dayOfWeek":  3
}
```

---

## Schedule Example (NL → DSL → Cedar)

```
// 1. User types:
"openclaw can read work emails on weekdays between 9am and 5pm"

// 2. DSL:
allow "openclaw" to [read, list] on gmail.messages
  where { labels contains "sma/class/work" }
  during weekdays(9, 17)

// 3. Cedar — schedule expands to dayOfWeek and hourOfDay conditions:
permit(
  principal == AgentGate::Agent::"openclaw",
  action in [
    AgentGate::Action::"gmail:messages:read",
    AgentGate::Action::"gmail:messages:list"
  ],
  resource is AgentGate::GmailMessage
) when {
  resource.labels.contains("sma/class/work") &&
  context.dayOfWeek >= 1 && context.dayOfWeek <= 5 &&
  context.hourOfDay >= 9 && context.hourOfDay < 17
};
```

---

## Requires Approval Example (NL → DSL → Sidecar)

```
// 1. User types:
"research-bot can archive notifications but must ask me first"

// 2. DSL:
allow "research-bot" to [read, list, archive] on gmail.messages
  where { labels contains "sma/class/notification" }
  requires approval for [archive]

// 3. Cedar — permits read and list unconditionally:
permit(
  principal == AgentGate::Agent::"research-bot",
  action in [
    AgentGate::Action::"gmail:messages:read",
    AgentGate::Action::"gmail:messages:list"
  ],
  resource is AgentGate::GmailMessage
) when {
  resource.labels.contains("sma/class/notification")
};

// 4. Application sidecar — archive requires approval:
{
  "requiresApproval": ["gmail:messages:archive"]
}

// At request time, PolicyEngine checks sidecar first:
// agent requests archive → effect: pending_approval (Cedar never reached for this action)
```

---

## Human-in-the-Loop (HIL) Approval

When a `pending_approval` decision is returned, an approval request is sent to the user via their configured channel (Slack or Telegram). The approver chooses the scope of the grant:

| Response | Effect | Implementation |
|---|---|---|
| `allow once` | Permits this single request only | Sidecar one-time grant, consumed after use |
| `allow` | Permits for the rest of the session | Sidecar session-scoped grant |
| `allow for <duration>` | Permits for a time window | Temporary Cedar permit, auto-expires |
| `deny` | Blocks the request | No policy created |

**`allow for <duration>`** reuses the compiler pipeline — the approver's response is compiled into a temporary Cedar permit identical to a `for 2h` policy, tagged with `source: "approval"` so it can be distinguished in the audit log and revoked independently.

```
Approver responds: "allow for 2h"

→ Compiler emits temporary Cedar permit:
permit(
  principal == AgentGate::Agent::"research-bot",
  action == AgentGate::Action::"gmail:messages:archive",
  resource is AgentGate::GmailMessage
) when {
  resource.labels.contains("sma/class/notification") &&
  context.now < <approvalTime + 7200>
};

→ Stored in PostgreSQL:
  source:    "approval"
  expiresAt: <approvalTime + 7200>
  autoExpire: true
```

**`allow once`** is stored in the application sidecar as a consumed-on-use token — it never enters Cedar. After the request executes, the token is deleted.

**`allow` (session)** is stored in the sidecar as a session-scoped grant tied to the agent's current session. It disappears when the session ends.

Approval channel is configured per agent, not per policy:
```bash
sma agent set-approval openclaw --channel slack
sma agent set-approval research-bot --channel telegram
```

---

## Cedar Validation

After emitting Cedar, the compiler validates the policy set against the schema using the official Cedar validator before storing anything. If validation fails, the policy is rejected and the active set is untouched.

```typescript
import { PolicySet, Schema } from '@cedar-policy/cedar-wasm';

const schema = Schema.fromJson(agentGateSchema);
const policies = PolicySet.fromString(emittedCedar);
const result = policies.validate(schema);

if (!result.ok) {
  throw new CompilerError(result.errors);
}
```

Validation catches:
- Unknown entity types or actions
- Unknown or misspelled attributes (e.g. `resource.fron` instead of `resource.from`)
- Type mismatches in conditions (e.g. using `>` on a `String`)

---

## Coming Soon

**Delegation chains** — multi-agent orchestration where permissions narrow at every hop:
```
delegate agent "openclaw" to agent "summarizer" {
  allow [read] on gmail.messages where { labels contains "sma/class/work" }
}
```
Permissions are verified at compile time to be a strict subset of the parent agent's grants.

**Cross-service flow rules** — when an agent reads sensitive data from one service, block it from posting to another. Requires a second service integration to be meaningful.
