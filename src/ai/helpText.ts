import type { ResolvedSkuTier } from '../api/skuTiers';

function tiersSection(tiers: readonly ResolvedSkuTier[]): string {
  if (tiers.length === 0) {
    return '_Tier catalog loading — refresh in a moment._';
  }
  const rows = tiers
    .map(
      (t) =>
        `| ${t.skuName} | ${t.cores} cores | ${t.ramMB.toLocaleString()} MB | ${t.diskGB} GB | ${t.pricePerHour.toFixed(4)} ${t.denomSymbol}/hr |`,
    )
    .join('\n');
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
