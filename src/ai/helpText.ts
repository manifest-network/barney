export const HELP_TEXT = `## Quick Reference

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
| Tier | CPU | Memory | Disk |
|------|-----|--------|------|
| docker-micro | 0.5 cores | 512 MB | 1 GB |
| docker-small | 1 core | 1,024 MB | 5 GB |
| docker-medium | 2 cores | 2,048 MB | 10 GB |
| docker-large | 4 cores | 4,096 MB | 20 GB |

### Keyboard shortcuts
| Key | Action |
|-----|--------|
| **Enter** | Send message |
| **Shift + Enter** | New line |
| **\\u2191 \\u2193** | Browse input history |
| **/** | Focus chat input |
`;
