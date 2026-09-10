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
| Full | 0 | 0 | 3 | 42 | 45 |
| `--omit=dev` | 0 | 0 | 3 | 38 | 41 |

The remaining records derive from two advisory URLs across two packages:
stream-json (one moderate) and elliptic (one low). Normal peer resolution adds
affected wallet parent-package records. No high or critical advisory remains,
and the final lockfile contains neither Metro nor image-size.

The runtime image copies the built SPA and `server/`, without `node_modules`.
The Node relay imports local files and Node builtins only. [reachability.md](reachability.md)
records browser and build/test reachability for the original lockfile. The newly
installed peer graph is reviewed below; it was absent from that baseline.

## Dependency decisions

- Vitest and coverage move together to 4.1.11; Vite stays explicitly on the patched
  7.3.6 line. Happy DOM moves to 20.14.3.
- Rsbuild moves to 1.7.6 and its React/Node-polyfill plugins to 1.4.6. PostCSS moves
  to 8.5.28. Development and preview bind to `127.0.0.1` by default; an explicit
  `BARNEY_DEV_HOST` supports remote workspaces and devcontainers.
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
  signatures are covered by `dependencyCompatibility.test.ts`. Tests resolve
  dependencies from the installed consumers so a different hoisted copy cannot
  stand in for the application path.
- UUID 11.1.1 retains CommonJS support. Existing consumers use v1, v4, parse, or validate;
  moving to a newer ESM-only major would change their import contract.
- WebSocket overrides retain each consumer's major: 7.5.13 and 8.21.3.
- Explicit root optional peers select Async Storage 1.24.0, ox 0.11.3, and
  utf-8-validate 5.0.10. npm can then nest Web3Auth's required Async Storage 2.x,
  WalletConnect's ox 0.9.x, and rpc-websockets' utf-8-validate 6.x under their
  respective consumers. These are real packages satisfying declared ranges.
- Async Storage's React Native peer is scoped to `react-native-web@0.21.2`, with
  the same alias declared as a root optional dependency. This selects a real
  browser implementation and avoids installing the native React Native/Metro
  toolchain. Its React and ReactDOM peer ranges include the pinned React 19.
- npm ignores the old Yarn `resolutions` block, so it is removed. Supported
  Manifest SDK/CosmJS forks remain pinned; there is no blanket CosmJS migration.

## Newly resolved peers and browser reachability

Both the root Async Storage 1.24.0 and Web3Auth's required Async Storage 2.2.0
declare a required React Native peer. Removing the root pin alone does not remove
that edge. The scoped override follows React Native Web's documented
[browser alias pattern](https://necolas.github.io/react-native-web/docs/setup/).
Async Storage's default web implementation uses `window.localStorage` without
importing React Native; the browser storage regression exercises the installed
Web3Auth consumer's entry directly. A root alias makes the intended peer choice
explicit and allows normal npm resolution to replace the old native peer cycle.

This is a browser platform choice. React Native Web does not implement Async
Storage's native bridge; remove/reassess this override before adding a native
application target. The Node relay uses neither implementation. Replacing the
native tree removed 128 installed packages and added eight browser helpers, and
reduced lock entries from 1,363 in the initial remediation to 1,243. The image-size
source patch, its parser tests, and its advisory disposition are no longer needed.
`--omit=peer` would only omit files from disk while retaining the locked peer graph;
it would not resolve the locked-graph findings.

Other peers introduced by normal resolution belong to different execution paths:

| Peer group | Path and concrete usage |
| --- | --- |
| bitcoinjs-lib 6.1.8 / ecpair 2.1.0 | Web3Auth client → Keplr cosmos/common 0.13.41 → Keplr crypto 0.13.41. The crypto key module imports Bitcoin helpers and initializes ECC immediately. This is browser wallet code. |
| Starknet 8.9.2 and its ABI/CLI helpers | Keplr crypto requires Starknet conditionally when calculating a Starknet address; Keplr types also references its types. A conditional call does not prove absence from the browser bundle. |
| Terser 5.51.2 and source-map helpers | Vite's optional minifier peer, in build/test tooling. |

Solana, ox, and utf-8-validate already existed in the baseline. None of the wallet
peer groups above should be classified as native-only merely because Barney does
not import those package names directly.

## Scoped residual dispositions

These decisions apply only to the named advisory, version, and usage below.
They do not accept future advisories or other call paths. Review expires
**2026-10-10**; the owner must remove the dependency, land an upstream fix, or
renew the decision with fresh evidence. Raw npm audit results remain visible.
The dated review is tracked by [ENG-929](https://linear.app/liftedinit/issue/ENG-929),
assigned to Felix Morency and due **2026-10-09**. [ENG-837](https://linear.app/liftedinit/issue/ENG-837)
owns the required dependency audit gate and enforcement of exception expiry.

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

- A clean `npm ci --no-audit --no-fund` completed on the final lockfile with
  lifecycle scripts enabled and the required Web3Auth patch applied. The installed
  graph passed `npm ls --all`; notification/audit flags do not bypass peer resolution.
- `npm run test:coverage -- --maxWorkers=4`: **2,625 tests in 112 files passed**.
  Coverage: statements 82.55%, branches 78.02%, functions 78.75%, lines 84.86%.
- Existing deployment, consent, authentication, and relay tests passed. New
  compatibility tests exercise the installed wallet signer with real cryptography,
  ADR-036, direct/Amino signing, maximum uint64 wire encoding, ICS23 verification,
  and foreign-chain/corrupted-worker rejection. Worker transport is deterministic.
  The installed Async Storage browser entry exercises real localStorage operations;
  a malformed Web3Auth patch fixture verifies postinstall fails outside CI.
- The production TypeScript/Rsbuild build and `npm run check:bundle` passed.
  The bundle check confirms the existing MCP exclusions and single core/manifestjs
  installation; build-time guards also reject stream-json.
- Plain `npm run lint`, the production build, and the bundle check passed again
  on the final browser peer graph. The rebuilt entry HTML has the same SHA-256
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
