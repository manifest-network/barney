# Contributing

Thanks for your interest in contributing to Barney. This guide covers local setup, the development workflow, and the conventions we follow.

For an overview of the codebase, read [ARCHITECTURE.md](ARCHITECTURE.md). For unfamiliar concepts (Cosmos modules, leases, Manifest billing), read [docs/dev/primer.md](docs/dev/primer.md).

## Prerequisites

- **Node.js >= 20** (the production Docker build pins Node 22 via `Dockerfile`'s `node:22-alpine3.21` base; there is no general PR/CI workflow today)
- **npm >= 10**
- A **Morpheus API key** (request access from [mor.org](https://mor.org)) — required to test AI features
- Optional: a local Manifest Network node, or use the public testnet endpoints (`https://nodes.liftedinit.tech/manifest/testnet/api`, `https://nodes.liftedinit.tech/manifest/testnet/rpc`)

## Local setup

```bash
git clone https://github.com/manifest-network/barney.git
cd barney
npm install --legacy-peer-deps
cp .env.example .env.local
# Edit .env.local — at minimum set MORPHEUS_API_KEY
npm run dev
```

The dev server starts at <http://localhost:3000>.

### Why `--legacy-peer-deps`?

`@cosmos-kit/react` and `@interchain-ui/react` declare incompatible peer ranges for React 19. The flag is required for installs to succeed and is used by both local development and the production Docker build. If you forget it, `npm install` will fail with a peer-dependency error.

### Patches

The `patches/` directory contains `patch-package` patches applied automatically via the `postinstall` script. There is currently one patch:

- **`@cosmos-kit+web3auth+2.16.6-ll.1.patch`** — relaxes `Web3AuthSigner.signAmino`'s chain-ID check to allow an empty `chain_id` in the sign doc. This is required for ADR-036 off-chain signatures (provider auth tokens), which use `chain_id: ''` by convention. Without the patch every provider HTTP call would fail with "Chain ID mismatch".

If a patched dependency is bumped, re-apply the patch logic against the new version and regenerate the file with `npx patch-package @cosmos-kit/web3auth`. Verify ADR-036 provider auth still works (deploy an app — the manifest upload step exercises it).

## Daily workflow

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start the dev server (Rsbuild) |
| `npm run lint` | Run ESLint |
| `npm test` | Run the full Vitest suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Tests with v8 coverage report |
| `npx tsc -b` | Type-check (no emit) |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run preview` | Serve the production build locally |

Run a single test file or pattern:

```bash
npx vitest run src/utils/hash.test.ts
npx vitest run -t "validateFile"
```

See [docs/dev/testing.md](docs/dev/testing.md) for testing patterns and mock conventions.

## Branching and commits

- Work on a feature branch off `main`. Branch names should be descriptive and lower-cased (`feat/multi-region-providers`, `fix/manifest-port-validation`, `chore/bump-mcp-fred`).
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit subjects: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`. Recent history (`git log`) is the source of truth for tone and scope.
- **Always create new commits — never amend or force-push** to a shared branch.
- Keep commits focused. A bug fix and a refactor belong in separate commits, even if discovered together.

## Pull requests

Before opening a PR:

1. **Run the full validation suite locally:** `npm run lint && npx tsc -b && npm test`.
2. **Update relevant documentation** — if you changed an architectural pattern, update [CLAUDE.md](CLAUDE.md) and/or [ARCHITECTURE.md](ARCHITECTURE.md). If you added user-visible behaviour, update [docs/user/](docs/user/).
3. **Add or update tests.** New tools, hooks, and store actions need tests. Bug fixes need a regression test.
4. **Write a clear description** — what the change does, why, and any caveats. Link related issues.

CI runs the full validation suite. PRs are merged once approved and green.

## Coding conventions

These are enforced by code review (and occasionally by lint). Specifics live in [CLAUDE.md](CLAUDE.md), but the headlines:

### TypeScript

- Strict mode is on. Don't widen types to `any` to make a type error go away — fix the underlying mismatch.
- Where manifestjs's generated `fromPartial` / `lcdConvert` types reject object literals, the project pattern is to use `any` *only* for that specific argument and keep the surrounding code typed. See `buildMsg` in `src/api/tx.ts` for the canonical example.
- Use discriminated unions for tool / transaction results (`ToolResult`, `TxResult`). Narrow on the discriminator before accessing payload fields.
- Re-export manifestjs types from the wrapping module (`src/api/billing.ts`, `src/api/sku.ts`) rather than importing from `@manifest-network/manifestjs/dist/codegen/...` in feature code.

### React

- Components are function components with hooks. No class components except `ErrorBoundary`.
- Use `useShallow` (already wrapped in `useAI`) when selecting multiple fields from the Zustand store to avoid spurious re-renders.
- Avoid setting refs during render. Use a `useEffect` (no deps array for the "latest value" pattern).
- New visual components belong in `src/components/ui/` if reusable, or under their feature directory (`ai/`, `layout/`, `landing/`) if not.

### State and side effects

- AI chat state belongs in the Zustand store (`src/stores/aiStore.ts` and `src/stores/aiActions/`), not in component state.
- Async work belongs in `aiActions/` modules — they receive `get`/`set` and stay testable as plain functions.
- Persistence subscriptions go through `aiActions/persistence.ts`. Avoid writing to localStorage from feature code; use the registry or `versionedStorage` helpers.
- **`versionedStorage` migrations.** `createVersionedStorage` enforces `migrations.length === version` at construction — a typo throws at module load. Each `migrations[v]` upgrades from `v` to `v + 1`; returning `null` from a migration discards the entry. Loaded data also runs through `validate(...)`, which must return `T` or `null` (corrupted entries are dropped silently). `src/hooks/useAccountSetup.ts:62-106` is the canonical worked example with a V0 → V1 → V2 chain, including a `setupCompleted` derivation that recovers data from the prior `useAutoRefill` schema. Bumping the version number requires adding exactly one new entry to `migrations[]` and updating `validate` for any new fields.

### Errors

- Use `logError(context, error)` from `src/utils/errors.ts` instead of raw `console.error`. The `context` string should be descriptive (`'aiActions.sendMessage.streamFailure'`).
- Use `withRetry` from `src/api/utils.ts` for transient network errors during tool execution. The default retry classifier (`isTransientError`) only matches network-layer failures: error messages containing `fetch`, `network`, `econnrefused`, `timeout`, `failed to fetch`, `load failed`, plus any `TypeError` (Firefox network failures often surface as `TypeError`). HTTP 5xx, 4xx, validation errors, and chain errors are *not* retried. `AbortError` is never retried. The default retry budget is `AI_MAX_RETRIES` (3 attempts on top of the initial call) with exponential backoff plus jitter starting at `AI_RETRY_BASE_DELAY_MS` (1 s).
- Don't swallow errors silently. If a fallback is required, log the original failure first.

### Constants

- Tunable values (timeouts, cache sizes, limits) live in `src/config/constants.ts`. Don't inline magic numbers.
- Runtime-configurable values use `getNumericConfig(key, fallback)` and have a corresponding `PUBLIC_*` env var documented in `runtimeConfig.ts` and `README.md`.

### Comments

The default is *no comment*. Add a comment only when the *why* is non-obvious — a hidden constraint, a workaround, surprising behaviour. Don't restate what the code does.

### Tests

- New code requires tests. Pure logic goes in unit tests; integration paths go in `src/__tests__/`.
- Mock external libraries via `vi.mock(...)`. When mocking a manifestjs / mono module, use `importOriginal` so enums (`Unit`, `LeaseState`) survive — see `src/api/billing.test.ts` for the pattern.
- Tests use **`happy-dom`**, not jsdom. Some browser APIs behave subtly differently — when in doubt, check `vitest.config.ts`.
- ESLint disables `@typescript-eslint/no-explicit-any` in test files. Use that latitude for mock typing, not for production code.

## What to update when…

| Change | Update |
|--------|--------|
| Adding a tool | `src/ai/tools.ts`, `src/ai/toolExecutor/index.ts`, the relevant `composite*.ts`, `getToolCallDescription`, system prompt example, [docs/dev/adding-a-tool.md](docs/dev/adding-a-tool.md), [docs/user/ai-cookbook.md](docs/user/ai-cookbook.md), [CLAUDE.md](CLAUDE.md) tool table |
| Adding an example app | `src/config/exampleApps.ts`, [docs/dev/adding-an-example-app.md](docs/dev/adding-an-example-app.md) |
| Adding a runtime env var | `src/config/runtimeConfig.ts` (key, BUILD_ENV, DEFAULTS, NUMERIC_LIMITS if applicable), `docker/env.sh` (envsubst list), `docker/config.js.template`, `.env.example`, [README.md](README.md) env table |
| Adding a constant | `src/config/constants.ts`, [CLAUDE.md](CLAUDE.md) constants table |
| Refactoring AI state | `src/stores/aiStore.ts`, `src/stores/aiActions/`, [ARCHITECTURE.md](ARCHITECTURE.md) state-layer section |
| Adding a known image / stack | `src/ai/knownImages.ts` (the catalog is intentionally self-evident — no separate doc) |
| Changing the build / deploy | `Dockerfile`, `docker/`, [docs/dev/deployment.md](docs/dev/deployment.md), `.github/workflows/release.yml` |

## Releasing

Releases are tagged on `main` with a semver tag (`v0.2.0`, `v1.0.0-rc.1`, …). The [release workflow](.github/workflows/release.yml) then:

1. Validates the tag against semver.
2. Builds and pushes the Docker image (architecture matches the CI runner — `linux/amd64` on `ubuntu-latest`) to `ghcr.io/manifest-network/barney:{version,major.minor,major,latest}`.
3. Creates a GitHub Release with auto-generated notes and the image digest.

Pre-release tags (e.g. `v1.0.0-rc.1`) are pushed as pre-releases and do not move the `:latest` tag. Only maintainers should push tags.

## Reporting bugs and asking questions

- **Bugs:** open a GitHub issue with reproduction steps, expected vs. actual behaviour, and the environment (browser, hosted instance vs. local).
- **Security issues:** do not open a public issue. Use GitHub's private vulnerability reporting (Security → Report a vulnerability) so disclosure stays coordinated.
- **Questions:** prefer GitHub Discussions over issues for open-ended questions.

## License

Contributions are made under the project's existing license. Do not add files with conflicting licenses.
