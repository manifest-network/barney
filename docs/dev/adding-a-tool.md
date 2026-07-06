# Adding an AI tool

This guide walks through adding a new AI tool end-to-end. The pattern is uniform whether the tool is a read-only query or a transaction that requires confirmation.

We'll use a hypothetical `pause_app` tool as the running example — a tool that pauses a running app without closing the lease.

## Tool taxonomy

| Type | Confirmation required? | Where it lives |
|------|------------------------|----------------|
| Query | No | `src/ai/toolExecutor/compositeQueries.ts` |
| Transaction | Yes (two-phase) | `src/ai/toolExecutor/compositeTransactions.ts` |
| Escape hatch | Special-cased | `src/ai/toolExecutor/index.ts` (don't add here) |

Transactions follow a two-phase pattern:

1. `executeXxx` — validate args, build the manifest/payload, return `{ requiresConfirmation: true, pendingAction, … }`.
2. `executeConfirmedXxx` — broadcast the transaction, wait for provider state, return final result.

Pick the type that matches what your tool does. The rest of this guide assumes a transaction (the harder case); query tools follow the same pattern with the confirmation step omitted.

## 1. Declare the tool to the model

Open `src/ai/tools.ts` and add an entry in `AI_TOOLS`. The schema is OpenAI-compatible:

```ts
{
  type: 'function',
  function: {
    name: 'pause_app',
    description: 'Pause a running app without closing its lease.',
    parameters: {
      type: 'object',
      properties: {
        app_name: {
          type: 'string',
          description: 'The app name to pause, comma-separated names, or "all".',
        },
      },
      required: ['app_name'],
    },
  },
},
```

For a transaction, also add the tool name to `CONFIRMATION_TOOLS`:

```ts
export const CONFIRMATION_TOOLS = new Set([
  'deploy_app',
  'stop_app',
  'fund_credits',
  'restart_app',
  'update_app',
  'set_custom_domain',
  'cosmos_tx',
  'pause_app',          // ← new
]);
```

Then add a human-readable label in `getToolCallDescription`:

```ts
case 'pause_app': {
  const name = String(args.app_name ?? '').trim();
  if (name.toLowerCase() === 'all') return 'Pausing all apps...';
  if (name.includes(',')) return `Pausing apps ${name}...`;
  return `Pausing app "${name}"...`;
}
```

This label appears in the streaming UI while the tool runs.

## 2. Implement the executor

For a transaction, implement two functions in `src/ai/toolExecutor/compositeTransactions.ts`.

**The validation/build phase** returns confirmation metadata without touching the chain:

```ts
export async function executePauseApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const resolved = resolveMultiAppNames(String(args.app_name ?? ''), address, appRegistry, (a) => a.status === 'running', 'pause');
  if (resolved.mode === 'error') return { success: false, error: resolved.error };

  // Single-app path
  if (resolved.mode === 'single') {
    const app = appRegistry.findApp(address, resolved.name);
    if (!app) return { success: false, error: `App "${resolved.name}" not found.` };

    return {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: `Pause "${app.name}"?`,
      pendingAction: { toolName: 'pause_app', args: { app_name: app.name } },
    };
  }

  // Multi-app path (comma-separated or "all")
  // Same shape; the confirmed phase iterates the resolved apps.
  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Pause ${resolved.apps.length} apps?`,
    pendingAction: { toolName: 'pause_app', args: { app_name: args.app_name } },
  };
}
```

**The confirmed phase** does the actual chain/provider work:

```ts
export async function executeConfirmedPauseApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const app = appRegistry.findApp(address, String(args.app_name));
  if (!app) return { success: false, error: `App not found.` };

  // Authenticate to the provider using ADR-036
  const { signing } = options;
  if (!signing) {
    return { success: false, error: 'Wallet does not support message signing' };
  }
  const authToken = await signing.authTokens.getAuthToken(asLeaseUuid(app.leaseUuid));

  // Call your provider HTTP function
  await pauseLease(app.providerUrl, app.leaseUuid, authToken);

  // Update local state
  appRegistry.updateApp(address, app.leaseUuid, { status: 'paused' });

  return {
    success: true,
    data: {
      app_name: app.name,
      status: 'paused',
    },
  };
}
```

For a query tool (no confirmation), skip the two-phase split — the executor lives in `src/ai/toolExecutor/compositeQueries.ts` and looks like the confirmed half above, returning the data directly.

## 3. Wire it into the dispatcher

Open `src/ai/toolExecutor/index.ts`:

1. Import the new functions from `compositeTransactions`.
2. Add the tool name to the appropriate set:
   ```ts
   const TX_TOOLS = new Set([
     'deploy_app',
     'stop_app',
     'fund_credits',
     'restart_app',
     'update_app',
     'set_custom_domain',
     'pause_app',          // ← new
   ]);
   ```
3. Add a `case` in the `executeTool` TX switch:
   ```ts
   case 'pause_app':
     return await executePauseApp(args, options);
   ```
4. Add a `case` in the `executeConfirmedTool` switch:
   ```ts
   case 'pause_app':
     return await executeConfirmedPauseApp(args, clientManager, options);
   ```

Query tools follow the same pattern but only need a single switch entry in `executeTool`.

## 4. Teach the system prompt

The model needs to know when to call your tool. Open `src/ai/systemPrompt.ts` and add an example or rule:

```
User: "Pause my-app"
→ pause_app(app_name="my-app")

