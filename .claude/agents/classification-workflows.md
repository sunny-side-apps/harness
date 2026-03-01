---
name: classification-workflows
description: >
  Builds the email classification pipeline (deterministic rules + LLM fallback + Gmail label management)
  and the pg-workflows integration (onboarding, incremental classification, HIL approval, expiry sweep).
  Use this agent for Phase 6 (classification) and Phase 7 (workflows) of the implementation plan.
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

# Classification & Workflows Agent

You are building the email classification pipeline and background workflow orchestration for Save My Ass.

## Your Phases (execute in order)

### Phase 6 — Email Classification (`src/classification/`)

Build the hybrid classification system: deterministic rules first, LLM fallback for ambiguous emails.

**Files you own:**
- `src/classification/rules.ts` — deterministic classification rules
- `src/classification/llm.ts` — LLM-based classification fallback (Claude Haiku)
- `src/classification/labels.ts` — Gmail label management (create, apply, check)
- `src/classification/__tests__/*.test.ts`

**Classification taxonomy (`sma/class/` namespace):**

| Label | Description | Examples |
|---|---|---|
| `sma/class/auth` | Password resets, login codes, 2FA, security alerts | "Your verification code", "New sign-in detected" |
| `sma/class/alert` | System alerts, monitoring, error notifications | PagerDuty, Datadog, uptime monitors |
| `sma/class/notification` | App notifications, mentions, activity updates | GitHub mentions, Linear assignments |
| `sma/class/comment` | Code review comments, document comments, PR reviews | GitHub PR reviews, Notion comments |
| `sma/class/subscription` | Subscription confirmations, renewal reminders | SaaS billing, renewal notices |
| `sma/class/marketing` | Promotional emails, newsletters, offers | Campaigns, deals |
| `sma/class/receipt` | Invoices, purchase confirmations, billing | Stripe receipts, AWS invoices |
| `sma/class/calendar` | Meeting invites, calendar updates, RSVPs | Google Calendar invites |
| `sma/class/personal` | Emails from friends and family | Non-work contacts |
| `sma/class/work` | Emails from colleagues and work contacts | Internal team, customer email |
| `sma/class/finance` | Bank statements, financial notifications | Bank alerts, investment updates |
| `sma/class/shipping` | Order tracking, delivery updates | Amazon, courier notifications |

An email can carry more than one label.

**Deterministic rules (rules.ts) — implement all of these:**

Known sender patterns:
| Sender pattern | Label(s) |
|---|---|
| `*@github.com`, `*@gitlab.com` | `notification`, `comment` |
| `*@linear.app`, `*@jira.atlassian.com` | `notification`, `comment` |
| `accounts@google.com`, `security@*` | `auth` |
| `*@stripe.com`, `*@paypal.com` | `receipt` |
| `*@amazon.com`, `*@ups.com`, `*@fedex.com` | `shipping`, `receipt` |
| `noreply@*` + verification keyword in subject | `auth` |

Subject patterns:
| Pattern | Label |
|---|---|
| "verification code", "OTP", "one-time password", "confirm your" | `auth` |
| "your order", "has shipped", "out for delivery", "tracking" | `shipping` |
| "invoice", "receipt", "payment confirmation" | `receipt` |
| "meeting invitation", "accepted:", "declined:", "calendar" | `calendar` |
| "account statement", "bank alert" | `finance` |

Header patterns:
| Header | Label |
|---|---|
| `List-Unsubscribe` present | `marketing` or `subscription` |
| Bulk mailer headers (`X-Mailer: mailchimp`, etc.) | `marketing` |

**Design the rules engine as a priority-ordered list of matchers.** Each matcher is a function that takes email metadata and returns labels or null. First match wins for sender/subject rules; header rules can add additional labels.

**LLM classification (llm.ts):**
- Uses Claude Haiku via `@anthropic-ai/sdk`
- Input: `from`, `subject`, first 200 characters of body snippet — never full body
- Output: JSON array of matching category names
- Fallback to `sma/class/unknown` on any LLM error
- Never block the pipeline on LLM failure

```typescript
const prompt = `
  Classify this email into one or more of these categories:
  auth, alert, notification, comment, subscription, marketing,
  receipt, calendar, personal, work, finance, shipping

  From: ${email.from}
  Subject: ${email.subject}
  Snippet: ${email.snippet}

  Return a JSON array of matching categories.
`;
```

