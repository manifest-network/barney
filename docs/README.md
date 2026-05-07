# Barney documentation

This directory holds long-form documentation. The top-level [README.md](../README.md), [ARCHITECTURE.md](../ARCHITECTURE.md), and [CLAUDE.md](../CLAUDE.md) cover the project overview, system architecture, and codebase reference respectively.

## For users

- **[Getting started](user/getting-started.md)** — sign in, first deploy, what to expect
- **[AI cookbook](user/ai-cookbook.md)** — example prompts and what each tool does
- **[Manifest format](user/manifest-format.md)** — single-service and stack manifest reference
- **[Troubleshooting](user/troubleshooting.md)** — common problems and how to resolve them

## For developers

- **[Primer](dev/primer.md)** — Cosmos SDK, Manifest Network, leases, providers
- **[Adding a tool](dev/adding-a-tool.md)** — end-to-end walkthrough for new AI tools
- **[Adding an example app](dev/adding-an-example-app.md)** — one-click deploys in `EXAMPLE_APPS`
- **[Testing](dev/testing.md)** — Vitest, mock patterns, coverage
- **[Deployment](dev/deployment.md)** — Docker image, nginx proxy, env vars, prod operations
- **[Security](dev/security.md)** — threat model, SSRF, CSP, secret handling

## For maintainers

- **[CONTRIBUTING.md](../CONTRIBUTING.md)** — branching, commits, releases
