# ENG-241: Drive SKU Tiers and Pricing from Chain, Specs from Env

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four hardcoded SKU-tier sites (`tools.ts`, `compositeTransactions.ts`, `systemPrompt.ts`, `helpText.ts`) with a runtime-resolved tier list whose names + prices come from chain at app boot, and whose CPU/RAM/disk specs come from a new `PUBLIC_SKU_SPECS` env var. Deploy surfaces degrade inline (loading / error / ready) without blocking the rest of the app.

**Architecture:**
1. **Two sources of truth.** Chain → which tiers exist + their price. Env var (`PUBLIC_SKU_SPECS`) → CPU/RAM/disk specs per SKU name.
2. **One resolved list, computed once at boot.** A new Zustand slice (`skuTiers: { phase: 'loading' | 'ready' | 'error', tiers, error, denomSymbol, retry }`) holds the chain ∩ env intersection. Every deploy surface (AI tool builder, system prompt, help card, `ConfirmationCard`, deploy buttons) reads from this slice.
3. **Pricing normalization at the source.** `src/api/sku.ts` exports a new `resolveSkuTiers(specs)` that calls `getSKUs(true)`, joins on env specs, converts each SKU's price to display-units-per-hour using the chain `Unit` enum, and returns a `ResolvedSkuTier[]`. Consumers no longer touch raw `SKU`/`Unit` for pricing.
4. **Inline degradation, not blocking.** `loading` → buttons disabled + tooltip, `ConfirmationCard` price line skeleton, `deploy_app` tool returns a clean error if invoked early, `/help` shows a status row. `error` → same but offers retry. `ready` → full UI.

**Tech Stack:** TypeScript, Zustand (vanilla store, see `src/stores/aiStore.ts`), Vitest + happy-dom, React 18, manifestjs (`@manifest-network/manifestjs`), Rsbuild.

---

## File Structure

### New files
- `src/api/skuTiers.ts` — Pricing normalization + tier resolution. `ResolvedSkuTier` type, `hourlyPriceFromSku()`, `resolveSkuTiers(specs)`. Pure module — no React, no store.
- `src/config/skuSpecs.ts` — `PUBLIC_SKU_SPECS` parser. `SkuSpec` type, `parseSkuSpecs(raw)` with schema validation.
- `src/stores/aiActions/skuTiers.ts` — Action functions: `loadSkuTiersFn(get, set)`, `retrySkuTiersFn(get, set)`. Plain functions, same pattern as `sendMessage.ts`.

### Modified files
- `src/config/runtimeConfig.ts` — Add `PUBLIC_SKU_SPECS` key (default `''`). Wire it into the `RuntimeConfig` type, `BUILD_ENV`, `DEFAULTS`, and the frozen export.
- `src/stores/aiStore.ts` — Add `skuTiers` slice (state + actions). Wire actions to `skuTiers.ts` action functions.
- `src/hooks/useAI.ts` — Expose `skuTiers`, `loadSkuTiers`, `retrySkuTiers` via the shallow selector.
- `src/contexts/AIContext.tsx` — Kick off `loadSkuTiers()` once on mount.
- `src/ai/tools.ts` — Replace static `AI_TOOLS` const with a builder: `buildAITools(skuTiers): ToolDefinition[]`. Keep `CONFIRMATION_TOOLS`, `getDisplaySafeArgs`, `getToolCallDescription`, `isValidToolName` as before (they don't depend on tiers). Drop the static `VALID_TOOL_NAMES` set and replace it with a const list of tool names so the validators don't depend on tiers either.
- `src/ai/systemPrompt.ts` — `getSystemPrompt(address?, skuTiers?)` — render the `## Resource Tiers` block from `skuTiers` when provided, otherwise from a "tiers loading" placeholder.
- `src/ai/helpText.ts` — Convert from a `const string` to `buildHelpText(skuTiers): string`. Keep the rest of the markdown identical.
- `src/components/ai/HelpCard.tsx` — Read tiers from the store (via `useAI()`); render skeleton/error/ready states for the tiers section.
- `src/ai/toolExecutor/compositeTransactions.ts` — Drop the two `VALID_SIZE_TIERS` hardcoded arrays (lines 899, 1535). Accept a resolved tier list via `ToolExecutorOptions`. Map `args.size` → `skuUuid` via the resolved list. Return a clean "Tier catalog unavailable — try again in a moment" if the list is `loading`/`error`.
- `src/ai/toolExecutor/types.ts` — Add `skuTiersState: SkuTiersState` (or just `tiers: ResolvedSkuTier[] | null`) onto `ToolExecutorOptions` so executors can consume it without re-fetching.
- `src/stores/aiActions/sendMessage.ts` — Build `AI_TOOLS` per-iteration from `get().skuTiers`. Pass tiers to `toChatApiMessages` / system prompt builder. Pass tiers into the tool-executor options.
- `src/stores/aiActions/confirmAction.ts` — Pass tiers into tool-executor options on confirm path.
- `src/stores/aiActions/toolExecution.ts` — Same — pipe tiers into options.
- `src/stores/aiActions/batchDeploy.ts` — Same — pipe tiers into options when calling `executeBatchDeploy`.
- `src/components/ai/ConfirmationCard.tsx` — Replace the price line (currently buried inside `confirmationMessage` text) with an explicit row that consumes the resolved tier and shows live $/hour, skeleton on loading, "—" + warning on error.
- `src/components/ai/ChatPanel.tsx` — Disable example-app deploy buttons when `skuTiers.phase !== 'ready'`; on `error`, replace the button row with a small retry banner.
- `src/components/layout/AppsSidebar.tsx` — Disable the "Re-deploy" icon button (line 366) when tiers aren't ready; tooltip text reflects state.
- `.env.example` — Add `PUBLIC_SKU_SPECS` example with current defaults.
- `docker/env.sh` and `docker/nginx.conf.template` — Add the new var to the generated `config.js` so prod containers can override it.

### New test files
- `src/api/skuTiers.test.ts` — `hourlyPriceFromSku()` cases (PER_HOUR / PER_DAY / UNSPECIFIED), `resolveSkuTiers()` intersection + warning behavior.
- `src/config/skuSpecs.test.ts` — `parseSkuSpecs()` — valid JSON, missing keys, wrong types, empty string.
- `src/stores/aiActions/skuTiers.test.ts` — `loadSkuTiersFn` happy path, fetch failure, retry transitions, no-double-load while loading.

### Modified test files
- `src/config/runtimeConfig.test.ts` — Cover `PUBLIC_SKU_SPECS`.
- `src/ai/tools.test.ts` — Update for `buildAITools(skuTiers)` builder + tier-driven `size.enum`.
- `src/ai/systemPrompt.test.ts` — Cover dynamic-tier rendering + placeholder branch.
- `src/ai/helpText.test.ts` — Cover `buildHelpText(skuTiers)`.
- `src/components/ai/HelpCard.test.tsx` (create if missing — currently no test for HelpCard) — loading/error/ready states.
- `src/components/ai/ConfirmationCard` tests — extend if present; otherwise create `ConfirmationCard.skuPrice.test.tsx` covering price-line skeleton/error/ready.
- `src/ai/toolExecutor/compositeTransactions.test.ts` — Adjust mocks so `args.size` resolves through tiers rather than hardcoded SKU name. Add a "tier catalog unavailable" test.

---

## Data Flow

### Boot sequence (happy path)

```
AIProvider mounts
  └─ useEffect → store.loadSkuTiers()
        ↓ set { skuTiers: { phase: 'loading' } }
        ↓ const specs = parseSkuSpecs(runtimeConfig.PUBLIC_SKU_SPECS)
        ↓ const skus = await getSKUs(true)
        ↓ const tiers = joinChainWithSpecs(skus, specs)   // chain ∩ env, warn on missing
        ↓ set { skuTiers: { phase: 'ready', tiers, denomSymbol } }

All deploy surfaces re-render with full data.
```

### Boot sequence (chain fetch fails)

```
loadSkuTiers()
  └─ getSKUs() throws
       ↓ logError + set { skuTiers: { phase: 'error', error: msg } }

ChatPanel buttons → disabled with "Tiers unavailable — Retry" banner
HelpCard tiers section → status row + retry button
ConfirmationCard → no price line, warning row
deploy_app tool invocation → returns "Tier catalog unavailable — try again in a moment"
```

### Tool invocation flow

```
User: "deploy redis"
  └─ sendMessage → tools = buildAITools(get().skuTiers)
        ↓ enum on deploy_app.size = ['docker-micro', 'docker-small', ...]  (from tiers)
        ↓ stream → model emits deploy_app(image='redis', port='6379', size='docker-micro')
  └─ processToolCalls → executor options now carry `tiers`
        ↓ executeDeployApp: if !tiers → clean error
        ↓ if size not in tiers → "Tier X is not available" (already returns this, but reads from tier list)
        ↓ pick SKU → pick provider → build confirmation
```

---

## Phase 1: `PUBLIC_SKU_SPECS` env var + parser

Goal: A runtime-resolvable env var holding the CPU/RAM/disk specs, with a typed parser.

### Task 1.1: Add `PUBLIC_SKU_SPECS` to `runtimeConfig.ts`

**Files:**
- Modify: `src/config/runtimeConfig.ts`
- Test: `src/config/runtimeConfig.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/config/runtimeConfig.test.ts`:

```ts
describe('PUBLIC_SKU_SPECS', () => {
  let originalConfig: typeof window.__RUNTIME_CONFIG__;

  beforeEach(() => { originalConfig = window.__RUNTIME_CONFIG__; });
  afterEach(() => { window.__RUNTIME_CONFIG__ = originalConfig; });

  it('returns runtime override when set', () => {
    const json = '{"docker-micro":{"cores":0.5,"ramMB":512,"diskGB":1}}';
    window.__RUNTIME_CONFIG__ = { PUBLIC_SKU_SPECS: json };
    expect(getConfigValue('PUBLIC_SKU_SPECS')).toBe(json);
  });

  it('defaults to empty string when unset', () => {
    window.__RUNTIME_CONFIG__ = {};
    expect(getConfigValue('PUBLIC_SKU_SPECS')).toBe('');
  });
});

it('exports 18 keys (added PUBLIC_SKU_SPECS)', () => {
  expect(Object.keys(runtimeConfig)).toHaveLength(18);
});
```

Update the existing `'exports all 17 keys as strings'` test name + count to 18.

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run src/config/runtimeConfig.test.ts
```
Expected: FAIL — `PUBLIC_SKU_SPECS` not in `RuntimeConfigKey`.

- [ ] **Step 3: Add the key to `runtimeConfig.ts`**

In `src/config/runtimeConfig.ts`:

```ts
type RuntimeConfigKey =
  | 'PUBLIC_REST_URL'
  | 'PUBLIC_RPC_URL'
  | 'PUBLIC_WEB3AUTH_CLIENT_ID'
  | 'PUBLIC_WEB3AUTH_NETWORK'
  | 'PUBLIC_MORPHEUS_MODEL'
  | 'PUBLIC_PWR_DENOM'
  | 'PUBLIC_GAS_PRICE'
  | 'PUBLIC_CHAIN_ID'
  | 'PUBLIC_FAUCET_URL'
  | 'PUBLIC_AI_STREAM_TIMEOUT_MS'
  | 'PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS'
  | 'PUBLIC_AI_TOOL_API_TIMEOUT_MS'
  | 'PUBLIC_AI_MAX_RETRIES'
  | 'PUBLIC_AI_CONFIRMATION_TIMEOUT_MS'
  | 'PUBLIC_AI_MAX_TOOL_ITERATIONS'
  | 'PUBLIC_AI_MAX_MESSAGES'
  | 'PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY'
  | 'PUBLIC_SKU_SPECS';
```

Add to `BUILD_ENV`:

```ts
PUBLIC_SKU_SPECS: import.meta.env.PUBLIC_SKU_SPECS ?? '',
```

Add to `DEFAULTS`:

```ts
PUBLIC_SKU_SPECS: '',
```

Add to the frozen `runtimeConfig`:

```ts
PUBLIC_SKU_SPECS: getConfigValue('PUBLIC_SKU_SPECS'),
```

- [ ] **Step 4: Run test to confirm pass**

```bash
npx vitest run src/config/runtimeConfig.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update `.env.example`**

Append to `.env.example`. Wrap the value in **single quotes** so the JSON's double quotes survive the `.env` parser:

```
# Resource specs per SKU name (JSON). Chain provides names + prices; this provides specs.
# Different networks ship different SKUs — env var keeps that out of the codebase.
# Empty string disables deploy until specs are configured.
# Order matters: tiers[0] is the default size for deploy_app when none is specified.
PUBLIC_SKU_SPECS='{"docker-micro":{"cores":0.5,"ramMB":512,"diskGB":1},"docker-small":{"cores":1,"ramMB":1024,"diskGB":5},"docker-medium":{"cores":2,"ramMB":2048,"diskGB":10},"docker-large":{"cores":4,"ramMB":4096,"diskGB":20}}'
```

- [ ] **Step 6: Update `docker/config.js.template`**

Open `docker/config.js.template`. Every existing key uses double-quoted values, e.g. `PUBLIC_REST_URL: "${PUBLIC_REST_URL}",`. **Do not use double quotes** for the new key — the JSON value contains double quotes and would break the JS literal. Use single quotes:

```js
// Before the closing `};`:
  PUBLIC_SKU_SPECS: '${PUBLIC_SKU_SPECS}',
```