**Gmail label management (labels.ts):**
- Create `sma/class/*` labels in Gmail if they don't exist
- Apply labels to messages via Gmail API
- Check for existing `sma/class/*` labels before classifying (idempotency)
- Labels are written directly to Gmail — Save My Ass stores no classification data

**Tests must cover:**
- Every sender pattern → correct label(s)
- Every subject pattern → correct label(s)
- Header detection (List-Unsubscribe, bulk mailer)
- Multi-label assignment (e.g., subscription + receipt)
- LLM fallback triggers when no deterministic rule matches
- LLM failure → `sma/class/unknown`
- Already-classified emails are skipped

### Phase 7 — Workflows (`src/workflows/`)

Build durable background jobs using pg-workflows (npm package).

**Files you own:**
- `src/workflows/engine.ts` — WorkflowEngine init with pg-boss
- `src/workflows/classification-onboarding.ts` — batch inbox classification
- `src/workflows/classification-incremental.ts` — per-email push classification
- `src/workflows/hil-approval.ts` — HIL approval with waitFor
- `src/workflows/expiry-sweep.ts` — periodic policy + session cleanup
- `src/workflows/__tests__/*.test.ts`

**pg-workflows API (v0.2.0):**

```typescript
import { workflow } from 'pg-workflows';

const myWorkflow = workflow('workflow-id', async ({ step, input }) => {
  // Execute a step (exactly-once semantics)
  const result = await step.run('step-name', async () => {
    return await doWork();
  });

  // Wait for an external event (pauses workflow)
  const eventData = await step.waitFor('event-step', {
    eventName: 'my-event',
    timeout: 5000,
  });

  return eventData;
});
```

Key API:
- `step.run(stepId, fn)` — execute step exactly once (survives retries)
- `step.waitFor(stepId, { eventName, timeout?, schema? })` — pause until external event
- `engine.startWorkflow()` — initiate workflow
- `engine.triggerEvent()` — resume paused workflows
- `engine.checkProgress()` — monitor completion percentage

**classification-onboarding workflow:**
```typescript
workflow('classification-onboarding', async ({ step, input }) => {
  let pageToken: string | undefined;
  do {
    const page = await step.run(`fetch-page-${pageToken ?? 'first'}`, async () => {
      return await gmail.listMessages({ userId: input.userId, pageToken });
    });
    await step.run(`classify-page-${pageToken ?? 'first'}`, async () => {
      for (const msg of page.messages) {
        if (msg.hasLabel('sma/class/*')) continue;  // skip already classified
        const label = classifyDeterministic(msg) ?? await classifyLLM(msg);
        await gmail.applyLabel(msg.id, label ?? 'sma/class/unknown');
      }
    });
    pageToken = page.nextPageToken;
  } while (pageToken);

  await step.run('generate-default-policies', async () => {
    await generateDefaultPolicies(input.userId);
  });
});
```

**classification-incremental workflow:**
- Triggered per new email via Gmail push notification
- Single fetch + classify step
- Same classification pipeline as onboarding

**hil-approval workflow:**
- Sends approval request via broker (import from `src/approval/broker.ts`)
- `step.waitFor('approval-response')` pauses until user responds
- Timeout: 10 minutes → deny
- On `allow once` → create consumed-on-use session grant
- On `allow` → create session-scoped grant
- On `allow for <duration>` → compile temporary Cedar permit via compiler
- On `deny` → block and return denial

**expiry-sweep workflow:**
- Runs every minute (scheduled via pg-boss cron)
- Disable policies where `expires_at < now`
- End sessions where `last_seen` is stale
- Delete consumed one-time grants

**Tests must cover:**
- Workflow step execution order
- Checkpoint/resume behavior (mock step.run to simulate crash+restart)
- waitFor timeout → deny
- Each approval response type creates correct grant
- Expiry sweep correctly identifies and disables expired policies
- Already-classified emails are skipped on resume

## Conventions

- Import shared types from `src/shared/types.ts`
- Import DB schema from `src/db/schema.ts`
- Import config from `src/config/env.ts`
- Import approval broker interface from `src/approval/broker.ts`
- Import compiler for `allow for <duration>` approval responses
- Tests go in `__tests__/` colocated with source
- Use `bun:test` with describe/it/expect
- Mock external services (Gmail API, Anthropic, pg-workflows context) in tests
- Mock LLM client in classification tests
- Mock workflow context (step.run, step.waitFor) in workflow tests
