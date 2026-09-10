# ENG-832 dependency audit

Review date: 2026-09-10. Owner: Barney maintainers (Felix Morency).
Issue: [ENG-832](https://linear.app/liftedinit/issue/ENG-832).
Original commit: `19f321568c461ddb9415b28ef1e59ac068a3c815`.

## Evidence

[before.json](before.json) and [after.json](after.json) record full and production-only locked-graph audits,
including package paths and advisory URLs. npm counts include affected parent
packages: they are not counts of distinct vulnerabilities. Production-only npm
classification does not establish that a package executes in production.

| Original locked graph | Critical | High | Moderate | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full | 3 | 33 | 31 | 27 | 94 |
| `--omit=dev` | 1 | 22 | 26 | 22 | 71 |

| Updated locked graph | Critical | High | Moderate | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full | 0 | 7 | 3 | 42 | 52 |
| `--omit=dev` | 0 | 7 | 3 | 38 | 48 |

The remaining records derive from four advisory URLs across three packages:
locally patched image-size (two high advisories), stream-json (one moderate), and
elliptic (one low). Native peers now installed by normal npm resolution add
affected parent-package records. The table preserves those counts instead of
presenting the patched graph as an audit with zero high findings.

The runtime image copies the built SPA and `server/`, without `node_modules`.
The Node relay imports local files and Node builtins only. Browser dependencies,
build/test tooling, and optional native peers are evaluated separately in
[reachability.md](reachability.md).

## Dependency decisions

- Vitest and coverage move together to 4.1.11; Vite stays explicitly on the patched
  7.3.6 line. Happy DOM moves to 20.14.3.
- Rsbuild moves to 1.7.6 and its React/Node-polyfill plugins to 1.4.6. PostCSS moves
  to 8.5.28. Explicit `127.0.0.1` binding covers both development and preview.
- Interchain UI 1.26.3 supports React 19 and satisfies Cosmos Kit's peer range.
  React type packages satisfy Cosmos Kit's published `latest` peer requirements.
- The imported chain-registry types are explicitly pinned to the compatible
  0.50.297 schema. The unused `chain-registry` data package is removed so its
  incompatible type major cannot become the app's undeclared import.
- The Axios override follows the direct 1.20.0 pin, including parents with exact
  older pins. PostCSS uses the same direct-pin override pattern.
- Protobufjs 7.6.6 backports security fixes while retaining the existing minimal
  reader/writer API. The override replaces 6.x in generated Keplr/ICS23 consumers;
  exact wire bytes, maximum uint64 values, proof verification, and real wallet
  signatures are covered by `dependencyCompatibility.test.ts`.
- UUID 11.1.1 retains CommonJS support. Existing consumers use v1, v4, parse, or validate;
  moving to a newer ESM-only major would change their import contract.
- WebSocket overrides retain each consumer's major: 7.5.13 and 8.21.3.
- Explicit root optional peers select Async Storage 1.24.0, ox 0.11.3, and
  utf-8-validate 5.0.10. npm can then nest Web3Auth's required Async Storage 2.x,
  WalletConnect's ox 0.9.x, and rpc-websockets' utf-8-validate 6.x under their
  respective consumers. These are real packages satisfying declared ranges.
- npm ignores the old Yarn `resolutions` block, so it is removed. Supported
  Manifest SDK/CosmJS forks remain pinned; there is no blanket CosmJS migration.

## Scoped residual dispositions

These decisions apply only to the named advisory, version, and usage below.
They do not accept future advisories or other call paths. Review expires
**2026-10-10**; the owner must remove the dependency, land an upstream fix, or
renew the decision with fresh evidence. Raw npm audit results remain visible.

### image-size 1.2.1: locally patched

Advisories: [ICNS non-progressing entries](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
and [JXL/HEIF non-progressing boxes](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq).
No fixed upstream version was available on the review date.

Normal peer installation brings this package through Async Storage's required
React Native peer, the React Native CLI, and Metro. Barney invokes Rsbuild rather
than Metro, and does not copy these Node packages into its runtime image.

The pinned [source patch](../../../patches/image-size+1.2.1.patch), applied by
`patch-package --error-on-fail` during `postinstall`, rejects short ICNS entry headers and entry
lengths below eight bytes, and rejects short/non-progressing shared box headers.
It preserves the v1 buffer, filename, and callback APIs used by Metro. Tests run
the installed parser in bounded child processes, covering the malicious inputs
and valid image/API fixtures. The browser resolution guard rejects `image-size`
imports, including imports reached through the otherwise permitted MCP issuer.
Installation uses `--error-on-fail`; a regression fixture verifies an incompatible
required patch stops installation outside CI and test environments as well.

Disposition: retain the patched package until the native peer requirement can be
removed upstream or a maintained compatible replacement is available. npm audits
identify versions rather than local patch contents, so these high findings remain
reported. The patch and regression tests are required whenever this pin changes.

### stream-json 1.9.1: affected filters are outside the consumed API

Advisory: [quadratic path filters](https://github.com/advisories/GHSA-528h-pc64-c93x).
Path: Web3Auth → Solana web3.js → Jayson → stream-json.

Solana's browser entry uses `jayson/lib/client/browser`, which does not import
stream-json. Jayson's Node streaming code imports `StreamValues` and `Verifier`,
not the affected pick/ignore/filter/replace APIs; the advisory explicitly excludes
the streaming-value helpers. Barney's relay imports none of these packages, and
the browser resolution guard rejects any stream-json import.

Disposition: retain for this exact usage while Jayson depends on its v1 CommonJS
API. A version-only override to the patched v3 line breaks Jayson's module paths
and API. Reassess on any Node Solana/Jayson integration or filter use, and migrate
when the parent supports a patched release.

### elliptic 6.6.1: reachable wallet cryptography

Advisory: [risky cryptographic implementation](https://github.com/advisories/GHSA-848j-6mx2-7j84).
There is no patched release. This dependency is used by CosmJS 0.32.4 and Torus
cryptography during real wallet signing and signer-worker authentication.
It is not classified as unused or eliminated by the browser guard.

Disposition: retain this low-severity finding temporarily to preserve the
supported Manifest SDK and custom Stargate/Web3Auth compatibility boundary.
Moving to modern CosmJS requires a coordinated SDK/fork migration; Torus must
also migrate before elliptic disappears. Existing typed transaction consent,
wallet/chain binding, and authenticated signer-worker messages remain in force;
they restrict signing requests but do not fix the library's cryptographic design.
Tests verify real signatures and reject foreign-chain and corrupted-worker
responses. Review the upstream SDK and Torus migration before the expiry date.

## Reproduction and validation

Run from the repository root using Node 22.19.0 (the CI pin):

```sh
npm ci
npm ls --all
npm audit --package-lock-only --json
npm audit --package-lock-only --omit=dev --json
npm run lint
npm run test:coverage
npm run build
npm run check:bundle
```

Audit exits can remain nonzero for the exact dispositions above. Do not replace
raw audit evidence with a severity filter or omit peers to make totals disappear.

Validation on Node 22.19.0 / npm 10.9.3:

- Normal `npm ci` completed with both required patches. The final explicit chain
  type pin was installed normally, followed by a successful `npm ls --all` and
  an offline `npm ci --dry-run --ignore-scripts` lock-consistency check.
- `npm run test:coverage -- --maxWorkers=4`: **2,629 tests in 112 files passed**.
  Coverage: statements 82.56%, branches 78.02%, functions 78.75%, lines 84.86%.
  The final browser-guard query/fragment/loader cases passed in a focused rerun.
- Existing deployment, consent, authentication, and relay tests passed. New
  compatibility tests exercise the installed wallet signer with real cryptography,
  ADR-036, direct/Amino signing, maximum uint64 wire encoding, ICS23 verification,
  and foreign-chain/corrupted-worker rejection. Worker transport is deterministic.
- The production TypeScript/Rsbuild build and `npm run check:bundle` passed.
  The bundle check confirms the existing MCP exclusions and single core/manifestjs
  installation; build-time guards also reject the two Node parsers.
- Plain `npm run lint`, the production build, and the bundle check passed again
  after the final guard adjustment. The rebuilt entry HTML has the same SHA-256
  as the browser smoke artifact:
  `ac708859a607db3e218287e338c3525637d6008337e64a3e2c966a4df3a9fb28`.
- Chromium 152.0.7977.82 smoke passed at 1440×1000 and 390×844: landing render,
  Google wallet chooser, Escape dismissal, and reopening. No console errors,
  uncaught exceptions, or unhandled rejections occurred. This used isolated storage,
  deterministic local config/readiness fixtures, and blocked external HTTPS.
  The external Google logo was consequently unavailable in that fixture.

Real Google OAuth, a connected-wallet session, and live-chain deployment remain
unverified. The deterministic signing/deployment tests and chooser smoke do not
establish those end-to-end results; complete them with a maintainer's test account
before closing the issue. The before/after snapshots are committed alongside this
report; linking these artifacts to Linear remains outstanding.