(JSON cannot contain unescaped single quotes, so single-quoting the value is safe.)

- [ ] **Step 7: Update `docker/env.sh`**

In `docker/env.sh`, find the long `envsubst '$PUBLIC_REST_URL $PUBLIC_RPC_URL ...'` line that generates `config.js`. Append ` $PUBLIC_SKU_SPECS` to the variable list (inside the single quotes), e.g.:

```sh
envsubst '$PUBLIC_REST_URL $PUBLIC_RPC_URL ... $PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY $PUBLIC_SKU_SPECS' \
  < /docker/config.js.template > /usr/share/nginx/html/config.js
```

(Read the existing line first to get the full var list — just append the new var, don't rewrite the whole list.)

- [ ] **Step 8: Commit**

```bash
git add src/config/runtimeConfig.ts src/config/runtimeConfig.test.ts .env.example docker/env.sh docker/config.js.template
git commit -m "feat(config): add PUBLIC_SKU_SPECS runtime config"
```

### Task 1.2: Create `src/config/skuSpecs.ts` parser

**Files:**
- Create: `src/config/skuSpecs.ts`
- Create: `src/config/skuSpecs.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/config/skuSpecs.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { parseSkuSpecs } from './skuSpecs';

describe('parseSkuSpecs', () => {
  it('parses valid JSON spec map', () => {
    const raw = '{"docker-micro":{"cores":0.5,"ramMB":512,"diskGB":1}}';
    expect(parseSkuSpecs(raw)).toEqual({
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
    });
  });

  it('returns empty map for empty string', () => {
    expect(parseSkuSpecs('')).toEqual({});
  });

  it('returns empty map and logs error for invalid JSON', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseSkuSpecs('{not json')).toEqual({});
    spy.mockRestore();
  });

  it('drops entries with missing required fields', () => {
    const raw = '{"docker-x":{"cores":1,"ramMB":1024}}';
    expect(parseSkuSpecs(raw)).toEqual({});
  });

  it('drops entries with non-number fields', () => {
    const raw = '{"docker-x":{"cores":"1","ramMB":1024,"diskGB":5}}';
    expect(parseSkuSpecs(raw)).toEqual({});
  });

  it('drops entries with negative numbers', () => {
    const raw = '{"docker-x":{"cores":-1,"ramMB":1024,"diskGB":5}}';
    expect(parseSkuSpecs(raw)).toEqual({});
  });

  it('rejects non-object top-level JSON', () => {
    expect(parseSkuSpecs('[1,2,3]')).toEqual({});
    expect(parseSkuSpecs('"string"')).toEqual({});
    expect(parseSkuSpecs('null')).toEqual({});
  });

  it('handles multi-SKU map', () => {
    const raw = JSON.stringify({
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
      'docker-small': { cores: 1, ramMB: 1024, diskGB: 5 },
    });
    expect(Object.keys(parseSkuSpecs(raw))).toEqual(['docker-micro', 'docker-small']);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run src/config/skuSpecs.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `parseSkuSpecs`**

Create `src/config/skuSpecs.ts`:

```ts
/**
 * Schema-validated parser for the `PUBLIC_SKU_SPECS` env var.
 *
 * The chain supplies SKU names and prices; this env var supplies the
 * accompanying CPU/RAM/disk specs. Different networks ship different specs,
 * so the resolved tier list is the chain ∩ env intersection.
 *
 * On any parse error or schema violation, returns an empty map and logs to
 * console. The caller (loadSkuTiers action) treats an empty spec map as
 * "no tiers usable" and surfaces that as an error to deploy surfaces.
 */

import { logError } from '../utils/errors';

export interface SkuSpec {
  cores: number;
  ramMB: number;
  diskGB: number;
}

export type SkuSpecMap = Record<string, SkuSpec>;

function isValidSpec(value: unknown): value is SkuSpec {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.cores === 'number' && Number.isFinite(v.cores) && v.cores > 0 &&
    typeof v.ramMB === 'number' && Number.isFinite(v.ramMB) && v.ramMB > 0 &&
    typeof v.diskGB === 'number' && Number.isFinite(v.diskGB) && v.diskGB > 0
  );
}

export function parseSkuSpecs(raw: string): SkuSpecMap {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    logError('skuSpecs.parseSkuSpecs.json', error);
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logError('skuSpecs.parseSkuSpecs.shape', new Error('PUBLIC_SKU_SPECS must be a JSON object'));
    return {};
  }

  const out: SkuSpecMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isValidSpec(value)) {
      out[key] = { cores: value.cores, ramMB: value.ramMB, diskGB: value.diskGB };
    } else {
      logError('skuSpecs.parseSkuSpecs.entry', new Error(`Invalid SKU spec for "${key}"`));
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
npx vitest run src/config/skuSpecs.test.ts
```
Expected: PASS (all 8 cases).

- [ ] **Step 5: Commit**

```bash
git add src/config/skuSpecs.ts src/config/skuSpecs.test.ts
git commit -m "feat(config): add parseSkuSpecs schema-validated parser"
```

---

## Phase 2: Pricing normalization + tier resolution in `src/api/skuTiers.ts`

Goal: One pure function that takes the env spec map + the chain SKU list and returns a `ResolvedSkuTier[]` with $/hour pricing already normalized.

### Task 2.1: Create `src/api/skuTiers.ts`

**Files:**
- Create: `src/api/skuTiers.ts`
- Create: `src/api/skuTiers.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/api/skuTiers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hourlyPriceFromSku, resolveSkuTiers } from './skuTiers';
import { Unit } from './sku';
import type { SKU } from './sku';

vi.mock('./sku', async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  return {
    ...actual,
    getSKUs: vi.fn(),
  };
});

import { getSKUs } from './sku';

function makeSku(overrides: Partial<SKU>): SKU {
  return {
    uuid: 'sku-1',
    name: 'docker-micro',
    providerUuid: 'prov-1',
    unit: Unit.UNIT_PER_HOUR,
    basePrice: { amount: '36000', denom: 'upwr' },  // 0.036 PWR per hour
    active: true,
    description: '',
    metadata: '',
    ...overrides,
  } as SKU;
}

