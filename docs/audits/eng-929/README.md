# ENG-929 dependency disposition review

Review date: 2026-10-28. Owner: Barney maintainers (Felix Morency).
Issue: [ENG-929](https://linear.app/liftedinit/issue/ENG-929). Base commit: `5f02ca6`.

This review renews the [ENG-832](../eng-832/README.md) residual dispositions, whose
2026-10-10 expiry had passed, and clears the GitHub Dependabot alerts opened against
`package-lock.json` on 2026-10-28.

## Evidence

[before.json](before.json) (lockfile of `5f02ca6`) and [after.json](after.json) record
full and production-only locked-graph audits in the ENG-832 snapshot format. npm counts
include affected parent packages; they are not counts of distinct advisories.

| Locked graph | Scope | High | Moderate | Low | Total |
| --- | --- | ---: | ---: | ---: | ---: |
| Before | Full | 3 | 7 | 46 | 56 |
| Before | `--omit=dev` | 2 | 6 | 42 | 50 |
| After | Full | 0 | 0 | 46 | 46 |
| After | `--omit=dev` | 0 | 0 | 42 | 42 |

Every remaining record derives from two low advisories without a patched release:
elliptic and deepmerge. No critical, high, or moderate advisory remains.

## Dependency decisions

| Package | Advisories | Change |
| --- | --- | --- |
| `happy-dom` | [GHSA-834v-8h66-3h79](https://github.com/advisories/GHSA-834v-8h66-3h79) (high) | 20.14.3 → 21.0.4. The 21.x major disables CSS and iframe loading by default; no test relied on either. |
| `vitest`, `@vitest/coverage-v8`, `@vitest/mocker` | [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp) | 4.1.11 → 4.1.12, moved together. |
| `vite` | [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) (high), [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22), [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw), [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv), [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw) | 7.3.6 → 7.3.7, staying on the 7.x line. Vite remains Vitest-only; Barney builds and serves with Rsbuild. |
| `brace-expansion` | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), plus npm's 1.x/2.x ranges for [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) and [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | Lockfile refresh to 1.1.21 / 2.1.7 within the existing minimatch ranges. Lint-only. |
| `pbkdf2` | [GHSA-477h-4r7f-fvrx](https://github.com/advisories/GHSA-477h-4r7f-fvrx) | Lockfile refresh to 3.1.7 within crypto-browserify's range. Reported by npm, not yet by Dependabot. |
| `stream-json` | [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x), [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc), [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x) | Removed from the graph by the `jayson` override below. The ENG-832 disposition is retired. |

### Jayson 5.0.0 override

Path: Web3Auth modal → Solana web3.js 1.99.0 → Jayson. Solana declares `jayson@^4.3.0`,
so the override crosses its declared major range, as the ENG-832 protobufjs override did.

Every Solana entry (browser, Node CJS/ESM, native) imports only `jayson/lib/client/browser`.
In Jayson 5.0.0 that module differs from 4.3.0 only in formatting and its default request-id
generator: `uuid.v4()` is replaced by `crypto.randomUUID()` with a `getRandomValues` fallback.
The constructor, `request` overloads, batch handling, and response parsing are unchanged.
The major bump replaced the stream-json-based Node `parseStream` server helper, which
Solana does not call; Jayson 5 also drops its uuid dependency.

`dependencyCompatibility.test.ts` resolves Jayson from the installed Solana consumer, asserts
the override version and that stream-json is unresolvable from it, and round-trips single and
batch requests the way Solana's RPC adapter builds them. The browser safety guard still rejects
any stream-json import as a regression check.

## Scoped residual dispositions

These decisions apply only to the named advisory, version, and usage. They do not accept
future advisories or other call paths. Review expires **2027-01-28**; the owner must remove
the dependency, land an upstream fix, or renew the decision with fresh evidence.
[ENG-837](https://linear.app/liftedinit/issue/ENG-837) still owns the blocking audit gate.

### elliptic 6.6.1: reachable wallet cryptography (renewed)

Advisory: [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84) (low).
6.6.1 is still the latest release and no patched version exists. The ENG-832 analysis is
unchanged: CosmJS 0.32.4 and Torus cryptography use it during real wallet signing and
signer-worker authentication. The consumer-resolved CosmJS 0.32.4 boundary test still holds.
Removal requires the coordinated Manifest SDK/CosmJS fork migration tracked by
[ENG-808](https://linear.app/liftedinit/issue/ENG-808) and a Torus migration.

### deepmerge 4.3.1: Web3Auth and style configuration merges (new)

Advisory: [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) (low).
4.3.1 is the latest release and no patched version exists. A crafted source object can
poison the prototype of the object `deepmerge` returns; it does not modify the global
`Object.prototype`. Barney does not import deepmerge.

Inspected browser call sites merge library defaults with:

- Barney's own Web3Auth configuration and login parameters (`authConnector`, `noModal`,
  `modalManager`).
- Web3Auth's project configuration fetched from Web3Auth's dashboard API (whitelabel,
  login modal, and connector settings in `noModal`, `modalManager`, and `ws-embed`).
- Torus HTTP request options; request bodies are excluded from the merge.
- vanilla-extract style rules authored by Interchain UI.

None of these inputs come from chain data, provider responses, chat, or uploaded manifests.
The Web3Auth project configuration is trusted at the same level as the Web3Auth SDK itself.

Disposition: retain while Web3Auth, Torus, and vanilla-extract depend on deepmerge 4.x.
Reassess if a patched release or a maintained fork appears, or if Barney passes
user-controlled objects into Web3Auth configuration.

## Validation

Local run on Node 24.15.0 / npm 11.12.1 (CI pins Node 22.19.0):

- `npm ls --all` passes; `npm audit` matches [after.json](after.json).
- `npm run lint`: no errors.
- `tsc -b` passes; `npx vitest run`: **3,754 tests in 143 files passed**.
- `npm run build` and `npm run check:bundle` pass.
