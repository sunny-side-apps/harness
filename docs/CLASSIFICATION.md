# Email Classification

## Purpose

Classification is the foundation for meaningful policies. Without it, users can only write policies based on raw attributes like sender address or subject keywords. With it, they can write policies like:

```
deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }
allow "openclaw" to [read] on gmail.messages where { labels contains "sma/class/work" }
```

When a user signs up, Save My Ass runs a classification job across their entire inbox and applies Gmail labels. These labels persist in Gmail and are available immediately as policy conditions. New emails are classified in real time as they arrive.

---

## Classification Taxonomy

Labels are written directly to Gmail under the `sma/class/` namespace. Save My Ass stores no classification data internally — Gmail is the classification store.

| Label | Description | Examples |
|---|---|---|
| `sma/class/auth` | Password resets, login codes, 2FA, security alerts | "Your verification code", "New sign-in detected" |
| `sma/class/alert` | System alerts, monitoring, error notifications | PagerDuty, Datadog, uptime monitors |
| `sma/class/notification` | App notifications, mentions, activity updates | GitHub mentions, Linear assignments, Slack digests |
| `sma/class/comment` | Code review comments, document comments, PR reviews | GitHub PR reviews, Notion comments, Google Docs |
| `sma/class/subscription` | Subscription confirmations, renewal reminders | SaaS billing, renewal notices |
| `sma/class/marketing` | Promotional emails, newsletters, offers | Product updates, campaigns, deals |
| `sma/class/receipt` | Invoices, purchase confirmations, billing | Stripe receipts, AWS invoices |
| `sma/class/calendar` | Meeting invites, calendar updates, RSVPs | Google Calendar invites, accepted/declined replies |
| `sma/class/personal` | Emails from friends and family | Non-work contacts |
| `sma/class/work` | Emails from colleagues and work contacts | Internal team email, customer email |
| `sma/class/finance` | Bank statements, financial notifications | Bank alerts, investment updates |
| `sma/class/shipping` | Order tracking, delivery updates | Amazon, courier notifications |

An email can carry more than one label (e.g. a receipt from a subscription is both `sma/class/receipt` and `sma/class/subscription`).

---

## Classification Pipeline

Classification uses a hybrid approach: deterministic rules first, LLM fallback for anything ambiguous.

### Stage 1 — Deterministic rules

Fast, cheap, and handles the majority of emails. Rules match on sender address, subject patterns, and email headers.

**Known sender patterns:**
| Sender pattern | Label(s) |
|---|---|
| `*@github.com`, `*@gitlab.com` | `notification`, `comment` |
| `*@linear.app`, `*@jira.atlassian.com` | `notification`, `comment` |
| `accounts@google.com`, `security@*` | `auth` |
| `*@stripe.com`, `*@paypal.com` | `receipt` |
| `*@amazon.com`, `*@ups.com`, `*@fedex.com` | `shipping`, `receipt` |
| `noreply@*` + verification keyword in subject | `auth` |

**Subject patterns:**
| Pattern | Label |
|---|---|
| "verification code", "OTP", "one-time password", "confirm your" | `auth` |
| "your order", "has shipped", "out for delivery", "tracking" | `shipping` |
| "invoice", "receipt", "payment confirmation" | `receipt` |
| "meeting invitation", "accepted:", "declined:", "calendar" | `calendar` |
| "account statement", "bank alert" | `finance` |

**Header patterns:**
| Header | Label |
|---|---|
| `List-Unsubscribe` present | `marketing` or `subscription` |
| Bulk mailer headers (`X-Mailer: mailchimp`, etc.) | `marketing` |

### Stage 2 — LLM classification

Emails that don't match deterministic rules are classified by an LLM (Claude Haiku — fast and cost-effective).

- **Input:** `from`, `subject`, and the first 200 characters of the body snippet — never the full body
- **Output:** one or more labels from the taxonomy above
- **Privacy:** snippet only, no full email content leaves the classification pipeline

```typescript
// Classification prompt (simplified)
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

---

## Onboarding Batch Job

When a user signs up, Save My Ass immediately starts a `classification-onboarding` workflow via **pg-workflows**. The workflow runs as a durable background job — it checkpoints after every page, resumes automatically after crashes, and retries failed LLM calls with exponential backoff.

```typescript
// classification-onboarding workflow (simplified)
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

**Idempotency:** Each page is a named step — pg-workflows' exactly-once semantics skip already-completed steps on resume. Messages with an existing `sma/class/*` label are skipped. LLM timeouts fall back to `sma/class/unknown` and do not block the page.

**Scope:** Full inbox history. The user can start using Save My Ass immediately while it processes.

**Progress:** Query via `engine.checkProgress({ runId, resourceId: userId })` — surfaced in the dashboard as a percentage.

---

## Incremental Classification

New emails are classified in real time using Gmail push notifications. Each notification triggers a `classification-incremental` workflow via **pg-workflows**.

```bash
sma gmail watch   # registers a Gmail push notification subscription
```

When Gmail delivers a push notification for a new message, the API server starts a workflow:

```typescript
workflow('classification-incremental', async ({ step, input }) => {
  const msg = await step.run('fetch', async () =>
    gmail.getMessage(input.messageId)
  );

  await step.run('classify', async () => {
    if (msg.hasLabel('sma/class/*')) return;  // already classified
    const label = classifyDeterministic(msg) ?? await classifyLLM(msg);
    await gmail.applyLabel(msg.id, label ?? 'sma/class/unknown');
  });
});
```

Retries and LLM failures are handled automatically by pg-workflows with exponential backoff. This keeps labels current without polling.

---

## Initial Default Policies

After the onboarding batch job completes, Save My Ass generates a set of safe default policies based on what was found in the inbox. These are presented to the user for review and confirmation — not activated silently.

**Default deny policies (protect sensitive categories):**
```
deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }
deny * to [*] on gmail.messages where { labels contains "sma/class/finance" }
```

**Shown to user as:**
```
  Suggested default policies based on your inbox:

  ✗ Block all agents from authentication emails (2FA, password resets)
  ✗ Block all agents from financial emails (bank statements, alerts)

  These protect your most sensitive email categories.
  You can always change these later with: sma policy add / remove

  [Apply defaults] [Review each] [Skip]
```

These defaults give users a safe starting point without requiring them to understand the policy system on day one.

---

## Gmail as the Classification Store

Save My Ass writes classification results directly to Gmail as labels. It stores no classification data internally.

**Benefits:**
- Classification persists if Save My Ass is removed
- Labels are visible in Gmail — users can see and verify them
- No additional storage or sync required
- Gmail label search can be used directly in `sma gmail search`

**Label management:**
```bash
sma gmail labels list          # see all sma/class/* labels
sma gmail labels reclassify    # re-run classification on all emails
```

---

## Email Provider Support

**Current:** Gmail via Google OAuth (managed by Clerk).

**Future:** IMAP and Microsoft Outlook. The classification pipeline is provider-agnostic — only the label-writing mechanism changes per provider.