User: "Pause everything"
→ pause_app(app_name="all")
```

Put it next to a structurally similar tool (`stop_app` is the closest analogue here) so the model picks up the comma-separated / `all` convention.

If your tool introduces a new noun ("pause", "snapshot", …), add it to the **Vocabulary** section so the model uses consistent terminology in replies.

## 5. Add tests

Three layers of tests are appropriate for transactions:

1. **Tool definition test** in `src/ai/tools.test.ts`. Ensures the tool is registered and `requiresConfirmation` returns the right value.
2. **Composite executor test** in `src/ai/toolExecutor/compositeTransactions.test.ts`. Covers validation paths, the multi-app resolver, and confirmed-execution behaviour with mocked chain/provider clients.
3. **Integration test** (only when the flow crosses several layers) in `src/__tests__/`.

For a query tool, only the first two are needed; the integration test isn't necessary unless you cache or coordinate with other tools.

Mock conventions live in [testing.md](testing.md). The short version:

- Mock `manifest-mcp-fred` and `manifest-mcp-core` with `importOriginal` so enums and helpers survive.
- Mock `api/billing` and `api/sku` with `importOriginal` so `LeaseState` / `Unit` enums work.
- Use `vi.mocked(fn).mockResolvedValue(…)` for return values; check `expect(fn).toHaveBeenCalledWith(…)` for input shape.

## 6. Update the docs

Three doc surfaces benefit from updates:

- **[CLAUDE.md](../../CLAUDE.md)** — add a row to the "17 Composite Tools" table (and adjust the count in the heading).
- **[ARCHITECTURE.md](../../ARCHITECTURE.md)** — usually no change unless the tool introduces a new layer.
- **[docs/user/ai-cookbook.md](../user/ai-cookbook.md)** — add a section in the appropriate group with example prompts.

If the tool exposes a new parameter shape (e.g. a `services` JSON object), also update **[docs/user/manifest-format.md](../user/manifest-format.md)**.

## 7. Validate end-to-end

```bash
npx tsc -b           # type-check
npm run lint         # lint
npx vitest run       # full test suite
npm run dev          # smoke-test in browser
```

In dev, deploy a test app, then ask the AI to invoke your new tool. Verify:

- The tool name appears in the streaming UI.
- The confirmation card shows the right summary (transactions only).
- After approval, the chain transaction broadcasts and the post-action state matches expectations.
- The tool result is summarized correctly in the chat.

## Common pitfalls

### Forgetting to add to `CONFIRMATION_TOOLS`

If your transaction tool isn't in the set, `requiresConfirmation` returns `false`, the AI store skips the confirmation step, and the user never approves. The tool will fail silently because the confirmed-phase function never runs.

### Calling `executeTool` without a `clientManager`

Query tools that hit the chain need `clientManager` in `options`. If the wallet isn't connected, return early with `{ success: false, error: 'Wallet not connected' }`. The dispatcher does not enforce this for you.

### Returning `{ success: true, data: undefined }`

The discriminated union forbids it (`data` must be present on success). Return `{ success: true, data: null }` or `{ success: true, data: { /* something */ } }`. TypeScript will catch this.

### Running heavy work in the validation phase

The `executeXxx` half should be fast. Don't broadcast transactions, don't call the provider. Save that for `executeConfirmedXxx`. The confirmation card should appear immediately after the user submits.

### Mutating `args` in place

The dispatcher passes `args` from the model verbatim. If you mutate it (e.g. `args._generatedManifest = ...`) the value is preserved across the confirmation step — that's intentional in `executeDeployApp`. If you do *not* want it preserved, use a local variable.

### Forgetting `getToolCallDescription`

The streaming UI falls back to `Executing ${toolName}...` if you don't add a case. Add one for a clean UX.

### Not handling the multi-app case

Tools with `app_name` should accept comma-separated lists and `"all"`. Use the existing helper (`resolveMultiAppNames` or similar) instead of rolling your own — the system prompt teaches the model to send these shapes.
