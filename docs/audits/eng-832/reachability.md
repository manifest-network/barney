# ENG-832 baseline advisory reachability

This record describes the dependency graph audited on 2026-09-10 at commit `19f321568c461ddb9415b28ef1e59ac068a3c815`. [before.json](before.json) preserves the full and production-only audit results, commands, and baseline lockfile SHA-256. Versions and installed paths below refer to that baseline, including packages subsequently upgraded. The baseline lockfile is available from that commit's `package-lock.json`.

The inventory covers all 52 distinct high or critical advisory URLs in the baseline, including all affected installed nodes reported for their packages. Repeated advisory records for different version ranges are combined under one URL with every snapshot range retained. npm's parent-package findings propagate dependency advisories and do not represent additional distinct advisories. Severity labels preserve the audit snapshot; upstream advisory pages can subsequently change their ratings. Each installed node includes its immediate declared dependency parents and a representative root path; additional active wallet routes are identified for protobufjs.

The runtime image copies built `dist/` and `server/`, without `node_modules`. The import graph from `server/main.mjs` through relay, configuration, authentication, quota ledger, metrics, and validation uses relative modules and Node builtins. Production-only npm audit therefore identifies installed package exposure relevant to the browser dependency graph; it does not by itself demonstrate exposure in the Node relay. Tests that import CosmJS do not change that runtime boundary. `server/dev.mjs` launches Rsbuild. `vitest.config.ts` selects Happy DOM and does not configure Vitest UI, Browser Mode, or an exposed API server.

The observations distinguish inspected source paths from exploitation prerequisites. They do not establish blanket non-reachability or accept residual risk. Patched release boundaries provide baseline review context; final versions, audit results, and dispositions are recorded separately.

## Package entry points and patch boundaries

