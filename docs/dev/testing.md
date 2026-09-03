# Testing

Barney's test suite uses **Vitest** with **happy-dom**. Coverage is reported with the `v8` provider. Tests run in roughly a minute on a modern laptop.

## Running tests

```bash
npm test                       # full suite, single run
npm run test:watch             # watch mode
npm run test:coverage          # with v8 coverage report
npx vitest run path/to/file.test.ts        # one file
npx vitest run -t "validateFile"            # tests matching a name pattern
```

Coverage HTML reports land in `coverage/`. The provider is configured in `vitest.config.ts` to include `src/**/*.ts(x)` and exclude `src/main.tsx`, test files, and `.d.ts` files.

## Where tests live

| Location | Purpose |
|----------|---------|
| `src/**/__tests__/` (when used) | Co-located tests for a feature directory |
| `src/**/*.test.ts(x)` | Unit and component tests |
| `src/__tests__/` | Cross-cutting integration tests (currently `deployFlow.test.ts` and `customDomainFlow.test.ts`) |

A typical module has its tests immediately next to it: `src/utils/hash.ts` ↔ `src/utils/hash.test.ts`.

## Test layers

### Pure logic

Functions that neither touch the DOM nor make network calls are the easiest to test. Examples: `src/utils/hash.test.ts`, `src/utils/format.test.ts`, `src/registry/appRegistry.test.ts`.

```ts
import { describe, it, expect } from 'vitest';
import { sha256Hex } from './hash';

describe('sha256Hex', () => {
  it('hashes empty string deterministically', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });
});
```

### Store actions

Zustand actions are plain functions that receive `get`/`set`. Tests live in `src/stores/aiActions/*.test.ts`. The pattern is:

```ts
const store = createAIStore();
// arrange: call mocked actions or seed state with store.setState(...)
await someAction(store.getState, store.setState);
expect(store.getState().messages).toEqual([...]);
```

The store's persistence *subscriptions* are not installed by `createAIStore` — `AIProvider` wires those up. The store is not storage-free, though: `setWalletContext` loads (and on a closure, saves) the wallet-scoped transcript, `clearHistory` removes it, and the stale-transaction finalizers in `confirmAction` read and write it, all directly against `barney-ai-history:v1:*` with `settings.saveHistory` defaulting to `true`. Tests that call those actions must `localStorage.clear()` in `beforeEach`, or mock `./aiActions/persistence`, otherwise transcripts leak between tests.

### Components

Component tests use happy-dom and `vi.mock` for non-DOM dependencies. Examples: `src/components/ai/ConfirmationCard.test.tsx`, `src/components/layout/AppShell.test.tsx`.

> Some hooks that previously returned UI behaviour (`useConfirmationFlow`, `useMessageManager`, `useToolCache`) have been refactored into the Zustand store. Their test files retain the original names but now exercise the underlying logic without React rendering — see `src/hooks/useToolCache.test.ts` for the canonical pattern.

### Cross-cutting

`src/__tests__/deployFlow.test.ts` exercises the full deploy path with the chain and provider clients mocked. New cross-cutting flows belong here.

## Mocking conventions

Mock conventions matter because incorrect mocks silently skip code paths.

### Always preserve enums with `importOriginal`