describe('hourlyPriceFromSku', () => {
  it('returns base price as-is for UNIT_PER_HOUR', () => {
    const sku = makeSku({ unit: Unit.UNIT_PER_HOUR, basePrice: { amount: '36000', denom: 'upwr' } });
    expect(hourlyPriceFromSku(sku)).toBeCloseTo(0.036);
  });

  it('divides by 24 for UNIT_PER_DAY', () => {
    const sku = makeSku({ unit: Unit.UNIT_PER_DAY, basePrice: { amount: '24000000', denom: 'upwr' } });
    // 24 PWR/day → 1 PWR/hour
    expect(hourlyPriceFromSku(sku)).toBeCloseTo(1.0);
  });

  it('defaults to per-hour for UNIT_UNSPECIFIED (logs warning)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sku = makeSku({ unit: Unit.UNIT_UNSPECIFIED, basePrice: { amount: '50000', denom: 'upwr' } });
    expect(hourlyPriceFromSku(sku)).toBeCloseTo(0.05);
    spy.mockRestore();
  });

  it('returns 0 when basePrice is missing', () => {
    const sku = { ...makeSku({}), basePrice: undefined as unknown as SKU['basePrice'] };
    expect(hourlyPriceFromSku(sku)).toBe(0);
  });
});

describe('resolveSkuTiers', () => {
  beforeEach(() => vi.mocked(getSKUs).mockReset());

  it('returns chain ∩ env intersection', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      makeSku({ uuid: 'a', name: 'docker-micro' }),
      makeSku({ uuid: 'b', name: 'docker-small', basePrice: { amount: '100000', denom: 'upwr' } }),
    ]);
    const specs = {
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
      'docker-small': { cores: 1, ramMB: 1024, diskGB: 5 },
    };
    const result = await resolveSkuTiers(specs);
    expect(result.tiers.map(t => t.skuName)).toEqual(['docker-micro', 'docker-small']);
    expect(result.tiers[0].pricePerHour).toBeCloseTo(0.036);
    expect(result.tiers[0].cores).toBe(0.5);
    expect(result.denomSymbol).toBe('PWR');
  });

  it('omits chain SKUs not present in env specs, warns to console', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getSKUs).mockResolvedValue([
      makeSku({ uuid: 'a', name: 'docker-micro' }),
      makeSku({ uuid: 'b', name: 'gpu-large' }),
    ]);
    const specs = {
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
    };
    const result = await resolveSkuTiers(specs);
    expect(result.tiers.map(t => t.skuName)).toEqual(['docker-micro']);
    expect(spy).toHaveBeenCalled();  // missing-spec warning logged
    spy.mockRestore();
  });

  it('skips inactive SKUs (filter active=true at call site)', async () => {
    vi.mocked(getSKUs).mockImplementation(async (activeOnly) => {
      expect(activeOnly).toBe(true);
      return [makeSku({ active: true })];
    });
    const result = await resolveSkuTiers({ 'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 } });
    expect(result.tiers).toHaveLength(1);
  });

  it('propagates fetch errors', async () => {
    vi.mocked(getSKUs).mockRejectedValue(new Error('network down'));
    await expect(resolveSkuTiers({})).rejects.toThrow('network down');
  });

  it('preserves stable order by spec key insertion', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      makeSku({ uuid: 'b', name: 'docker-small', basePrice: { amount: '100000', denom: 'upwr' } }),
      makeSku({ uuid: 'a', name: 'docker-micro' }),
    ]);
    const specs = {
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
      'docker-small': { cores: 1, ramMB: 1024, diskGB: 5 },
    };
    const result = await resolveSkuTiers(specs);
    expect(result.tiers.map(t => t.skuName)).toEqual(['docker-micro', 'docker-small']);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run src/api/skuTiers.test.ts
```
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `skuTiers.ts`**

Create `src/api/skuTiers.ts`:

```ts
/**
 * Resolved SKU tier list — joins the chain SKU catalog with env-provided specs
 * and normalizes pricing to per-hour display units.
 *
 * Chain is authoritative for which SKUs exist + their price. The env var
 * `PUBLIC_SKU_SPECS` is authoritative for the CPU/RAM/disk numbers. The
 * resolved list is the intersection of the two: any chain SKU without a spec
 * entry is dropped (with a console warning) so the UI never lies about
 * resources.
 */

import { getSKUs, Unit } from './sku';
import type { SKU } from './sku';
import { getDenomMetadata } from './config';
import { fromBaseUnits } from '../utils/format';
import { logError } from '../utils/errors';
import type { SkuSpecMap } from '../config/skuSpecs';

export interface ResolvedSkuTier {
  /** Full SKU name from chain (e.g., 'docker-micro'). Also the env-var key. */
  skuName: string;
  /** SKU UUID — used for transactions and provider resolution. */
  skuUuid: string;
  /** Provider UUID this SKU belongs to. */
  providerUuid: string;
  /** Specs from env. */
  cores: number;
  ramMB: number;
  diskGB: number;
  /** Normalized price per hour in display units (already divided by 10^exponent). */
  pricePerHour: number;
  /** Display denom symbol (e.g., 'PWR'). */
  denomSymbol: string;
  /** Raw chain Unit, preserved for the browse_catalog response. */
  unit: Unit;
}

export interface ResolveResult {
  tiers: ResolvedSkuTier[];
  /** First denom symbol seen across tiers — used as the global label. */
  denomSymbol: string;
}

/**
 * Convert a SKU's basePrice + Unit to a per-hour price in display units.
 * - UNIT_PER_HOUR → basePrice as-is
 * - UNIT_PER_DAY  → basePrice / 24
 * - UNSPECIFIED / UNRECOGNIZED → treat as per-hour (default) and log
 * Returns 0 if basePrice is missing.
 */
export function hourlyPriceFromSku(sku: SKU): number {
  if (!sku.basePrice) return 0;
  const base = fromBaseUnits(sku.basePrice.amount, sku.basePrice.denom);
  switch (sku.unit) {
    case Unit.UNIT_PER_HOUR:
      return base;
    case Unit.UNIT_PER_DAY:
      return base / 24;
    default:
      logError(
        'skuTiers.hourlyPriceFromSku.unknownUnit',
        new Error(`SKU ${sku.uuid} has unrecognized unit ${sku.unit} — treating as per-hour`),
      );
      return base;
  }
}

/**
 * Fetch active SKUs from chain and join with env specs.
 * Throws on chain fetch failure (caller decides how to surface).
 */
export async function resolveSkuTiers(specs: SkuSpecMap): Promise<ResolveResult> {
  const skus = await getSKUs(true);  // activeOnly

  // Index chain SKUs by name for spec-driven ordering.
  const skusByName = new Map<string, SKU>();
  for (const sku of skus) skusByName.set(sku.name, sku);

  const tiers: ResolvedSkuTier[] = [];
  const seenSpecs = new Set<string>();
  let denomSymbol = '';

  // Walk spec keys in insertion order so the resolved list has stable env-driven order.
  for (const [specName, spec] of Object.entries(specs)) {
    const sku = skusByName.get(specName);
    if (!sku) {
      logError(
        'skuTiers.resolveSkuTiers.missingChainSku',
        new Error(`PUBLIC_SKU_SPECS includes "${specName}" but chain has no matching active SKU`),
      );
      continue;
    }
    seenSpecs.add(specName);
    const symbol = getDenomMetadata(sku.basePrice?.denom ?? '').symbol;
    if (!denomSymbol) denomSymbol = symbol;
    tiers.push({
      skuName: sku.name,
      skuUuid: sku.uuid,
      providerUuid: sku.providerUuid,
      cores: spec.cores,
      ramMB: spec.ramMB,
      diskGB: spec.diskGB,
      pricePerHour: hourlyPriceFromSku(sku),
      denomSymbol: symbol,
      unit: sku.unit,
    });
  }

  // Warn for chain SKUs that exist but have no spec entry — they get dropped.
  for (const sku of skus) {
    if (!seenSpecs.has(sku.name)) {
      logError(
        'skuTiers.resolveSkuTiers.missingSpec',
        new Error(`Chain SKU "${sku.name}" has no entry in PUBLIC_SKU_SPECS — omitted from tier list`),
      );
    }
  }

  return { tiers, denomSymbol };
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
npx vitest run src/api/skuTiers.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/skuTiers.ts src/api/skuTiers.test.ts
git commit -m "feat(api): add resolveSkuTiers + $/hour normalization"
```

---

## Phase 3: Zustand SKU slice + boot fetch

Goal: A store slice with `loading | ready | error` states, an action to load tiers on boot, and a retry action.

### Task 3.1: Add the `skuTiers` slice to `aiStore.ts`

**Files:**
- Modify: `src/stores/aiStore.ts`
- Create: `src/stores/aiActions/skuTiers.ts`
- Create: `src/stores/aiActions/skuTiers.test.ts`

- [ ] **Step 1: Write failing test for the action**

Create `src/stores/aiActions/skuTiers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAIStore } from '../aiStore';

vi.mock('../../api/skuTiers', () => ({
  resolveSkuTiers: vi.fn(),
}));

vi.mock('../../config/runtimeConfig', () => ({
  runtimeConfig: {
    PUBLIC_SKU_SPECS: '{"docker-micro":{"cores":0.5,"ramMB":512,"diskGB":1}}',
  },
}));

import { resolveSkuTiers } from '../../api/skuTiers';

describe('loadSkuTiers', () => {
  beforeEach(() => vi.mocked(resolveSkuTiers).mockReset());

  it('transitions loading → ready on success', async () => {
    vi.mocked(resolveSkuTiers).mockResolvedValue({
      tiers: [{ skuName: 'docker-micro', skuUuid: 'u1', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 }],
      denomSymbol: 'PWR',
    });
    const store = createAIStore();
    expect(store.getState().skuTiers.phase).toBe('idle');
    const promise = store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('loading');
    await promise;
    expect(store.getState().skuTiers.phase).toBe('ready');
    expect(store.getState().skuTiers.tiers).toHaveLength(1);
  });

  it('transitions loading → error on fetch failure', async () => {
    vi.mocked(resolveSkuTiers).mockRejectedValue(new Error('chain unreachable'));
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    const state = store.getState().skuTiers;
    expect(state.phase).toBe('error');
    expect(state.error).toContain('chain unreachable');
  });

  it('treats empty spec map as error (no usable tiers)', async () => {
    vi.mocked(resolveSkuTiers).mockResolvedValue({ tiers: [], denomSymbol: '' });
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('error');
    expect(store.getState().skuTiers.error).toMatch(/no tiers/i);
  });

  it('does not re-fetch while loading', async () => {
    let resolveFn: ((v: { tiers: []; denomSymbol: '' }) => void) | undefined;
    vi.mocked(resolveSkuTiers).mockImplementation(
      () => new Promise(r => { resolveFn = r as typeof resolveFn; })
    );
    const store = createAIStore();
    const p1 = store.getState().loadSkuTiers();
    const p2 = store.getState().loadSkuTiers();
    expect(p1).toBe(p2);  // returns the in-flight promise
    resolveFn!({ tiers: [], denomSymbol: '' });
    await p1;
  });

  it('retry re-issues a fetch after error', async () => {
    vi.mocked(resolveSkuTiers).mockRejectedValueOnce(new Error('x'));
    const store = createAIStore();
    await store.getState().loadSkuTiers();
    expect(store.getState().skuTiers.phase).toBe('error');

    vi.mocked(resolveSkuTiers).mockResolvedValueOnce({
      tiers: [{ skuName: 'docker-micro', skuUuid: 'u1', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 }],
      denomSymbol: 'PWR',
    });
    await store.getState().retrySkuTiers();
    expect(store.getState().skuTiers.phase).toBe('ready');
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run src/stores/aiActions/skuTiers.test.ts
```
Expected: FAIL — `loadSkuTiers` not on store.

- [ ] **Step 3: Implement the action module**

Create `src/stores/aiActions/skuTiers.ts`:

```ts
/**
 * loadSkuTiers / retrySkuTiers — fetch + normalize SKU tiers once at boot.
 * Session-lifetime cache: no periodic refresh, no invalidation.
 *
 * Concurrent calls while a fetch is in-flight return the same in-flight promise
 * so React StrictMode double-invokes don't issue duplicate chain queries.
 */

import { runtimeConfig } from '../../config/runtimeConfig';
import { parseSkuSpecs } from '../../config/skuSpecs';
import { resolveSkuTiers } from '../../api/skuTiers';
import { logError } from '../../utils/errors';
import type { AIStore } from '../aiStore';
import type { ResolvedSkuTier } from '../../api/skuTiers';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((s: AIStore) => Partial<AIStore>)) => void;

export type SkuTiersPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface SkuTiersState {
  phase: SkuTiersPhase;
  tiers: ResolvedSkuTier[];
  /** First denom symbol from resolved tiers (e.g., 'PWR'). */
  denomSymbol: string;
  /** Set when phase === 'error'. */
  error: string | null;
}

export const initialSkuTiersState: SkuTiersState = {
  phase: 'idle',
  tiers: [],
  denomSymbol: '',
  error: null,
};

export function loadSkuTiersFn(get: Get, set: Set): Promise<void> {
  // The in-flight promise lives on the store as `_skuTiersInFlight` (an
  // internal field; see aiStore.ts). Zustand re-creates the state object on
  // every `set()`, so a module-level Map keyed by state ref would lose track.
  // Keying off the store value instead survives state churn.
  const existing = get()._skuTiersInFlight;
  if (existing) return existing;
  if (get().skuTiers.phase === 'ready') return Promise.resolve();

  set({ skuTiers: { ...get().skuTiers, phase: 'loading', error: null } });

  const specs = parseSkuSpecs(runtimeConfig.PUBLIC_SKU_SPECS);

  const promise = (async () => {
    try {
      const { tiers, denomSymbol } = await resolveSkuTiers(specs);
      if (tiers.length === 0) {
        set({
          skuTiers: {
            phase: 'error',
            tiers: [],
            denomSymbol: '',
            error: 'No tiers available — check PUBLIC_SKU_SPECS and chain SKU catalog.',
          },
        });
        return;
      }
      set({ skuTiers: { phase: 'ready', tiers, denomSymbol, error: null } });
    } catch (err) {
      logError('aiActions.loadSkuTiers', err);
      const msg = err instanceof Error ? err.message : String(err);
      set({
        skuTiers: {
          phase: 'error',
          tiers: [],
          denomSymbol: '',
          error: msg,
        },
      });
    } finally {
      set({ _skuTiersInFlight: null });
    }
  })();

  set({ _skuTiersInFlight: promise });
  return promise;
}

export function retrySkuTiersFn(get: Get, set: Set): Promise<void> {
  // Force a fresh attempt by resetting phase first.
  set({ skuTiers: { ...get().skuTiers, phase: 'idle', error: null } });
  return loadSkuTiersFn(get, set);
}
```

- [ ] **Step 4: Wire the slice into `aiStore.ts`**

In `src/stores/aiStore.ts`:

Add to imports:

```ts
import {
  loadSkuTiersFn,
  retrySkuTiersFn,
  initialSkuTiersState,
  type SkuTiersState,
} from './aiActions/skuTiers';
```

Re-export the type alongside other types:

```ts
export type { SkuTiersState } from './aiActions/skuTiers';
```

Add to the `AIStore` interface (after `dnsStatuses`):

```ts
skuTiers: SkuTiersState;
```

In the **Internal state** block of the interface (where `_toolCache` etc. live), add:

```ts
_skuTiersInFlight: Promise<void> | null;
```

Add action signatures (in the actions block):

```ts
loadSkuTiers: () => Promise<void>;
retrySkuTiers: () => Promise<void>;
```

Add to the initial state in `createAIStore` (next to other slice initials):

```ts
skuTiers: initialSkuTiersState,
```

And next to the other `_`-prefixed internal fields:

```ts
_skuTiersInFlight: null,
```

Add the action bindings near the other "Complex actions":

```ts
loadSkuTiers: () => loadSkuTiersFn(get, set),
retrySkuTiers: () => retrySkuTiersFn(get, set),
```

- [ ] **Step 5: Run test to confirm pass**

```bash
npx vitest run src/stores/aiActions/skuTiers.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/stores/aiActions/skuTiers.ts src/stores/aiActions/skuTiers.test.ts src/stores/aiStore.ts
git commit -m "feat(store): add skuTiers slice with loading/ready/error phases"
```

### Task 3.2: Expose the slice via `useAI`

**Files:**
- Modify: `src/hooks/useAI.ts`

- [ ] **Step 1: Add the keys to the selector**

In `src/hooks/useAI.ts`, add inside the `useShallow` map (after `dnsStatuses`):

```ts
skuTiers: s.skuTiers,
loadSkuTiers: s.loadSkuTiers,
retrySkuTiers: s.retrySkuTiers,
```

- [ ] **Step 2: Build to verify no type errors**

```bash
npm run build
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAI.ts
git commit -m "feat(hooks): expose skuTiers + retry via useAI"
```

### Task 3.3: Trigger boot fetch in `AIProvider`

**Files:**
- Modify: `src/contexts/AIContext.tsx`

- [ ] **Step 1: Add the kick-off effect**

In `src/contexts/AIContext.tsx`, after the existing health-check `useVisibilityPolling` block and before the persistence `useEffect`:

```tsx
// Kick off SKU tier load once per provider lifetime. Idempotent — the action
// short-circuits if already loading/ready.
useEffect(() => {
  store.getState().loadSkuTiers();
  // store ref is stable for provider lifetime; no deps churn.
}, [store]);
```

- [ ] **Step 2: Verify no regression in existing AIProvider tests**

```bash
npx vitest run src/contexts/
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/contexts/AIContext.tsx
git commit -m "feat(boot): load SKU tiers on AIProvider mount"
```

---

## Phase 4: Dynamic `AI_TOOLS` builder

Goal: `deploy_app.size.enum` becomes a function of the resolved tier list, not a hardcoded array.

### Task 4.1: Refactor `tools.ts` to expose `buildAITools(skuTiers)`

**Files:**
- Modify: `src/ai/tools.ts`
- Modify: `src/ai/tools.test.ts`

- [ ] **Step 1: Update the tools test for the builder**

Change the top of `src/ai/tools.test.ts` to test `buildAITools` instead of the static const. Replace the existing `describe('AI_TOOLS', ...)` block (lines ~135-160) with:

```ts
import { buildAITools } from './tools';

const SAMPLE_TIERS = [
  { skuName: 'docker-micro', skuUuid: 'a', providerUuid: 'p', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-small', skuUuid: 'b', providerUuid: 'p', cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0.1, denomSymbol: 'PWR', unit: 1 },
];

describe('buildAITools', () => {
  it('returns 17 tools', () => {
    expect(buildAITools(SAMPLE_TIERS)).toHaveLength(17);
  });

  it('renders deploy_app.size.enum from tier list', () => {
    const tools = buildAITools(SAMPLE_TIERS);
    const deploy = tools.find(t => t.function.name === 'deploy_app');
    expect(deploy!.function.parameters.properties.size.enum).toEqual(['docker-micro', 'docker-small']);
  });

  it('omits size.enum when tier list is empty (model can still call but executor will reject)', () => {
    const tools = buildAITools([]);
    const deploy = tools.find(t => t.function.name === 'deploy_app');
    expect(deploy!.function.parameters.properties.size.enum).toBeUndefined();
  });

  it('keeps non-deploy tools unchanged regardless of tiers', () => {
    const a = buildAITools(SAMPLE_TIERS);
    const b = buildAITools([]);
    const stopA = JSON.stringify(a.find(t => t.function.name === 'stop_app'));
    const stopB = JSON.stringify(b.find(t => t.function.name === 'stop_app'));
    expect(stopA).toBe(stopB);
  });
});
```

Also update the existing test at line ~147 that asserts `AI_TOOLS.toHaveLength(17)` — if `AI_TOOLS` is being removed, drop that assertion; otherwise keep `AI_TOOLS` exported as a base list for `TOOL_PUBLIC_PARAMS` and assert its length here.

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run src/ai/tools.test.ts
```
Expected: FAIL — `buildAITools` undefined.

- [ ] **Step 3: Implement `buildAITools`**

In `src/ai/tools.ts`:

1. Rename the existing `AI_TOOLS` const to `BASE_AI_TOOLS` (keep all 17 entries — but in `deploy_app`, remove the hardcoded `enum: ['micro', 'small', 'medium', 'large']` and the description that mentions specific tiers).

Change the deploy_app `size` block from:

```ts
size: {
  type: 'string',
  description: 'Resource tier: micro, small, medium, or large. Applies to all services in a stack.',
  enum: ['micro', 'small', 'medium', 'large'],
},
```

to:

```ts
size: {
  type: 'string',
  description: 'Resource tier (SKU name). Applies to all services in a stack.',
},
```

2. Add the builder:

```ts
import type { ResolvedSkuTier } from '../api/skuTiers';

/**
 * Build the AI tool schema with the deploy_app.size enum sourced from the
 * resolved tier list. Pass an empty array (loading/error states) to omit the
 * enum constraint entirely — the executor will reject the tool invocation
 * with a "Tier catalog unavailable" message before broadcasting anything.
 */
export function buildAITools(tiers: readonly ResolvedSkuTier[]): ToolDefinition[] {
  return BASE_AI_TOOLS.map(tool => {
    if (tool.function.name !== 'deploy_app') return tool;
    if (tiers.length === 0) return tool;
    const props = tool.function.parameters.properties;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: {
          ...tool.function.parameters,
          properties: {
            ...props,
            size: {
              ...props.size,
              enum: tiers.map(t => t.skuName),
            },
          },
        },
      },
    };
  });
}
```

3. Replace consumers' `AI_TOOLS` import:
   - Keep `BASE_AI_TOOLS` exported as `AI_TOOLS` if any callers (tests, `getDisplaySafeArgs`, `VALID_TOOL_NAMES`) still need the static shape; or rename if no longer used.
   - **Recommendation:** keep `export const AI_TOOLS = BASE_AI_TOOLS;` so existing static derivations (`VALID_TOOL_NAMES`, `TOOL_PUBLIC_PARAMS`) keep working unchanged. Only `sendMessage` switches to `buildAITools(skuTiers)`.

- [ ] **Step 4: Run test to confirm pass**

```bash
npx vitest run src/ai/tools.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/tools.ts src/ai/tools.test.ts
git commit -m "refactor(ai): expose buildAITools(skuTiers) builder"
```

### Task 4.2: Wire `buildAITools` into `sendMessage`

**Files:**
- Modify: `src/stores/aiActions/sendMessage.ts`

- [ ] **Step 1: Update sendMessage to use the builder**

In `src/stores/aiActions/sendMessage.ts`:

Change the import:

```ts
import { buildAITools } from '../../ai/tools';
```

Inside the while-loop, before each `streamChat` call:

```ts
const tiers = get().skuTiers.tiers;
const tools = buildAITools(tiers);
```

Replace `tools: AI_TOOLS,` in the `streamChat({...})` call with `tools,`.

- [ ] **Step 2: Run sendMessage tests**

```bash
npx vitest run src/stores/aiActions/sendMessage.test.ts
```
Expected: PASS (the mock for `AI_TOOLS: []` continues to work because tests mock `'../../ai/tools'`).

- [ ] **Step 3: Commit**

```bash
git add src/stores/aiActions/sendMessage.ts
git commit -m "feat(ai): rebuild AI_TOOLS per-iteration from resolved tier list"
```

---

## Phase 5: Dynamic `systemPrompt` + `helpText` + `HelpCard`

Goal: Tier specs in the model prompt + `/help` come from the resolved list at call time. Loading/error states render placeholders.

### Task 5.1: `getSystemPrompt` consumes tiers

**Files:**
- Modify: `src/ai/systemPrompt.ts`
- Modify: `src/ai/systemPrompt.test.ts`

- [ ] **Step 1: Write failing test additions**

Append to `src/ai/systemPrompt.test.ts`:

```ts
const SAMPLE_TIERS = [
  { skuName: 'docker-micro', skuUuid: 'a', providerUuid: 'p', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-large', skuUuid: 'b', providerUuid: 'p', cores: 4, ramMB: 4096, diskGB: 20, pricePerHour: 0.5, denomSymbol: 'PWR', unit: 1 },
];

describe('getSystemPrompt with dynamic tiers', () => {
  it('renders only tiers from the resolved list', () => {
    const prompt = getSystemPrompt(undefined, SAMPLE_TIERS);
    expect(prompt).toContain('docker-micro');
    expect(prompt).toContain('docker-large');
    expect(prompt).not.toContain('docker-small');
    expect(prompt).not.toContain('docker-medium');
  });

  it('includes specs and price per tier', () => {
    const prompt = getSystemPrompt(undefined, SAMPLE_TIERS);
    expect(prompt).toMatch(/docker-micro.*0\.5 cores.*512 MB.*1 GB/);
    expect(prompt).toMatch(/0\.036.*PWR\/hr/);
  });

  it('falls back to a "tiers unavailable" notice when list is empty', () => {
    const prompt = getSystemPrompt(undefined, []);
    expect(prompt).toContain('Resource Tiers');
    expect(prompt).toMatch(/tier catalog/i);
  });
});
```

Update the existing `it('contains resource tiers', ...)` test — it currently expects 4 hardcoded tiers. Change to pass `SAMPLE_TIERS` and check for the ones from the sample.

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run src/ai/systemPrompt.test.ts
```
Expected: FAIL — function doesn't take a second arg.

- [ ] **Step 3: Update `getSystemPrompt`**

In `src/ai/systemPrompt.ts`:

Add import:

```ts
import type { ResolvedSkuTier } from '../api/skuTiers';
```

Update signature + tier block:

```ts
export function getSystemPrompt(address?: string, tiers: readonly ResolvedSkuTier[] = []): string {
  const tierBlock = tiers.length === 0
    ? '- (Tier catalog loading — if this persists, deploys are unavailable until SKUs load.)'
    : tiers.map(t =>
        `- ${t.skuName}: ${t.cores} cores, ${t.ramMB} MB RAM, ${t.diskGB} GB disk — ${t.pricePerHour.toFixed(4)} ${t.denomSymbol}/hr`
      ).join('\n');

  return `You are Barney, ...
...
## Resource Tiers
${tierBlock}

## Behavior
...
`;
}
```

(Keep all other prompt content identical — only the tier block changes.)

- [ ] **Step 4: Run test to confirm pass**

```bash
npx vitest run src/ai/systemPrompt.test.ts
```
Expected: PASS.

- [ ] **Step 5: Pass tiers from `sendMessage`**

In `src/stores/aiActions/utils.ts`, find `toChatApiMessages(messages, address)`. It internally calls `getSystemPrompt(address)`. Either:
- (Option A) Extend `toChatApiMessages` to accept `(messages, address, tiers)`; or
- (Option B) Call `getSystemPrompt(address, tiers)` inline in `sendMessage.ts` and have `toChatApiMessages` accept a pre-built system prompt.

Choose Option A for symmetry with how DNS state flows. Update signature:

```ts
export function toChatApiMessages(
  messages: ChatMessage[],
  address: string | undefined,
  tiers: readonly ResolvedSkuTier[] = [],
): ChatApiMessage[] {
  // ... use getSystemPrompt(address, tiers)
}
```

Update `src/stores/aiActions/sendMessage.ts` to pass `get().skuTiers.tiers`:

```ts
const apiMessages = toChatApiMessages(currentMessages, address, get().skuTiers.tiers);
```

- [ ] **Step 6: Run all affected tests**

```bash
npx vitest run src/ai/systemPrompt.test.ts src/stores/aiActions/utils.test.ts src/stores/aiActions/sendMessage.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ai/systemPrompt.ts src/ai/systemPrompt.test.ts src/stores/aiActions/utils.ts src/stores/aiActions/sendMessage.ts
git commit -m "feat(ai): render system prompt tier block from resolved list"
```

### Task 5.2: `helpText` → `buildHelpText(tiers)`

**Files:**
- Modify: `src/ai/helpText.ts`
- Modify: `src/ai/helpText.test.ts`
- Modify: `src/components/ai/ChatPanel.tsx` (call site)

- [ ] **Step 1: Update test**

Replace `src/ai/helpText.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { buildHelpText } from './helpText';

const SAMPLE_TIERS = [
  { skuName: 'docker-micro', skuUuid: 'a', providerUuid: 'p', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-large', skuUuid: 'b', providerUuid: 'p', cores: 4, ramMB: 4096, diskGB: 20, pricePerHour: 0.5, denomSymbol: 'PWR', unit: 1 },
];

describe('buildHelpText', () => {
  it('returns a non-empty string with key sections', () => {
    const text = buildHelpText(SAMPLE_TIERS);
    expect(text).toContain('Commands');
    expect(text).toContain('/help');
    expect(text).toContain('Resource tiers');
  });

  it('renders one row per resolved tier (no extras)', () => {
    const text = buildHelpText(SAMPLE_TIERS);
    expect(text).toContain('docker-micro');
    expect(text).toContain('docker-large');
    expect(text).not.toContain('docker-small');
    expect(text).not.toContain('docker-medium');
  });

  it('renders a status row when no tiers', () => {
    const text = buildHelpText([]);
    expect(text).toContain('Resource tiers');
    expect(text).toMatch(/loading|unavailable/i);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run src/ai/helpText.test.ts
```
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement `buildHelpText`**

Replace `src/ai/helpText.ts`:

```ts
import type { ResolvedSkuTier } from '../api/skuTiers';

function tiersSection(tiers: readonly ResolvedSkuTier[]): string {
  if (tiers.length === 0) {
    return '_Tier catalog loading — refresh in a moment._';
  }
  const rows = tiers.map(t =>
    `| ${t.skuName} | ${t.cores} cores | ${t.ramMB.toLocaleString()} MB | ${t.diskGB} GB | ${t.pricePerHour.toFixed(4)} ${t.denomSymbol}/hr |`
  ).join('\n');
  return `| Tier | CPU | Memory | Disk | Price |
|------|-----|--------|------|-------|
${rows}`;
}

export function buildHelpText(tiers: readonly ResolvedSkuTier[]): string {
  return `## Quick Reference

### Commands
| Command | Description |
|---------|-------------|
| \`/help\` | Show this help message |
| \`/clear\` | Clear chat history |

### What I can do
- **Deploy** apps from a manifest file or the built-in catalog
- **Stop**, **restart**, and **update** running apps
- **Check credits** and spending rate
- **List apps** and view their status
- **View logs** for running containers
- **Browse the provider catalog** and resource tiers
- **Query the chain** for leases, balances, and more

### Example prompts
- "Deploy postgres"
- "What's running?"
- "Check my credits"
- "Show logs for my-app"
- "Stop my-app"
- "Browse catalog"

### Resource tiers
${tiersSection(tiers)}

### Keyboard shortcuts
| Key | Action |
|-----|--------|
| **Enter** | Send message |
| **Shift + Enter** | New line |
| **\\u2191 \\u2193** | Browse input history |
| **/** | Focus chat input |
`;
}
```

- [ ] **Step 4: Update the call site in `ChatPanel.tsx`**

Find `import { HELP_TEXT } from '../../ai/helpText';` (line 12) and replace with:

```ts
import { buildHelpText } from '../../ai/helpText';
```

Find both `addLocalMessage(HELP_TEXT, { type: 'help', data: null })` calls and replace with:

```ts
addLocalMessage(buildHelpText(skuTiers.tiers), { type: 'help', data: null })
```

`skuTiers` is already coming from `useAI()` once Task 3.2 is merged — confirm the destructure includes it.

- [ ] **Step 5: Run all affected tests**

```bash
npx vitest run src/ai/helpText.test.ts src/components/ai/
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ai/helpText.ts src/ai/helpText.test.ts src/components/ai/ChatPanel.tsx
git commit -m "feat(ai): build /help text from resolved tier list"
```

### Task 5.3: `HelpCard` reads tiers from store

**Files:**
- Modify: `src/components/ai/HelpCard.tsx`
- Create: `src/components/ai/HelpCard.test.tsx`

- [ ] **Step 1: Write failing test**

Create `src/components/ai/HelpCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HelpCard } from './HelpCard';

vi.mock('../../hooks/useAI', () => ({
  useAI: vi.fn(),
}));
import { useAI } from '../../hooks/useAI';

const READY_TIERS = {
  phase: 'ready',
  tiers: [
    { skuName: 'docker-micro', skuUuid: 'a', providerUuid: 'p', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  ],
  denomSymbol: 'PWR',
  error: null,
};

function mockStore(skuTiers: unknown) {
  vi.mocked(useAI).mockReturnValue({ skuTiers, retrySkuTiers: vi.fn() } as never);
}

describe('HelpCard', () => {
  it('renders tier rows when ready', () => {
    mockStore(READY_TIERS);
    render(<HelpCard />);
    expect(screen.getByText('docker-micro')).toBeInTheDocument();
    expect(screen.getByText('0.5')).toBeInTheDocument();
  });

  it('shows skeleton row when loading', () => {
    mockStore({ phase: 'loading', tiers: [], denomSymbol: '', error: null });
    render(<HelpCard />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error message and Retry when errored', () => {
    mockStore({ phase: 'error', tiers: [], denomSymbol: '', error: 'chain down' });
    render(<HelpCard />);
    expect(screen.getByText(/chain down|catalog unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run src/components/ai/HelpCard.test.tsx
```
Expected: FAIL.

- [ ] **Step 3: Update HelpCard**

In `src/components/ai/HelpCard.tsx`:

Remove the static `TIERS` array (lines 22-27). Add `useAI` import:

```tsx
import { useAI } from '../../hooks/useAI';
```

Replace the entire `Resource tiers` section (the `<div className="help-card__section">` containing the table) with:

```tsx
const { skuTiers, retrySkuTiers } = useAI();

// ...

{/* Resource tiers */}
<div className="help-card__section">
  <div className="help-card__section-header">
    <Layers className="w-3.5 h-3.5" aria-hidden="true" />
    <span>Resource tiers</span>
  </div>
  {skuTiers.phase === 'ready' && skuTiers.tiers.length > 0 ? (
    <div className="help-card__table-wrap">
      <table className="help-card__table">
        <thead>
          <tr><th>Tier</th><th>CPU</th><th>Memory</th><th>Storage</th><th>Price</th></tr>
        </thead>
        <tbody>
          {skuTiers.tiers.map(t => (
            <tr key={t.skuName}>
              <td><span className="help-card__tier-badge">{t.skuName}</span></td>
              <td>{t.cores}</td>
              <td>{t.ramMB.toLocaleString()} MB</td>
              <td>{t.diskGB} GB</td>
              <td>{t.pricePerHour.toFixed(4)} {t.denomSymbol}/hr</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : skuTiers.phase === 'loading' ? (
    <p className="text-sm text-muted">Loading tier catalog…</p>
  ) : (
    <div>
      <p className="text-sm text-error">
        Tier catalog unavailable{skuTiers.error ? `: ${skuTiers.error}` : '.'}
      </p>
      <button type="button" className="btn btn-secondary btn-sm mt-2" onClick={() => retrySkuTiers()}>
        Retry
      </button>
    </div>
  )}
</div>
```

- [ ] **Step 4: Run test to confirm pass**

```bash
npx vitest run src/components/ai/HelpCard.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ai/HelpCard.tsx src/components/ai/HelpCard.test.tsx
git commit -m "feat(ui): HelpCard tier table reads from skuTiers slice"
```

---

## Phase 6: Executor — `VALID_SIZE_TIERS` from resolved list + clean error when unavailable

Goal: Drop hardcoded tier arrays in `compositeTransactions.ts`; thread `tiers` through `ToolExecutorOptions`; clean error if tiers aren't ready.

### Task 6.1: Add `tiers` to `ToolExecutorOptions`

**Files:**
- Modify: `src/ai/toolExecutor/types.ts`

- [ ] **Step 1: Add the field**

Open `src/ai/toolExecutor/types.ts`. Add an import:

```ts
import type { ResolvedSkuTier } from '../../api/skuTiers';
```

Append `tiers` to `ToolExecutorOptions`:

```ts
export interface ToolExecutorOptions {
  // ... existing fields ...
  /** Resolved SKU tier list from the AI store. Empty array means "not ready"
   *  — deploy executors should refuse with "Tier catalog unavailable". */
  tiers: readonly ResolvedSkuTier[];
}
```

- [ ] **Step 2: Run build to find call sites that need updating**

```bash
npm run build
```
Note all the TS errors — these are the call sites that need `tiers:` added. Expect them in:
- `src/stores/aiActions/sendMessage.ts`
- `src/stores/aiActions/confirmAction.ts`
- `src/stores/aiActions/batchDeploy.ts`
- `src/stores/aiActions/toolExecution.ts`
- Tests that mock options.

- [ ] **Step 3: Commit (type definition only)**

```bash
git add src/ai/toolExecutor/types.ts
git commit -m "feat(executor): add tiers to ToolExecutorOptions"
```

### Task 6.2: Thread `tiers` from store into every executor call site

**Files:**
- Modify: `src/stores/aiActions/sendMessage.ts`
- Modify: `src/stores/aiActions/confirmAction.ts`
- Modify: `src/stores/aiActions/batchDeploy.ts`
- Modify: `src/stores/aiActions/toolExecution.ts`

- [ ] **Step 1: In each file, where `ToolExecutorOptions` is constructed, add `tiers: get().skuTiers.tiers`**

For each occurrence of an options literal like `{ clientManager, address, signArbitrary, ... }`, append `tiers: get().skuTiers.tiers,`. The exact lines vary by file — use grep:

```bash
grep -n "appRegistry\|signArbitrary," src/stores/aiActions/*.ts
```

Each `ToolExecutorOptions` literal needs the new field.

- [ ] **Step 2: Update mocks in tests**

In each test that builds a fake `ToolExecutorOptions`, add `tiers: [],` to the literal. Run tests to find which:

```bash
npx vitest run src/stores/aiActions/
```

Address each failure by adding `tiers: []` or a sample tier array to the mock options.

- [ ] **Step 3: Run full test suite for this directory**

```bash
npx vitest run src/stores/aiActions/
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/stores/aiActions/
git commit -m "feat(executor): pipe skuTiers into ToolExecutorOptions"
```

### Task 6.3: Replace hardcoded `VALID_SIZE_TIERS` in `compositeTransactions.ts`

**Files:**
- Modify: `src/ai/toolExecutor/compositeTransactions.ts`
- Modify: `src/ai/toolExecutor/compositeTransactions.test.ts`

- [ ] **Step 1: Update the single-deploy path (line ~899)**

In `executeDeployApp` (around line 899), replace:

```ts
const VALID_SIZE_TIERS = ['micro', 'small', 'medium', 'large'] as const;
let size = (args.size as string | undefined)?.toLowerCase() || 'micro';
if (!VALID_SIZE_TIERS.includes(size as typeof VALID_SIZE_TIERS[number])) {
  return {
    success: false,
    error: `Invalid size "${size}". Valid tiers: ${VALID_SIZE_TIERS.join(', ')}.`,
  };
}
let skuName = `docker-${size}`;
```

with:

```ts
const { tiers } = options;
if (tiers.length === 0) {
  return { success: false, error: 'Tier catalog unavailable — try again in a moment.' };
}

const defaultSku = tiers[0].skuName;  // first tier in spec order = "smallest"; matches current "micro" default
const rawSize = (args.size as string | undefined)?.toLowerCase() || defaultSku;

// Accept both full SKU name ('docker-micro') and bare suffix ('micro') for backward compat with model output.
const matched = tiers.find(t => t.skuName === rawSize)
  ?? tiers.find(t => t.skuName.endsWith(`-${rawSize}`) || t.skuName === `docker-${rawSize}`);
if (!matched) {
  return {
    success: false,
    error: `Invalid size "${rawSize}". Valid tiers: ${tiers.map(t => t.skuName).join(', ')}.`,
  };
}
let skuName = matched.skuName;
let size = matched.skuName;  // size is now the canonical SKU name
```

Then the auto-upgrade-to-storage block (uses `STORAGE_SKU_NAME = 'docker-small'`) becomes:

```ts
if (args.storage === true && skuName !== STORAGE_SKU_NAME) {
  // Verify storage SKU is in the resolved tier list; if not, surface a clear error.
  const storageTier = tiers.find(t => t.skuName === STORAGE_SKU_NAME);
  if (!storageTier) {
    return {
      success: false,
      error: `Storage requires the "${STORAGE_SKU_NAME}" tier, which is not available on this network.`,
    };
  }
  skuName = STORAGE_SKU_NAME;
  size = STORAGE_SKU_NAME;
  storageUpgrade = true;
}
```

The downstream `resolveSkuItems([{ sku_name: skuName, quantity: 1 }], allSKUs)` lookup can stay — it's still hitting chain for the authoritative SKU UUID/provider info. But now we already have `matched.skuUuid` and `matched.providerUuid` from the resolved list — we can short-circuit:

```ts
const skuUuid = matched.skuUuid;
// Skip the resolveSkuItems chain-roundtrip — we already have the UUID.

// Find provider (still need apiUrl, which isn't in ResolvedSkuTier):
let providers;
try {
  providers = await withTimeout(getProviders(true), undefined, 'Fetch providers');
} catch (error) {
  logError('compositeTransactions.deploy.fetchProviders', error);
  return { success: false, error: 'Failed to fetch providers. Please try again.' };
}
const provider = providers.find((p) => p.uuid === matched.providerUuid);
```

(Drop the `allSKUs = await getSKUs(true)` call earlier in this function — no longer needed for tier resolution. The pricing block below it now reads from `matched.pricePerHour` directly.)

Replace the pricing block (lines ~957-974) with:

```ts
const priceDisplay = matched.pricePerHour > 0
  ? `${matched.pricePerHour.toFixed(4)} ${matched.denomSymbol}/hr`
  : '';
const skuHourlyCost = matched.pricePerHour;
```

Drop the now-unused `Unit` import / `UNIT_LABELS` references in this function (keep them for `browse_catalog`).

- [ ] **Step 2: Update the batch-deploy path (line ~1535)**

In `executeBatchDeploy`, replace the same block:

```ts
const VALID_SIZE_TIERS = ['micro', 'small', 'medium', 'large'] as const;
const normalizedSize = size.toLowerCase();
if (!VALID_SIZE_TIERS.includes(normalizedSize as typeof VALID_SIZE_TIERS[number])) {
  return { success: false, error: `Invalid size "${size}". Valid tiers: ${VALID_SIZE_TIERS.join(', ')}.` };
}
const skuName = `docker-${normalizedSize}`;
```

with:

```ts
const { tiers } = options;
if (tiers.length === 0) {
  return { success: false, error: 'Tier catalog unavailable — try again in a moment.' };
}

const rawSize = size.toLowerCase();
const matched = tiers.find(t => t.skuName === rawSize)
  ?? tiers.find(t => t.skuName === `docker-${rawSize}`);
if (!matched) {
  return { success: false, error: `Invalid size "${size}". Valid tiers: ${tiers.map(t => t.skuName).join(', ')}.` };
}
const skuName = matched.skuName;
const normalizedSize = matched.skuName;
```

Same simplification — replace the `resolveSkuItems` call + pricing block with direct reads off `matched`.

- [ ] **Step 3: Update the `confirmationMessage` for storage upgrade**

In the single-deploy path around line 1091, the current message is:

```ts
confirmationMessage: `Deploy "${name}"${stackInfo} on ${storageUpgrade ? 'small' : size} tier${storageUpgrade ? ' (upgraded for storage)' : ''}${priceInfo}?${creditWarning}`,
```

Change to use the canonical SKU name:

```ts
confirmationMessage: `Deploy "${name}"${stackInfo} on ${storageUpgrade ? STORAGE_SKU_NAME : size} tier${storageUpgrade ? ' (upgraded for storage)' : ''}${priceInfo}?${creditWarning}`,
```

- [ ] **Step 4: Update tests**

In `src/ai/toolExecutor/compositeTransactions.test.ts`, every mock of `options` now needs `tiers: [SAMPLE_TIER]`. Define a fixture at the top:

```ts
const SAMPLE_TIERS = [
  { skuName: 'docker-micro', skuUuid: 'sku-1', providerUuid: 'p-1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-small', skuUuid: 'sku-2', providerUuid: 'p-1', cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0.1, denomSymbol: 'PWR', unit: 1 },
];
```

Use it in every `executeDeployApp` / `executeBatchDeploy` call. Add a new test:

```ts
it('deploy_app returns clean error when tiers are unavailable', async () => {
  const result = await executeDeployApp({ image: 'redis' }, {
    ...mockOptions,
    tiers: [],
  });
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/tier catalog unavailable/i);
});

it('deploy_app accepts both "micro" and "docker-micro" for size', async () => {
  // ... resolve both forms to the same SKU
});

it('rejects size not in resolved tier list', async () => {
  const result = await executeDeployApp({ image: 'redis', size: 'xlarge' }, {
    ...mockOptions,
    tiers: SAMPLE_TIERS,
  });
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/docker-micro, docker-small/);
});
```

Remove or rewrite tests that asserted on the hardcoded enum if any.

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/ai/toolExecutor/
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ai/toolExecutor/compositeTransactions.ts src/ai/toolExecutor/compositeTransactions.test.ts
git commit -m "feat(executor): resolve size from store-driven tier list + clean error"
```

---

## Phase 7: UI inline degradation — deploy buttons + ConfirmationCard price line

Goal: Every deploy entry point reads `skuTiers.phase` and degrades inline; the `ConfirmationCard` shows live $/hour with skeleton/error states.

### Task 7.1: `ConfirmationCard` price line

**Files:**
- Modify: `src/components/ai/ConfirmationCard.tsx`
- Create: `src/components/ai/ConfirmationCard.skuPrice.test.tsx`

- [ ] **Step 1: Write failing test**

Create `src/components/ai/ConfirmationCard.skuPrice.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfirmationCard } from './ConfirmationCard';

vi.mock('../../hooks/useAI', () => ({ useAI: vi.fn() }));
import { useAI } from '../../hooks/useAI';

const SAMPLE_TIER = { skuName: 'docker-micro', skuUuid: 'a', providerUuid: 'p', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 };

function setStore(skuTiers: unknown) {
  vi.mocked(useAI).mockReturnValue({ skuTiers, retrySkuTiers: vi.fn() } as never);
}

const ACTION = {
  id: '1', toolName: 'deploy_app', description: 'Deploy redis',
  args: { app_name: 'redis', size: 'docker-micro' },
};

describe('ConfirmationCard SKU price line', () => {
  it('renders price for the resolved tier on ready', () => {
    setStore({ phase: 'ready', tiers: [SAMPLE_TIER], denomSymbol: 'PWR', error: null });
    render(<ConfirmationCard action={ACTION as never} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/0\.0360 PWR\/hr/)).toBeInTheDocument();
  });

  it('renders skeleton when loading', () => {
    setStore({ phase: 'loading', tiers: [], denomSymbol: '', error: null });
    render(<ConfirmationCard action={ACTION as never} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId('sku-price-skeleton')).toBeInTheDocument();
  });

  it('renders "—" warning when errored', () => {
    setStore({ phase: 'error', tiers: [], denomSymbol: '', error: 'chain down' });
    render(<ConfirmationCard action={ACTION as never} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/price unavailable/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run src/components/ai/ConfirmationCard.skuPrice.test.tsx
```
Expected: FAIL.

- [ ] **Step 3: Add the price line to `ConfirmationCard.tsx`**

In `src/components/ai/ConfirmationCard.tsx`:

Add import:

```tsx
import { useAI } from '../../hooks/useAI';
```

Near the top of the component body (after `const isDeployApp = action.toolName === 'deploy_app';`):

```tsx
const { skuTiers } = useAI();
const requestedSize = typeof action.args.size === 'string' ? action.args.size : undefined;
const selectedTier = isDeployApp && requestedSize
  ? skuTiers.tiers.find(t => t.skuName === requestedSize)
    ?? skuTiers.tiers.find(t => t.skuName === `docker-${requestedSize}`)
  : undefined;
```

Just before the `<div className="confirmation-actions">` block, add:

```tsx
{isDeployApp && (
  <div className="confirmation-details" data-testid="sku-price-row">
    <p className="confirmation-details-title">Estimated price</p>
    <div className="confirmation-payload">
      {skuTiers.phase === 'ready' && selectedTier ? (
        <span className="font-mono text-sm text-primary">
          {selectedTier.pricePerHour.toFixed(4)} {selectedTier.denomSymbol}/hr
        </span>
      ) : skuTiers.phase === 'loading' ? (
        <span className="text-sm text-muted animate-pulse" data-testid="sku-price-skeleton">
          Loading price…
        </span>
      ) : (
        <span className="text-sm text-warning">
          — Price unavailable ({skuTiers.error ?? 'tier catalog not ready'})
        </span>
      )}
    </div>
  </div>
)}
```

Also disable the Confirm button when `isDeployApp && skuTiers.phase !== 'ready'`:

```tsx
disabled={isExecuting || (isDeployApp && (
  editedDomainError != null ||
  asyncDomainPending ||
  stackServicePickerError ||
  skuTiers.phase !== 'ready'
))}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
npx vitest run src/components/ai/ConfirmationCard.skuPrice.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ai/ConfirmationCard.tsx src/components/ai/ConfirmationCard.skuPrice.test.tsx
git commit -m "feat(ui): ConfirmationCard renders live SKU price with degraded states"
```

### Task 7.2: ChatPanel deploy-button degradation

**Files:**
- Modify: `src/components/ai/ChatPanel.tsx`

- [ ] **Step 1: Add a `tiersReady` guard**

Near the top of `ChatPanel` (after the `useAI()` destructure), add `skuTiers`, `retrySkuTiers`:

```tsx
const { ..., skuTiers, retrySkuTiers } = useAI();
const tiersReady = skuTiers.phase === 'ready' && skuTiers.tiers.length > 0;
```

Where the example-app buttons are rendered (lines ~415, ~432, ~451), add `disabled` and a tooltip:

```tsx
<button
  key={app.label}
  type="button"
  onClick={() => deployExample(app)}
  disabled={!tiersReady}
  title={
    skuTiers.phase === 'loading' ? 'Loading tier catalog…' :
    skuTiers.phase === 'error' ? `Deploy unavailable: ${skuTiers.error}` :
    undefined
  }
  className="chat-suggestion chat-example-apps__stagger"
>
  {app.label}
</button>
```

Apply the same pattern at the three button sites.

Above the example-app row, when `skuTiers.phase === 'error'`, render a small banner with a retry button:

```tsx
{showExampleApps && skuTiers.phase === 'error' && (
  <div className="chat-example-apps__error" role="alert">
    <span>Deploy unavailable: {skuTiers.error}</span>
    <button type="button" onClick={() => retrySkuTiers()} className="btn btn-secondary btn-sm">Retry</button>
  </div>
)}
```

Also guard `deployExample` itself:

```tsx
const deployExample = async (app: ExampleApp) => {
  if (!tiersReady) return;
  // ... existing body
};
```

- [ ] **Step 2: Add a smoke test**

Add to `src/components/ai/ChatPanel.test.tsx` (or create) — verify buttons disabled when `phase === 'loading'`. Match the test fixture style of existing tests in that file.

If `ChatPanel.test.tsx` doesn't exist, defer to the manual `npm run dev` smoke check in Phase 8 — the disabled state is simple enough to verify by eye.

- [ ] **Step 3: Run lint + build**

```bash
npm run lint
npm run build
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ai/ChatPanel.tsx
git commit -m "feat(ui): disable example-app deploy buttons until tiers ready"
```

### Task 7.3: AppsSidebar re-deploy degradation

**Files:**
- Modify: `src/components/layout/AppsSidebar.tsx`

- [ ] **Step 1: Add `tiersReady` guard**

In `src/components/layout/AppsSidebar.tsx`:

Pull `skuTiers` from `useAI`:

```ts
const { sendMessage, attachPayload, dnsStatuses, skuTiers } = useAI();
const tiersReady = skuTiers.phase === 'ready' && skuTiers.tiers.length > 0;
```

At the Re-deploy button (line ~366), add `disabled={!tiersReady}` and update the title:

```tsx
<button
  type="button"
  onClick={...}
  disabled={!tiersReady}
  aria-label={`Re-deploy ${app.name}`}
  title={tiersReady ? 'Re-deploy' : 'Tier catalog unavailable'}
  className="apps-sidebar__app-action"
>
  ...
</button>
```

- [ ] **Step 2: Build + lint**

```bash
npm run lint
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/AppsSidebar.tsx
git commit -m "feat(ui): disable sidebar re-deploy when tiers unavailable"
```

---

## Phase 8: Integration + verification

### Task 8.1: Run the full test suite

- [ ] **Step 1: Run all unit + integration tests**

```bash
npm test
```
Expected: PASS — all suites green.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```
Expected: clean.

- [ ] **Step 3: Run typecheck via build**

```bash
npm run build
```
Expected: success.

### Task 8.2: Manual smoke test (`npm run dev`)

- [ ] **Step 1: Configure `.env.local` with `PUBLIC_SKU_SPECS`**

Use the same JSON as the `.env.example` default (4 SKUs). Confirm the chain endpoint (`PUBLIC_REST_URL`) is reachable.

- [ ] **Step 2: Start dev server**

```bash
npm run dev
```

- [ ] **Step 3: Verify boot states**

In the browser:
1. On wallet connect, the chat panel mounts.
2. Open `/help`. Confirm the **Resource tiers** table shows the 4 SKUs from chain with prices (e.g., `0.0360 PWR/hr`) — not the old hardcoded values.
3. Try a deploy: "Deploy redis". The `ConfirmationCard` shows an **Estimated price** row matching the resolved tier.
4. Network-tab inspection: only **one** call to the SKU LCD endpoint (`/liftedinit/sku/v1/skus`) during boot — no periodic polling.

- [ ] **Step 4: Verify degradation**

1. Stop the chain (or block the LCD endpoint via DevTools).
2. Hard-refresh. Confirm:
   - HelpCard tiers section → "Tier catalog unavailable" + Retry button.
   - Example-app buttons → disabled, hover tooltip says "Deploy unavailable".
   - `ConfirmationCard` (if you can trigger one — likely you can't from a chat message because the AI tool will refuse first) → would show "Price unavailable".
   - AI deploy: "Deploy redis" → tool returns "Tier catalog unavailable — try again in a moment."
3. Click Retry — chain restored, state flips to ready.

- [ ] **Step 5: Verify config-drift warning**

1. Edit `.env.local`: remove `docker-large` from `PUBLIC_SKU_SPECS`.
2. Hard-refresh. Confirm:
   - Console shows the `missingSpec` warning for `docker-large`.
   - HelpCard table only shows 3 tiers.
   - System prompt only lists 3 tiers (verify via the `deploy_app` size enum in the chat panel devtools network tab — the AI request body's `tools[].function.parameters.properties.size.enum` should have 3 entries).
3. Add `docker-large` back; restart dev server; confirm 4 again.

- [ ] **Step 6: Verify Unit normalization**

If a SKU in the active set uses `UNIT_PER_DAY`, confirm its `/hr` display = (daily price)/24. Otherwise, this is covered by the unit tests in Phase 2.

### Task 8.3: Final commit + PR-prep

- [ ] **Step 1: Final commit if any cleanup needed**

```bash
git status
git diff
```

- [ ] **Step 2: Push and open PR** (handled by team-lead / `commit-commands:commit-push-pr` skill)

---

## Risks & Open Questions

### Risks

1. **`size` value semantics change.** Today the executor expects bare `'micro'` / `'small'` etc. and prefixes with `docker-`. After Phase 6 it accepts both forms — but the AI tool's `size.enum` will only list full SKU names. The system prompt should also use the full names. **Mitigation:** the executor backward-compat lookup (`docker-${rawSize}` fallback) handles legacy chat history; new model invocations get the canonical name from the enum.

2. **`buildAITools` per-iteration rebuild cost.** `sendMessage` rebuilds the 17-tool array each model turn. Negligible — 17 small object spreads, sub-millisecond. Worth noting in case a future profile flags it.

3. **`resolveSkuItems` short-circuit.** Phase 6 skips the `resolveSkuItems` chain-roundtrip in deploy paths because we already have the SKU UUID from the resolved tier. This is correct but a notable behavior change — if `resolveSkuItems` had side-effects beyond UUID resolution (it doesn't, per the source), this would break. **Verify:** read `src/ai/toolExecutor/transactions.ts:resolveSkuItems` once before merging.

4. **`STORAGE_SKU_NAME` ('docker-small') hardcoded coupling.** If a network ships without `docker-small`, the `args.storage=true` upgrade fails with a clear error (Phase 6 added that branch). But `STORAGE_SKU_NAME` in constants.ts is still hardcoded. Consider promoting it to a SKU-name predicate (e.g., `tier.diskGB >= 5`) — **out of scope for this ticket**, but flag for ENG-242 follow-up.

5. **Browse-catalog independence.** `browse_catalog` (in `compositeQueries.ts`) still calls `getSKUs()` directly and uses chain `Unit` for display. That's fine — its purpose is the raw catalog view including SKUs without spec entries. Don't touch it.

### Open Questions

1. **What's the canonical "default" tier?** Currently `'micro'`. After this refactor, the default in `executeDeployApp` becomes `tiers[0].skuName` (insertion order of the env spec map). The `.env.example` orders specs `micro → small → medium → large`, so the default stays `docker-micro`. If networks ship specs in a different order, defaults shift. **Decision:** rely on insertion order; document this in the `.env.example` comment.

2. **Stack deploys with mixed-tier services?** Out of scope; current code applies one `size` to all services in a stack. No change here.

3. **Caching policy.** Spec says "session-lifetime cache, no periodic refresh." The store slice naturally provides this — `loadSkuTiers` short-circuits when `phase === 'ready'`. The retry action forcibly resets to `idle` and re-fetches. Wallet switches do **not** reset SKU state (chain is the same regardless of wallet). Consider whether a `setAddress` chain change should invalidate — not for this ticket; flag for future if `PUBLIC_CHAIN_ID` changes are ever supported at runtime.

---

## Verification Commands (final pass)

Run all from the worktree root:

```bash
npm run lint
npm run build
npm test
```

All must be green before handing off to QA. The `npm run dev` smoke test from Task 8.2 is the QA's primary acceptance gate.

---

## Self-Review Summary

- **Spec coverage:** all 11 numbered ticket items mapped:
  1. `PUBLIC_SKU_SPECS` → Phase 1
  2. Fetch at startup, session cache → Phase 3.3
  3. Progressive boot, Zustand slice → Phase 3.1
  4. Failure UX, retry → Phase 3.1 + Phase 7
  5. Config-drift policy (intersection + warn) → Phase 2 `resolveSkuTiers`
  6. $/hour normalization → Phase 2 `hourlyPriceFromSku`
  7. `AI_TOOLS` dynamic → Phase 4
  8. `VALID_SIZE_TIERS` from resolved list → Phase 6
  9. `systemPrompt.ts` dynamic → Phase 5.1
  10. `helpText.ts` dynamic → Phase 5.2
  11. `ConfirmationCard` live $/hour → Phase 7.1
- **Inline degradation contract:** deploy buttons (Phase 7.2, 7.3), ConfirmationCard (Phase 7.1), `deploy_app` tool (Phase 6.3), `/help` tier section (Phase 5.3).
- **Out-of-scope respected:** no CPU/RAM/Disk on chain, no provider-level pricing variance UX changes, no periodic refresh.
