import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Distinctive @modelcontextprotocol/sdk output signals that survive minification:
// the package specifier, or two co-occurring SUPPORTED_PROTOCOL_VERSIONS date
// literals (near-zero false-positive). See migration spec §4 risk 5.
export function hasMcpNeedle(text) {
  if (text.includes('@modelcontextprotocol/sdk')) return true;
  return text.includes('2024-10-07') && text.includes('2025-06-18');
}

// Distinct on-disk copy roots of an @manifest-network package in the module list.
// rspack names the SAME physical module several ways — relative ("./node_modules/…"),
// bare-absolute, and loader-prefixed ("javascript/esm|/abs/…"). Canonicalize each to a
// resolved absolute path first, so the 2–3 representations of ONE copy collapse to a
// single root, while a genuinely nested second copy (…/fred/node_modules/…/core) stays
// distinct (its resolved absolute path really is different).
export function copyRoots(names, pkg) {
  const re = new RegExp(`(.*node_modules[\\\\/]@manifest-network[\\\\/]${pkg})`);
  const roots = new Set();
  for (const n of names) {
    const stripped = n.includes('|') ? n.slice(n.lastIndexOf('|') + 1) : n;
    const abs = resolve(stripped);
    const m = abs.match(re);
    if (m) roots.add(m[1]);
  }
  return roots;
}

function main() {
  const errors = [];
  const distJs = join('dist', 'static', 'js');
  if (!existsSync(distJs)) {
    errors.push(`missing ${distJs} — run \`rsbuild build\` first`);
  } else {
    // Recursive: barney emits ~30 async chunks under dist/static/js/async/*.js;
    // a lazily-loaded leak would land there and slip a non-recursive scan.
    // Node floor is 22.19, so readdirSync's { recursive: true } is available.
    for (const f of readdirSync(distJs, { recursive: true }).filter((n) => n.endsWith('.js'))) {
      if (hasMcpNeedle(readFileSync(join(distJs, f), 'utf8'))) {
        errors.push(`@modelcontextprotocol/sdk leaked into dist/static/js/${f}`);
      }
    }
  }
  const modulesFile = join('dist', 'bundle-modules.json');
  if (!existsSync(modulesFile)) {
    errors.push(`missing ${modulesFile} — EmitBundleModulesPlugin did not run`);
  } else {
    const names = JSON.parse(readFileSync(modulesFile, 'utf8'));
    for (const pkg of ['manifest-mcp-core', 'manifestjs']) {
      const roots = copyRoots(names, pkg);
      if (roots.size > 1) {
        errors.push(`${roots.size} copies of @manifest-network/${pkg} bundled:\n  ${[...roots].join('\n  ')}`);
      }
    }
  }
  if (errors.length) {
    console.error('[check:bundle] FAILED:\n- ' + errors.join('\n- '));
    process.exit(1);
  }
  console.log('[check:bundle] OK — no @modelcontextprotocol/sdk in output; single core + single manifestjs copy.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