| Package | Concrete runtime/build/test reachability | Patched release boundary and dependency constraints |
| --- | --- | --- |
| `axios` | Browser network dependency: SDK → manifestjs → LCDClient and Tendermint client; no direct src import. Tendermint http.js prefers native fetch and retains Axios fallback; LCDClient imports Axios. No relay import reaches the Axios Node HTTP adapter. Browser config-merge / response-transform prototype gadgets and cookie-name ReDoS remain applicable to the library if their prerequisites are supplied; no complete proof of non-reachability was attempted. The shared/browser paths therefore require consideration alongside Node adapter findings. | 1.18.0 minimum for the snapshot at all severities. The baseline override also constrains @cosmology/lcd, which pins 1.8.2. |
| `brace-expansion` | ESLint and TypeScript ESLint pattern expansion during lint only; patterns come from checkout/configuration. No browser or relay import was found. Both installed majors have findings. | 1.1.18 / 2.1.4; existing minimatch dependency ranges permit these. |
| `browserslist` | ESLint React Hooks → Babel target selection in lint tooling; auto-discovered custom stats and repeated query-cache inputs are the advisory entry points. No browser or relay import was found. | 4.28.7; existing ^4.24.0 permits it. |
| `defu` | WalletConnect key-value storage → unstorage → h3. The actual keyvaluestorage browser entry imports unstorage core and idb-keyval; unstorage core imports destr/shared helpers, while h3 is imported by the separate unstorage/server entry. No server use in relay. This identifies an installed transitive dependency; emitted-bundle absence requires separate verification. | 6.1.5; h3 uses ^6.1.4. |
| `flatted` | ESLint → file-entry-cache → flat-cache parse path for lint caches. npm run lint does not pass --cache. No browser or relay import was found. Malicious reusable cache would be the relevant input if caching is enabled later. | 3.4.2; flat-cache ^3.2.9 permits it. |
| `form-data` | Axios Node adapter multipart serializer. axios/lib/platform/browser/classes/FormData.js selects browser-native FormData; relay does not import Axios or this package. Node adapter use would expose it in the process invoking that adapter. | 4.0.6; Axios permits ^4.0.4. |
| `h3` | WalletConnect → unstorage server subpath; h3 createEventStream is the vulnerable API. Browser keyvaluestorage imports unstorage core, which does not import the server entry. Relay implements HTTP/SSE using builtins. The installed package includes both SSE and static-file-serving advisory paths. | 1.15.9 covers the snapshot at all severities; 1.15.6 clears the original high SSE advisory only. unstorage ^1.15.5 permits the patched release. |
| `happy-dom` | Direct Vitest environment for src tests. Wrong-origin fetch cookies and unsanitized ESM export compilation affect this Node test process. Tests are checkout-controlled; no Happy DOM at browser/relay runtime. Tests can exercise these APIs independently of production behavior. | 20.8.9 covers both high advisories in this snapshot. |
| `js-cookie` | Web3Auth no-modal → Segment analytics browser cookie storage. Segment CookieStorage.set passes options to js-cookie.set, so the vulnerable API is consumed. Exploitation requires hostile attributes/configuration; the transitive browser call remains relevant despite the absence of a direct Barney import. | 3.0.7; @segment/analytics-next pins 3.0.1, constraining normal transitive updates. |
| `js-yaml` | ESLint eslintrc YAML configuration loader, not uploaded deployment manifests (Barney uses JSON/Zod). Flat ESLint config is JS. Checkout/config files are the potential input; no browser/relay runtime import was found. | 4.3.2; @eslint/eslintrc ^4.1.1 permits it. |
| `lodash` | Browser imports from interchain UI, XRPL and MetaMask utilities. UI imports merge, omit and common utility methods from lodash; no Barney direct template use found. Template-code-injection requires the template API and hostile imports keys/prototype; the method search alone does not establish complete non-reachability. | 4.18.0; all locked parent ranges are compatible ^4.x. |
| `minimatch` | ESLint configuration and TypeScript ESLint file/project matching. Developer checkout/glob patterns are the attack input. No browser/relay import was found. | 3.1.4 / 9.0.7; both installed majors have compatible patched releases. |
| `nanoid` | PostCSS input IDs in build/test tooling. Baseline postcss/lib/input.js calls nanoid/non-secure with literal size 6. The advisory needs invalid size or custom generators, so this inspected call is not the vulnerable input. The installed package remains affected in the baseline. | 3.3.18; PostCSS ^3.3.11 permits it. |
| `picomatch` | v4: Vitest/Vite/tinyglobby test discovery and TypeScript ESLint matching. v2: patch-package workspace matching; production-marked through unstorage/anymatch, whose filesystem watcher use is separate from browser keyvaluestorage core. No app API accepts glob patterns. Both installed majors have compatible patched releases. | 2.3.2 / 4.0.4; declared ranges permit them. |
| `postcss` | Direct CSS build dependency, @tailwindcss/postcss, and Vitest/Vite transforms. CSS sourceMappingURL can reach source-map filesystem loader when processing checkout or dependency CSS. No browser/relay runtime import was found. Build input and source-map handling remain relevant to the advisory. | 8.5.23 minimum for all snapshot advisories; 8.5.18 only clears the high findings. The direct version is pinned exactly. |
| `protobufjs` | Active wallet dependency through the Manifest Stargate fork and Keplr. Inspected ICS23 and Keplr generated codecs import protobufjs/minimal. Schema reflection/code generation and binary-message decoding have different prerequisites; the detailed section below records both. The relay has no protobufjs import. | 7.6.6 is the maintained 7.x release evaluated for the override. All three baseline parents constrain protobufjs to 6.x, so this crosses their declared major range and requires wire-format/signing compatibility validation. |
| `rollup` | Only installed through Vitest → Vite. Barney production build and dev server use Rsbuild/Rspack, not Rollup. Test tooling dependency; malicious output/chunk names would trigger arbitrary write if its writer is invoked. | 4.59.0 minimum; Vite compatible ^4.x can refresh it. |
| `socket.io-parser` | Browser auth communication: Web3Auth auth → Torus secure-pub-sub → socket.io-client → parser. Incoming auth server binary packet framing can reach the decoder; this is client-side package use too, not automatically a server-only finding. The incoming packet decoder is a relevant browser entry point. | 4.2.7; socket.io-client ~4.2.4 permits it. |
| `tmp` | patch-package patch creation tool. makePatch.js calls dirSync({unsafeCleanup:true}) without attacker-controlled prefix/postfix/dir. No browser/relay import was found; the compatible patch release removes the installed finding. | 0.2.6; patch-package ^0.2.4 permits it. |
| `vite` | Only Vitest test transform/dev server dependency. Package dev script launches server/dev.mjs → rsbuild dev. No Vitest UI, Browser Mode, api.host, or Vite server configured in vitest.config.ts. Vulnerable fs-serving requests would need an exposed Vite/Vitest server; the baseline test tooling still contains the affected package. | 7.3.5 on current major clears high and moderate snapshot issues; Vitest also supports newer Vite majors but that is unnecessary for this patch. |
| `vitest` | Direct test runner; the critical attachment file read/execute requires Vitest UI exposure or Windows UI/Browser Mode. Scripts use vitest run or vitest watch; config uses happy-dom with no UI/Browser/api server configured. No production use. @vitest/mocker adds a separate moderate public-plugin redirect issue. | 4.1.11 plus matching @vitest/coverage-v8 and @vitest/mocker; 4.1.0 clears critical only. |
| `ws` | Node WebSocket implementations in wallet stacks and Happy DOM tests. CosmJS imports isomorphic-ws whose browser.js selects native WebSocket; browser packages generally use browser mappings. Emitted-bundle inspection is needed to establish whether every nested ws implementation is absent. Relay uses HTTP/fetch builtins and no ws server. Both installed majors have patched releases. | 7.5.11 / 8.21.0; ethers pins 8.17.1, viem pins 8.18.3, engine.io-client uses ~8.18.3, so compatible upstream refresh or scoped overrides are needed. |