manifestjs and `manifest-mcp-*` modules export enums (`LeaseState`, `Unit`, fred's `validateServiceName`, …) that the production code uses for narrowing. Mocking the module wholesale erases the enum, so the surrounding code crashes at runtime when it tries to read `LeaseState.LEASE_STATE_ACTIVE`.

The fix: use `importOriginal` to inherit the original module and override only the functions you need to fake.

```ts
vi.mock('../api/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/billing')>();
  return {
    ...actual,                                    // keeps LeaseState, types, …
    getLeasesByTenant: vi.fn().mockResolvedValue([]),
    getLease: vi.fn().mockResolvedValue(null),
  };
});
```

The same applies to `../api/sku` (preserves `Unit`), `@manifest-network/manifest-mcp-core` (preserves `DNS_LABEL_RE`, which fred's `validateServiceName` imports — without it, fred crashes at import time), and `@manifest-network/manifest-mcp-fred` (preserves error classes and types).

### Field names must match the real types

When mocking a chain object (a `Provider`, a `SKU`, a `CreditAccount`), get the field names right:

```ts
const sku: SKU = {
  uuid: 'sku-1',
  name: 'docker-micro',
  basePrice: { amount: '100', denom: 'upwr' },     // not `price`
  unit: Unit.UNIT_PER_HOUR,                         // real enum value
  // ...
};
```

A mock with the wrong field names will compile (TypeScript can't help when you pass `as any` somewhere) but the production code reads the real field name and silently returns `undefined`, skipping every code path that depends on it. This has bitten the project more than once.

### Mock typing helpers

```ts
import type { Mock } from 'vitest';

const mockGetSKUs = getSKUs as Mock;
mockGetSKUs.mockResolvedValueOnce([/* … */]);
```

Or, when you want to derive the return type:

```ts
type GetSKUsReturn = Awaited<ReturnType<typeof getSKUs>>;
```

`Awaited<ReturnType<typeof fn>>` is the cleanest way to get a function's resolved return type for mock typing.

### `any` is allowed in tests

ESLint disables `@typescript-eslint/no-explicit-any` in `*.test.ts(x)` and `__tests__/`. Use it for mock arguments where the production type is overly restrictive (e.g. manifestjs's `fromPartial`); don't use it in production code.

## Browser-API quirks (happy-dom vs jsdom)

happy-dom is faster than jsdom but implements a different subset of browser APIs. When in doubt:

- `crypto.subtle` — present and works.
- `localStorage` / `sessionStorage` — present.
- `WebSocket` — present, but does not initiate connections; mock it explicitly.
- `IntersectionObserver`, `ResizeObserver` — present in recent versions.
- `requestAnimationFrame` — present; for tests that depend on RAF coalescing, advance time with `vi.useFakeTimers()` and `vi.runAllTimersAsync()`.

If a test needs a real browser, add it as an end-to-end check rather than reaching for jsdom.

## Async patterns

```ts
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('runs the confirmation timeout', async () => {
  // Trigger something that schedules a timeout
  // ...
  await vi.advanceTimersByTimeAsync(AI_CONFIRMATION_TIMEOUT_MS + 1);
  expect(state.pendingConfirmation).toBeNull();
});
```

Restoring mocks in `afterEach` prevents bleed-over between tests.

## Coverage expectations

There's no enforced coverage threshold. The expectation is:

- **Critical paths** (sendMessage loop, tool dispatch, store actions, manifest builders, transaction broadcasting) — high coverage with branch testing.
- **UI components** — smoke tests that they render without crashing, plus tests for non-trivial interactions (confirmation flow, manifest editor validation, file upload).
- **Utilities** — full coverage; they're cheap and brittle if untested.

Run `npm run test:coverage` and review `coverage/index.html` before opening a PR that touches multiple modules.

## Common pitfalls

### "ReferenceError: Unit is not defined"

You mocked `../api/sku` without `importOriginal`. The mock erased the `Unit` enum re-export. Switch to the `importOriginal` pattern.

### "TypeError: Cannot read properties of undefined (reading 'amount')"

Your mock object uses the wrong field name. Compare the mock against the real type from manifestjs (`@manifest-network/manifestjs/dist/codegen/...`).

### "ReferenceError: window is not defined" inside the module

A module that runs at import time references `window`. happy-dom defines `window`, but `vitest` runs imports before `beforeEach` hooks. If you're seeing this in a test that runs in a `node` environment, ensure `vitest.config.ts` is using `environment: 'happy-dom'`.

### Tests pass locally, fail in CI

Most often a leaking timer or a race between `vi.advanceTimersByTimeAsync` and a real promise resolution. Wrap the assertion in a `vi.waitFor(...)` or advance more time.

### A test mutates the Zustand store and the next test sees stale state

You're sharing a store across tests. Create a fresh store in `beforeEach`:

```ts
let store: ReturnType<typeof createAIStore>;
beforeEach(() => { store = createAIStore(); });
```

## Adding tests for new code

When you add a tool, hook, or store action, add tests at the same time. The minimum bar:

| New code | Test file | What to cover |
|----------|-----------|---------------|
| Tool definition | `src/ai/tools.test.ts` | `requiresConfirmation`, `getToolCallDescription`, `isValidToolName` |
| Tool executor | `src/ai/toolExecutor/composite*.test.ts` | Success, error, multi-app paths, mocked chain/provider |
| Store action | `src/stores/aiActions/<name>.test.ts` | State transitions, error paths, persistence side-effects |
| Hook | `src/hooks/<name>.test.ts(x)` | Returned value, effect cleanup, edge cases |
| Component | Co-located `.test.tsx` | Renders without crash, key interactions |

PRs without tests for new code will not be approved.
