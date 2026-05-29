import type { SkuTiersState } from '../stores/aiActions/skuTiers';
import { normalizeErrorPunctuation } from '../utils/errors';

function tiersSection(slice: SkuTiersState): string {
  if (slice.tiers.length === 0) {
    // Phase-distinct copy — pass 14. The old "_Tier catalog loading…_" wording
    // was wrong in two of the four reachable states: `error` (no load in
    // progress, refresh won't help) and `idle` (load hasn't been kicked off
    // yet). Pass 14 splits the wording so /help is honest about what's going
    // on. Mirrors the pass-8 "distinct diagnostics by source" pattern.
    switch (slice.phase) {
      case 'error':
        // Pass-9 cross-coupling: `slice.error` may already end with `.`
        // (e.g. the pass-8 short-circuit string
        // 'PUBLIC_SKU_SPECS is empty or invalid — no SKU specs configured.').
        // Without `normalizeErrorPunctuation` we'd render `..._` here. The
        // helper strips trailing periods so we can append exactly one.
        return `_Tier catalog unavailable: ${normalizeErrorPunctuation(slice.error ?? 'unknown error')}._`;
      case 'loading':
        return '_Tier catalog loading — refresh in a moment._';
      case 'idle':
        return '_Tier catalog not loaded yet._';
      case 'ready':
      default:
        // Defensive — `ready` with zero tiers means env spec map matched
        // nothing on chain (config drift). The resolver also surfaces this
        // via `loadSkuTiersFn`'s empty-intersection error path, but if the
        // slice ever reaches `ready` with [], this is the right copy.
        return '_No tiers configured for this network._';
    }
  }
  const rows = slice.tiers
    .map(
      (t) =>
        `| ${t.skuName} | ${t.cores} cores | ${t.ramMB.toLocaleString()} MB | ${t.diskGB} GB | ${t.pricePerHour.toFixed(4)} ${t.denomSymbol}/hr |`,
    )
    .join('\n');
  return `| Tier | CPU | Memory | Disk | Price |
|------|-----|--------|------|-------|
${rows}`;
}

export function buildHelpText(slice: SkuTiersState): string {
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
${tiersSection(slice)}

### Keyboard shortcuts
| Key | Action |
|-----|--------|
| **Enter** | Send message |
| **Shift + Enter** | New line |
| **\\u2191 \\u2193** | Browse input history |
| **/** | Focus chat input |
`;
}
