# ENG-832 dependency cleanup

Issue: [ENG-832](https://linear.app/liftedinit/issue/ENG-832)

## Objective

Make the locked dependency graph install without peer-conflict bypasses, fix
dependency advisories where compatible updates exist, and document any remaining
advisory with its exact dependency path, reachability, owner, mitigation, and expiry.

## Implementation plan

- [x] Capture full and production-only audits of the original lockfile.
- [x] Trace high/critical findings through browser, build/test, and relay usage.
- [x] Upgrade affected direct dependencies and compatible transitive versions;
      preserve Manifest SDK and wallet-signing compatibility.
- [x] Repair React/tooling peer ranges and prove a clean normal installation and
      `npm ls` before removing `--legacy-peer-deps` from CI, Docker, and docs.
- [x] Explicitly bind development and preview servers to loopback by default.
- [x] Record before/after audit summaries and residual advisory dispositions.
- [x] Run lint, tests with coverage, production build, browser bundle checks,
      and available wallet-signing/deployment verification.
- [ ] Verify real OAuth and a testnet deployment with a maintainer's test account.
- [ ] Link the reviewed before/after audit evidence to Linear.

## Validation boundaries

Automated checks must not use a production wallet or paid inference. Record the
exact verification performed, including any live-wallet checks that remain for
the maintainer. Do not infer runtime exploitability from npm's aggregate severity
or treat `--omit=dev` as proof that a dependency is in the emitted browser bundle.

## Progress

- Baseline: `19f321568c461ddb9415b28ef1e59ac068a3c815`.
- Work branch: `chore/eng-832-dependency-cleanup`.
- System runtime: Node 24.15.0, npm 11.12.1; verification used the repository's
  Node 22.19.0 CI pin with npm 10.9.3.
- Full suite: 2,629 tests passed in 112 files. Production build, bundle checks,
  lint, and desktop/mobile wallet-chooser smoke passed. Final guard regression,
  lint, build, and bundle rechecks passed.
- Dependency findings and temporary dispositions: [audit report](../audits/eng-832/README.md).
