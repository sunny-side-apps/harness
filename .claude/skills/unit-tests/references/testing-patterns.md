# Testing Patterns by Module Type

## Route Handlers (Hono)

Test each route's request/response cycle. Mock dependencies (db, external APIs).

```typescript
import { describe, it, expect, mock } from "bun:test";
import { Hono } from "hono";
import { agentsRoute } from "../routes/agents";

describe("POST /agents", () => {
  it("creates agent and returns key once", async () => {
    const app = new Hono().route("/agents", agentsRoute);
    const res = await app.request("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openclaw", userId: "user_123" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^sma_/);
  });

  it("rejects unauthenticated requests", async () => {
    const app = new Hono().route("/agents", agentsRoute);
    const res = await app.request("/agents", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
```

## Compiler Pipeline (Parser / Resolver / Typechecker / Emitter)

Each compiler phase is a pure function — test inputs and outputs directly.

```typescript
import { describe, it, expect } from "bun:test";
import { parse } from "../compiler/parser";

describe("parser", () => {
  it("parses allow rule with time boundary", () => {
    const ast = parse('allow read from:"team@co.com" for:2h');
    expect(ast.action).toBe("read");
    expect(ast.conditions).toContainEqual({
      type: "time_boundary",
      kind: "for",
      value: "2h",
    });
  });

  it("rejects invalid action", () => {
    expect(() => parse("allow nuke")).toThrow(/unknown action/i);
  });
});
```

## Cedar Policy Runtime

Test policy evaluation with known policy sets and request contexts.

```typescript
import { describe, it, expect } from "bun:test";
import { evaluate } from "../runtime/engine";

describe("policy engine", () => {
  const denyAllPolicy = `forbid(principal, action, resource);`;
  const allowReadPolicy = `permit(principal, action == Action::"read", resource);`;

  it("default-deny when no policies match", () => {
    const result = evaluate([], { action: "read", agentId: "a1" });
    expect(result.decision).toBe("deny");
  });

  it("permits read when allow-read policy active", () => {
    const result = evaluate([allowReadPolicy], { action: "read", agentId: "a1" });
    expect(result.decision).toBe("allow");
  });
});
```

## Zod Schemas / Validators

Test valid inputs pass and invalid inputs produce clear errors.

```typescript
import { describe, it, expect } from "bun:test";
import { DraftEmailSchema } from "../schemas/gmail";

describe("DraftEmailSchema", () => {
  it("accepts valid draft", () => {
    const result = DraftEmailSchema.safeParse({
      to: ["user@example.com"],
      subject: "Hello",
      body: "World",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing subject", () => {
    const result = DraftEmailSchema.safeParse({
      to: ["user@example.com"],
      body: "World",
    });
    expect(result.success).toBe(false);
  });
});
```

## Database Layer

Use transactions that rollback for isolation. Or mock the db module.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../db/client";
import { createAgent, getAgentByKeyHash } from "../db/agents";

describe("agents db", () => {
  let tx: Transaction;

  beforeEach(async () => {
    tx = await db.begin();
  });

  afterEach(async () => {
    await tx.rollback();
  });

  it("stores agent with hashed key", async () => {
    const agent = await createAgent(tx, { name: "test-agent", userId: "u1" });
    const found = await getAgentByKeyHash(tx, agent.keyHash);
    expect(found?.name).toBe("test-agent");
  });
});
```

## Classification Pipeline

Test deterministic rules separately from LLM fallback (mock the LLM).

```typescript
import { describe, it, expect, mock } from "bun:test";
import { classify } from "../classification/classifier";

describe("deterministic classification", () => {
  it("classifies noreply@ as notification", () => {
    const result = classify({ from: "noreply@github.com", subject: "PR merged" });
    expect(result.label).toBe("notification");
    expect(result.method).toBe("deterministic");
  });
});

describe("LLM fallback classification", () => {
  it("falls back to LLM when rules don't match", async () => {
    const mockLLM = mock(() => Promise.resolve({ label: "personal" }));
    const result = await classify(
      { from: "friend@gmail.com", subject: "Dinner tonight?" },
      { llm: mockLLM },
    );
    expect(result.label).toBe("personal");
    expect(result.method).toBe("llm");
    expect(mockLLM).toHaveBeenCalledTimes(1);
  });
});
```

## Background Workflows (pg-workflows)

Test workflow step logic in isolation. Mock the workflow context.

```typescript
import { describe, it, expect, mock } from "bun:test";
import { hilApprovalStep } from "../workflows/hil-approval";

describe("HIL approval workflow", () => {
  it("executes action on approval", async () => {
    const ctx = {
      waitFor: mock(() => Promise.resolve({ approved: true })),
      run: mock(() => Promise.resolve()),
    };
    await hilApprovalStep(ctx, { draftId: "d1", channel: "slack" });
    expect(ctx.run).toHaveBeenCalled();
  });

  it("cancels on rejection", async () => {
    const ctx = {
      waitFor: mock(() => Promise.resolve({ approved: false })),
      run: mock(() => Promise.resolve()),
    };
    await hilApprovalStep(ctx, { draftId: "d1", channel: "slack" });
    expect(ctx.run).not.toHaveBeenCalled();
  });
});
```
