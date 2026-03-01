---
name: unit-tests
description: Write unit tests for Save My Ass modules using Bun's native test runner. Use when asked to "test this module", "write units", "add tests", "implement with tests", or "write a test suite". Also use when implementing a new module if the user requests tests alongside it.
---

# Unit Tests

Write unit tests using `bun:test` with `__tests__/` directories colocated alongside source.

## File Convention

```
src/compiler/
├── parser.ts
├── resolver.ts
├── __tests__/
│   ├── parser.test.ts
│   └── resolver.test.ts
```

Test files: `<module>.test.ts` inside `__tests__/` next to the source they test.

## Test Structure

Use `describe` / `it` with arrange-act-assert. Keep tests flat and readable.

```typescript
import { describe, it, expect } from "bun:test";

describe("moduleName", () => {
  it("does the expected thing", () => {
    // arrange
    const input = makeInput();
    // act
    const result = fn(input);
    // assert
    expect(result).toBe(expected);
  });
});
```

### Setup / Teardown

Use `beforeEach` / `afterEach` only when multiple tests share expensive setup. Prefer inline setup otherwise.

### Mocking

Use `mock()` from `bun:test` for function mocks and `spyOn()` for method spies.

```typescript
import { mock, spyOn } from "bun:test";

const fn = mock(() => "mocked");
fn();
expect(fn).toHaveBeenCalledTimes(1);
```

For module-level mocks:

```typescript
import { mock } from "bun:test";

mock.module("../db/client", () => ({
  db: { query: mock(() => []) },
}));
```

## What to Test per Module Type

| Module type | What to test | Mocking strategy |
|---|---|---|
| **Routes** (Hono) | Status codes, response shapes, auth rejection, input validation | Mock db + external APIs. Use `app.request()` |
| **Compiler** (parser/resolver/typechecker/emitter) | Valid input → correct output, invalid input → clear error | Pure functions — no mocks needed |
| **Policy runtime** (Cedar) | Decision for known policy sets + request contexts, default-deny | Load Cedar policies directly |
| **Schemas** (Zod) | Valid input passes, invalid input fails with correct path | No mocks |
| **DB layer** | CRUD correctness, constraint violations | Use rollback transactions or mock `db` |
| **Classification** | Deterministic rules produce correct labels, LLM fallback triggers | Mock LLM client |
| **Workflows** (pg-workflows) | Step logic in isolation — approval, rejection, timeout | Mock workflow context (`waitFor`, `run`) |
| **Timebox / Grants** | Expiry logic, schedule matching, boundary conditions | Mock `Date.now()` or use Luxon test helpers |

For concrete examples of each, see [references/testing-patterns.md](references/testing-patterns.md).

## Coverage

Run with coverage:

```bash
bun test --coverage
```

Target: **80%+ line coverage** on business-critical modules (compiler, runtime, classification, db layer). Utility and glue code can have lower coverage.

## Principles

- **Test behavior, not implementation.** Assert on outputs and side effects, not internal state.
- **One concern per test.** A test name should fully describe what's being verified.
- **No network calls.** Mock all external services (Gmail API, Clerk, Anthropic).
- **Fail-closed matters.** Always test that invalid/missing inputs produce denials or errors — this is a security-critical system.
- **Edge cases for time.** Test boundary conditions on timeboxes, schedules, and expiry (just before, at, just after).

## Running Tests

```bash
bun test                        # all tests
bun test src/compiler           # one module
bun test --coverage             # with coverage report
bun test --watch                # watch mode
```