All-severity boundaries supplement the high/critical inventory below: [Axios 1.18.0](https://github.com/advisories/GHSA-mmx7-hfxf-jppx), [Vitest/mocker 4.1.11](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), [PostCSS 8.5.23](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), and [h3 1.15.9](https://github.com/advisories/GHSA-4hxc-9384-m385). [protobufjs 7.6.6](https://github.com/protobufjs/protobuf.js/releases/tag/protobufjs-v7.6.6) backports subsequent 8.x fixes to the maintained 7.x line.

## Every high/critical advisory and installed path

### axios

- [GHSA-pmwg-cvhr-8vh7](https://github.com/advisories/GHSA-pmwg-cvhr-8vh7) — high: Axios: Incomplete Fix for CVE-2025-62718 — NO_PROXY Protection Bypassed via RFC 1122 Loopback Subnet (127.0.0.0/8) in Axios 1.15.0 (snapshot range `>=1.0.0 <1.15.1`).
- [GHSA-pf86-5x62-jrwf](https://github.com/advisories/GHSA-pf86-5x62-jrwf) — high: Axios: Prototype Pollution Gadgets - Response Tampering, Data Exfiltration, and Request Hijacking (snapshot range `>=1.0.0 <1.15.1`).
- [GHSA-6chq-wfr3-2hj9](https://github.com/advisories/GHSA-6chq-wfr3-2hj9) — high: Axios: Header Injection via Prototype Pollution (snapshot range `>=1.0.0 <1.15.1`).
- [GHSA-43fc-jf86-j433](https://github.com/advisories/GHSA-43fc-jf86-j433) — high: Axios is Vulnerable to Denial of Service via __proto__ Key in mergeConfig (snapshot range `>=1.0.0 <=1.13.4`).
- [GHSA-q8qp-cvcw-x6jj](https://github.com/advisories/GHSA-q8qp-cvcw-x6jj) — high: Axios has prototype pollution read-side gadgets in HTTP adapter that allow credential injection and request hijacking (snapshot range `>=1.0.0 <1.15.2`).
- [GHSA-hfxv-24rg-xrqf](https://github.com/advisories/GHSA-hfxv-24rg-xrqf) — high: Axios: Regular Expression Denial of Service (ReDoS) via Cookie Name Injection (snapshot range `>=1.0.0 <1.16.0`).
- [GHSA-777c-7fjr-54vf](https://github.com/advisories/GHSA-777c-7fjr-54vf) — high: Allocation of Resources Without Limits or Throttling in Axios (snapshot range `>=1.7.0 <1.16.0`).
- [GHSA-p92q-9vqr-4j8v](https://github.com/advisories/GHSA-p92q-9vqr-4j8v) — high: Axios: Proxy-Authorization Credential Leak to Origin Server Across HTTP-to-HTTPS Redirect in Axios Node.js HTTP Adapter (snapshot range `>=1.0.0 <1.16.0`).
- [GHSA-j5f8-grm9-p9fc](https://github.com/advisories/GHSA-j5f8-grm9-p9fc) — high: Axios: Proxy-Authorization header leaks to redirect target when proxy is re-evaluated to direct connection (snapshot range `>=1.0.0 <1.16.0`).
- [GHSA-3g43-6gmg-66jw](https://github.com/advisories/GHSA-3g43-6gmg-66jw) — high: axios Vulnerable to Credential Theft and Response Hijacking via Prototype Pollution Gadget in Config Merge (snapshot range `>=1.0.0 <1.15.2`).
- [GHSA-35jp-ww65-95wh](https://github.com/advisories/GHSA-35jp-ww65-95wh) — high: axios Vulnerable to Full Man-in-the-Middle via Prototype Pollution Gadget in `config.proxy` (snapshot range `>=1.0.0 <1.16.0`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/axios` = `1.13.2`; parents: `barney`, `@cosmjs/tendermint-rpc@0.32.4`, `@cosmology/lcd@0.14.5`.
  Path: `barney → axios@1.13.2`.

### brace-expansion

- [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) — high: brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups (snapshot ranges `>=2.0.0 <2.1.2`, `<1.1.16`).
- [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) — high: brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash (snapshot ranges `<1.1.17`, `>=2.0.0 <2.1.3`).
- [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) — high: brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation (snapshot ranges `>=2.0.0 <2.1.4`, `<1.1.18`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion` = `2.0.2`; parents: `minimatch@9.0.5`.
  Path: `barney → typescript-eslint@8.53.1 → @typescript-eslint/typescript-estree@8.53.1 → minimatch@9.0.5 → brace-expansion@2.0.2`.
- `node_modules/brace-expansion` = `1.1.12`; parents: `minimatch@3.1.2`.
  Path: `barney → eslint@9.39.2 → minimatch@3.1.2 → brace-expansion@1.1.12`.

### browserslist

- [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) — high: Browserslist: Unbounded memory growth (no cache eviction) via distinct query results, leading to eventual OOM (snapshot range `<=4.28.6`).
- [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) — high: Browserslist: Uncaught crash / prototype write via untrusted browserslist-stats.json custom stats (normalizeStats) (snapshot range `<=4.28.6`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/browserslist` = `4.28.1`; parents: `@babel/helper-compilation-targets@7.28.6`.
  Path: `barney → eslint-plugin-react-hooks@7.0.1 → @babel/core@7.29.0 → @babel/helper-compilation-targets@7.28.6 → browserslist@4.28.1`.

### defu

- [GHSA-737v-mqg7-c878](https://github.com/advisories/GHSA-737v-mqg7-c878) — high: defu: Prototype pollution via `__proto__` key in defaults argument (snapshot range `<=6.1.4`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/defu` = `6.1.4`; parents: `h3@1.15.5`.
  Path: `barney → @cosmos-kit/react@2.22.3 → @cosmos-kit/core@2.18.1 → @walletconnect/types@2.11.0 → @walletconnect/keyvaluestorage@1.1.1 → unstorage@1.17.4 → h3@1.15.5 → defu@6.1.4`.

### flatted

- [GHSA-25h7-pfq9-p65f](https://github.com/advisories/GHSA-25h7-pfq9-p65f) — high: flatted vulnerable to unbounded recursion DoS in parse() revive phase (snapshot range `<3.4.0`).
- [GHSA-rf6f-7fwh-wjgh](https://github.com/advisories/GHSA-rf6f-7fwh-wjgh) — high: Prototype Pollution via parse() in NodeJS flatted (snapshot range `<=3.4.1`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/flatted` = `3.3.3`; parents: `flat-cache@4.0.1`.
  Path: `barney → eslint@9.39.2 → file-entry-cache@8.0.0 → flat-cache@4.0.1 → flatted@3.3.3`.

### form-data

- [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx) — high: form-data: CRLF injection in form-data via unescaped multipart field names and filenames (snapshot range `>=4.0.0 <4.0.6`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/form-data` = `4.0.5`; parents: `axios@1.13.2`.
  Path: `barney → axios@1.13.2 → form-data@4.0.5`.

### h3

- [GHSA-22cc-p3c6-wpvm](https://github.com/advisories/GHSA-22cc-p3c6-wpvm) — high: h3 has a Server-Sent Events Injection via Unsanitized Newlines in Event Stream Fields (snapshot range `<1.15.6`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/h3` = `1.15.5`; parents: `unstorage@1.17.4`.
  Path: `barney → @cosmos-kit/react@2.22.3 → @cosmos-kit/core@2.18.1 → @walletconnect/types@2.11.0 → @walletconnect/keyvaluestorage@1.1.1 → unstorage@1.17.4 → h3@1.15.5`.

### happy-dom

- [GHSA-w4gp-fjgq-3q4g](https://github.com/advisories/GHSA-w4gp-fjgq-3q4g) — high: Happy DOM's fetch credentials include uses page-origin cookies instead of target-origin cookies (snapshot range `<20.8.9`).
- [GHSA-6q6h-j7hj-3r64](https://github.com/advisories/GHSA-6q6h-j7hj-3r64) — high: Happy DOM ECMAScriptModuleCompiler: unsanitized export names are interpolated as executable code (snapshot range `>=15.10.0 <=20.8.7`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/happy-dom` = `20.5.0`; parents: `barney`.
  Path: `barney → happy-dom@20.5.0`.

### js-cookie

- [GHSA-qjx8-664m-686j](https://github.com/advisories/GHSA-qjx8-664m-686j) — high: JavaScript Cookie: Per-instance prototype hijack in assign() enables cookie-attribute injection (snapshot range `<=3.0.5`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/js-cookie` = `3.0.1`; parents: `@segment/analytics-next@1.81.1`.
  Path: `barney → @cosmos-kit/web3auth@2.16.6-ll.1 → @web3auth/modal@10.14.0 → @web3auth/no-modal@10.14.0 → @segment/analytics-next@1.81.1 → js-cookie@3.0.1`.

### js-yaml

- [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) — high: js-yaml: YAML merge-key chains can force quadratic CPU consumption (snapshot range `>=4.0.0 <4.3.0`).
- [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) — high: JS-YAML: Quadratic CPU consumption in !!omap resolution (3.x and 4.x) — CVE-2026-59870 fix not backported (snapshot range `>=4.0.0 <4.3.1`).
- [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) — high: js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources (snapshot range `>=4.0.0 <4.3.2`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/js-yaml` = `4.1.1`; parents: `@eslint/eslintrc@3.3.3`.
  Path: `barney → eslint@9.39.2 → @eslint/eslintrc@3.3.3 → js-yaml@4.1.1`.

### lodash

- [GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc) — high: lodash vulnerable to Code Injection via `_.template` imports key names (snapshot range `>=4.0.0 <=4.17.23`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/lodash` = `4.17.23`; parents: `@interchain-ui/react@1.26.2`, `@metamask/utils@11.9.0`, `xrpl@2.14.3`.
  Path: `barney → @interchain-ui/react@1.26.2 → lodash@4.17.23`.

### minimatch

- [GHSA-3ppc-4f35-3m26](https://github.com/advisories/GHSA-3ppc-4f35-3m26) — high: minimatch has a ReDoS via repeated wildcards with non-matching literal in pattern (snapshot ranges `<3.1.3`, `>=9.0.0 <9.0.6`).
- [GHSA-7r86-cg39-jmmj](https://github.com/advisories/GHSA-7r86-cg39-jmmj) — high: minimatch has ReDoS: matchOne() combinatorial backtracking via multiple non-adjacent GLOBSTAR segments (snapshot ranges `<3.1.3`, `>=9.0.0 <9.0.7`).
- [GHSA-23c5-xmqv-rm74](https://github.com/advisories/GHSA-23c5-xmqv-rm74) — high: minimatch ReDoS: nested *() extglobs generate catastrophically backtracking regular expressions (snapshot ranges `<3.1.4`, `>=9.0.0 <9.0.7`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch` = `9.0.5`; parents: `@typescript-eslint/typescript-estree@8.53.1`.
  Path: `barney → typescript-eslint@8.53.1 → @typescript-eslint/typescript-estree@8.53.1 → minimatch@9.0.5`.
- `node_modules/minimatch` = `3.1.2`; parents: `@eslint/config-array@0.21.1`, `@eslint/eslintrc@3.3.3`, `eslint@9.39.2`.
  Path: `barney → eslint@9.39.2 → minimatch@3.1.2`.

### nanoid

- [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) — high: nanoid: non-secure generators can loop indefinitely with negative size (snapshot range `<3.3.16`).
- [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) — high: nanoid: custom generators can loop indefinitely when size is zero (snapshot range `<3.3.18`).
- [GHSA-xwg4-73v4-xw9w](https://github.com/advisories/GHSA-xwg4-73v4-xw9w) — high: nanoid: Integer Overflow or Wraparound (snapshot range `<3.3.12`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/nanoid` = `3.3.11`; parents: `postcss@8.5.6`.
  Path: `barney → postcss@8.5.6 → nanoid@3.3.11`.

### picomatch

- [GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj) — high: Picomatch has a ReDoS vulnerability via extglob quantifiers (snapshot ranges `<2.3.2`, `>=4.0.0 <4.0.4`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/picomatch` = `2.3.1`; parents: `anymatch@3.1.3`, `micromatch@4.0.8`.
  Path: `barney → patch-package@8.0.1 → find-yarn-workspace-root@2.0.0 → micromatch@4.0.8 → picomatch@2.3.1`.
- `node_modules/tinyglobby/node_modules/picomatch` = `4.0.3`; parents: `tinyglobby@0.2.15`.
  Path: `barney → vitest@4.0.18 → tinyglobby@0.2.15 → picomatch@4.0.3`.
- `node_modules/vite/node_modules/picomatch` = `4.0.3`; parents: `vite@7.3.1`.
  Path: `barney → vitest@4.0.18 → vite@7.3.1 → picomatch@4.0.3`.
- `node_modules/vitest/node_modules/picomatch` = `4.0.3`; parents: `vitest@4.0.18`.
  Path: `barney → vitest@4.0.18 → picomatch@4.0.3`.

### postcss

- [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) — high: PostCSS: Arbitrary file read and information disclosure via attacker-controlled sourceMappingURL in CSS comments (snapshot range `<=8.5.11`).
- [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) — high: PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure (snapshot range `<=8.5.17`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/postcss` = `8.5.6`; parents: `barney`, `@tailwindcss/postcss@4.1.18`, `vite@7.3.1`.
  Path: `barney → postcss@8.5.6`.

### protobufjs

- [GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg) — critical: Arbitrary code execution in protobufjs (snapshot range `<7.5.5`).
- [GHSA-66ff-xgx4-vchm](https://github.com/advisories/GHSA-66ff-xgx4-vchm) — high: protobuf.js: Code injection through bytes field defaults in generated toObject code (snapshot range `<=7.5.5`).
- [GHSA-75px-5xx7-5xc7](https://github.com/advisories/GHSA-75px-5xx7-5xc7) — high: protobuf.js: Code generation gadget after prototype pollution (snapshot range `<=7.5.5`).
- [GHSA-jvwf-75h9-cwgg](https://github.com/advisories/GHSA-jvwf-75h9-cwgg) — high: protobuf.js: Process-wide denial of service through unsafe option paths (snapshot range `<=7.5.5`).
- [GHSA-685m-2w69-288q](https://github.com/advisories/GHSA-685m-2w69-288q) — high: protobuf.js: Denial of service through unbounded protobuf recursion (snapshot range `<=7.5.5`).
- [GHSA-wcpc-wj8m-hjx6](https://github.com/advisories/GHSA-wcpc-wj8m-hjx6) — high: protobufjs: Denial of service through unbounded Any expansion during JSON conversion (snapshot range `<=7.6.0`).

Installed node (exact baseline version) and immediate declared dependency parents:

- `node_modules/protobufjs` = `6.11.4`; parents: `@confio/ics23@0.6.8` (`^6.8.8`), `@keplr-wallet/cosmos@0.12.28` (`^6.11.2`), and `@keplr-wallet/proto-types@0.12.28` (`^6.11.2`).

Baseline paths to that shared installation:

- `barney → @cosmjs/stargate@0.32.4-ll.3 → @confio/ics23@0.6.8 → protobufjs@6.11.4`. The Stargate name is an npm alias for `@manifest-network/stargate`.
- `barney → @cosmos-kit/react@2.22.3 → @cosmos-kit/core@2.18.1 → @chain-registry/keplr@1.74.479 → @keplr-wallet/cosmos@0.12.28 → protobufjs@6.11.4`.
- `barney → @cosmos-kit/web3auth@2.16.6-ll.1 → @keplr-wallet/cosmos@0.12.28 → protobufjs@6.11.4`. Here Keplr is a declared peer and a runtime import of the active Web3Auth connector.
- `barney → @cosmos-kit/web3auth@2.16.6-ll.1 → @keplr-wallet/cosmos@0.12.28 → @keplr-wallet/proto-types@0.12.28 → protobufjs@6.11.4`.

The active entry in `src/main.tsx` registers the Web3Auth fork. Its `esm/extension/client.js` imports `makeADR36AminoSignDoc` from the Keplr Cosmos barrel. The worker uses CosmJS Amino/direct wallets, and `src/hooks/useManifestMCP.ts` supplies this signer to the Manifest SDK. `@confio/ics23/build/generated/codecimpl.js` and `@keplr-wallet/proto-types/cosmos/tx/v1beta1/tx.js` use `protobufjs/minimal` with pregenerated message codecs. Their `decode`, `fromJSON`, and `toJSON`/`toObject` functions process message values under fixed schemas.

The critical snapshot finding GHSA-xq3m-2v4x-88gg requires attacker-controlled schema metadata reaching reflection and runtime code generation. The inspected imports use the minimal reader/writer runtime, which does not expose those reflection APIs, and no Barney product import loads protobuf schemas or JSON descriptors. The related findings concern hostile defaults used by generated `toObject` code, code-generation gadgets after prototype pollution, and unsafe schema-option processing. This is evidence about the inspected import paths, without a claim that every transitive caller has been excluded. [Upstream schema/code-generation prerequisites](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-xq3m-2v4x-88gg).

Binary decoding has a separate input boundary: GHSA-685m-2w69-288q includes unknown-group skipping and nested message decoding, so a minimal-runtime import alone does not exclude it. The fork's `QueryClient.queryStoreVerified` decodes ICS23 proof bytes from RPC responses; no invocation was found in Barney product code or the inspected Manifest SDK packages. Keplr's generated transaction codecs also contain binary decoders. GHSA-wcpc-wj8m-hjx6 concerns recursive message-to-JSON conversion, including protobufjs's custom Any expansion; generated message-value conversion must be distinguished from loading a schema descriptor. [Binary recursion prerequisites](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-685m-2w69-288q), [Any conversion prerequisites](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-wcpc-wj8m-hjx6).

The runtime upgrade does not regenerate codec source shipped by those consumers. The dependency compatibility tests exercise fixed wire bytes at the maximum uint64, ICS23 proof verification, and real Amino/direct signing. These checks establish compatibility for the covered interfaces; they do not prove that every generated decoder or JSON conversion is bounded.

### rollup

- [GHSA-mw96-cpmx-2vgc](https://github.com/advisories/GHSA-mw96-cpmx-2vgc) — high: Rollup 4 has Arbitrary File Write via Path Traversal (snapshot range `>=4.0.0 <4.59.0`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/rollup` = `4.57.1`; parents: `vite@7.3.1`.
  Path: `barney → vitest@4.0.18 → vite@7.3.1 → rollup@4.57.1`.

### socket.io-parser

- [GHSA-677m-j7p3-52f9](https://github.com/advisories/GHSA-677m-j7p3-52f9) — high: socket.io allows an unbounded number of binary attachments (snapshot range `>=4.0.0 <4.2.6`).
- [GHSA-2m8v-j782-fhvr](https://github.com/advisories/GHSA-2m8v-j782-fhvr) — high: Socket.IO: Zero-attachment Memory Exhaustion (snapshot range `>=4.0.0 <4.2.7`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/socket.io-parser` = `4.2.5`; parents: `socket.io-client@4.8.3`.
  Path: `barney → @cosmos-kit/web3auth@2.16.6-ll.1 → @web3auth/auth@10.8.0 → @toruslabs/secure-pub-sub@3.0.2 → socket.io-client@4.8.3 → socket.io-parser@4.2.5`.

### tmp

- [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65) — high: tmp has Path Traversal via unsanitized prefix/postfix that enables directory escape (snapshot range `<0.2.6`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/tmp` = `0.2.5`; parents: `patch-package@8.0.1`.
  Path: `barney → patch-package@8.0.1 → tmp@0.2.5`.

### vite

- [GHSA-v2wj-q39q-566r](https://github.com/advisories/GHSA-v2wj-q39q-566r) — high: Vite: `server.fs.deny` bypassed with queries (snapshot range `>=7.1.0 <=7.3.1`).
- [GHSA-p9ff-h696-f583](https://github.com/advisories/GHSA-p9ff-h696-f583) — high: Vite Vulnerable to Arbitrary File Read via Vite Dev Server WebSocket (snapshot range `>=7.0.0 <=7.3.1`).
- [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) — high: vite: `server.fs.deny` bypass on Windows alternate paths (snapshot range `>=7.0.0 <=7.3.4`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/vite` = `7.3.1`; parents: `vitest@4.0.18`.
  Path: `barney → vitest@4.0.18 → vite@7.3.1`.

### vitest

- [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) — critical: When Vitest UI server is listening, arbitrary file can be read and executed (snapshot range `>=4.0.0 <4.1.0`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/vitest` = `4.0.18`; parents: `barney`.
  Path: `barney → vitest@4.0.18`.

### ws

- [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) — high: ws: Memory exhaustion DoS from tiny fragments and data chunks (snapshot ranges `>=8.0.0 <8.21.0`, `>=7.0.0 <7.5.11`).

Installed nodes (exact baseline versions), immediate declared parents and one shortest root path per node:

- `node_modules/@xrplf/isomorphic/node_modules/ws` = `8.19.0`; parents: `@xrplf/isomorphic@1.0.1`.
  Path: `barney → @cosmos-kit/web3auth@2.16.6-ll.1 → @web3auth/modal@10.14.0 → @web3auth/no-modal@10.14.0 → xrpl@2.14.3 → xrpl-secret-numbers@0.3.5 → ripple-keypairs@2.0.0 → @xrplf/isomorphic@1.0.1 → ws@8.19.0`.
- `node_modules/engine.io-client/node_modules/ws` = `8.18.3`; parents: `engine.io-client@6.6.4`.
  Path: `barney → @cosmos-kit/web3auth@2.16.6-ll.1 → @web3auth/auth@10.8.0 → @toruslabs/secure-pub-sub@3.0.2 → socket.io-client@4.8.3 → engine.io-client@6.6.4 → ws@8.18.3`.
- `node_modules/ethers/node_modules/ws` = `8.17.1`; parents: `ethers@6.16.0`.
  Path: `barney → @cosmos-kit/web3auth@2.16.6-ll.1 → @web3auth/modal@10.14.0 → @web3auth/no-modal@10.14.0 → ethers@6.16.0 → ws@8.17.1`.
- `node_modules/happy-dom/node_modules/ws` = `8.19.0`; parents: `happy-dom@20.5.0`.
  Path: `barney → happy-dom@20.5.0 → ws@8.19.0`.
- `node_modules/rpc-websockets/node_modules/ws` = `8.19.0`; parents: `rpc-websockets@9.3.3`.
  Path: `barney → @cosmos-kit/web3auth@2.16.6-ll.1 → @web3auth/modal@10.14.0 → @web3auth/no-modal@10.14.0 → @solana/web3.js@1.98.4 → rpc-websockets@9.3.3 → ws@8.19.0`.
- `node_modules/viem/node_modules/ws` = `8.18.3`; parents: `viem@2.45.1`.
  Path: `barney → @cosmos-kit/web3auth@2.16.6-ll.1 → viem@2.45.1 → ws@8.18.3`.
- `node_modules/ws` = `7.5.10`; parents: `@cosmjs/socket@0.36.2`, `@cosmjs/socket@0.32.4`, `@walletconnect/jsonrpc-ws-connection@1.0.16`, `jayson@4.3.0`.
  Path: `barney → @cosmjs/stargate@0.32.4-ll.3 → @cosmjs/tendermint-rpc@0.32.4 → @cosmjs/socket@0.32.4 → ws@7.5.10`.
- `node_modules/xrpl/node_modules/ws` = `8.19.0`; parents: `xrpl@2.14.3`.
  Path: `barney → @cosmos-kit/web3auth@2.16.6-ll.1 → @web3auth/modal@10.14.0 → @web3auth/no-modal@10.14.0 → xrpl@2.14.3 → ws@8.19.0`.

## Axios high advisories: adapter distinction

- Browser or shared configuration paths: GHSA-pf86-5x62-jrwf includes a shared response transformation gadget and a Node transport gadget. GHSA-43fc-jf86-j433 affects config merge; GHSA-3g43-6gmg-66jw affects inherited transformResponse during config processing; both require hostile configuration or pre-existing prototype pollution. GHSA-hfxv-24rg-xrqf is browser cookie-name regex work and needs control over the XSRF cookie name. GHSA-777c-7fjr-54vf concerns the fetch adapter ignoring configured finite limits.
- Node HTTP adapter paths: GHSA-pmwg-cvhr-8vh7 (NO_PROXY), GHSA-6chq-wfr3-2hj9 (FormData/header gadget), GHSA-q8qp-cvcw-x6jj (adapter inherited config), GHSA-p92q-9vqr-4j8v and GHSA-j5f8-grm9-p9fc (proxy credentials over redirects), and GHSA-35jp-ww65-95wh (proxy gadget). The builtin-only Node relay has no import path to these adapter APIs; browser Axios uses its browser adapter mapping.
- No direct Axios configuration, unsafe helper imports or xsrfCookieName setting found in src/server. This source search does not establish complete non-reachability across the wallet/SDK transitive call graph.
