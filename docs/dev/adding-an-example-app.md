# Adding an example app

Example apps appear as one-click deploy buttons in the chat panel. They're defined in `src/config/exampleApps.ts` as the `EXAMPLE_APPS` array. The same array is used by `AppsSidebar` to re-deploy entries whose manifest is missing from the registry.

This guide shows how to add a new example app and explains the resolution rules that produce the final manifest at deploy time.

## When to use an example app

Example apps are appropriate for:

- **Curated demos** — games and showcase content (`group: 'games'`).
- **Common services** — databases, caches, message brokers (`group: 'apps'`, `category: 'Databases'` etc.).
- **Pre-built stacks** — multi-service templates such as WordPress + MySQL (`group: 'stacks'`).

If your app is single-image and uses standard ports/env, prefer adding it to **`KNOWN_IMAGES`** in `src/ai/knownImages.ts` instead — the AI will then deploy it on demand without needing a button.

## The shape

```ts
export interface ExampleApp {
  label: string;
  manifest: Record<string, unknown>;
  envFactory?: () => Record<string, string>;
  manifestFactory?: () => Record<string, unknown>;
  notice?: string;
  size?: string;
  group: 'games' | 'apps' | 'stacks';
  category?: string;
}
```

| Field | Required | Purpose |
|-------|----------|---------|
| `label` | yes | Display name on the deploy button. |
| `manifest` | yes | Static manifest object. Used as-is unless `manifestFactory` is set. |
| `envFactory` | no | Returns env vars to merge into `manifest.env` at deploy time (e.g. random passwords). |
| `manifestFactory` | no | Returns the *complete* manifest dynamically, overriding `manifest` and `envFactory`. Use for stacks that need coordinated values across services. |
| `notice` | no | Display-only string. Surfaced through the manifest as a top-level `_notice` key (`MANIFEST_NOTICE_KEY` in `src/config/constants.ts`) so the `ManifestEditor` can read it during deploy/update confirmation. The key is stripped from the payload before upload, so it never reaches the provider. Useful for "save these credentials, they cannot be recovered". |
| `size` | no | Preferred SKU tier (`micro`, `small`, `medium`, `large`). Defaults to `micro`. Set to `small` for persistent storage (the only tier where `STORAGE_SKU_NAME` currently applies). |
| `group` | yes | Tab the app appears under: `games`, `apps`, or `stacks`. |
| `category` | only for `apps` | Sub-grouping inside `apps` — `Databases`, `Messaging`, `Web Servers`, `AI`, … |

## Resolution rules

When the user clicks a deploy button, `buildExampleManifest(app)` resolves the final manifest in this order:

1. **`manifestFactory()`** — if present, builds the complete manifest dynamically. Use this for stacks where multiple services need the same generated password.
2. **`envFactory()`** — if present, the returned env vars are merged into `manifest.env` (factory wins on conflicts).
3. **`manifest`** — used as-is.

The `findExampleByAppName(appName)` helper performs the reverse lookup, used by `AppsSidebar` to re-deploy from the registry when the registered manifest is gone.

## Example: a single-service app with a generated password

```ts
{
  label: 'Postgres 17',
  manifest: SERVICE_MANIFEST('postgres:17', ['5432'], {
    user: '999:999',
    tmpfs: ['/var/run/postgresql'],
  }),
  envFactory: () => ({ POSTGRES_PASSWORD: generatePassword() }),
  size: 'small',
  group: 'apps',
  category: 'Databases',
},
```

`SERVICE_MANIFEST(image, ports[], opts?)` is a small helper at the top of `exampleApps.ts` that emits the standard manifest body. The factory generates a fresh password each time the user clicks the deploy button.

## Example: a stack with cross-service credentials

```ts
{
  label: 'WordPress',
  manifest: {},
  manifestFactory: () => {
    const dbPassword = generatePassword();
    return {
      services: {
        web: {
          image: 'wordpress:6',
          ports: { '80/tcp': { ingress: true } },
          env: {
            WORDPRESS_DB_HOST: 'db:3306',
            WORDPRESS_DB_USER: 'wp',
            WORDPRESS_DB_PASSWORD: dbPassword,
          },
          depends_on: { db: { condition: 'service_healthy' } },
        },
        db: {
          image: 'mysql:8',
          expose: ['3306'],
          env: {
            MYSQL_USER: 'wp',
            MYSQL_PASSWORD: dbPassword,
            MYSQL_ROOT_PASSWORD: generatePassword(),
          },
          health_check: {
            test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost'],
            interval: '10s', timeout: '5s', retries: 5,
          },
        },
      },
    };
  },
  size: 'small',
  group: 'stacks',
},
```

`manifestFactory` is necessary here because both services need the *same* generated password. `envFactory` per service would generate two different values.

## Example: an app with user-supplied secrets

```ts
{
  label: 'Render Image Gen',
  manifest: SERVICE_MANIFEST('ghcr.io/manifest-network/render-image-gen:v1.0', ['8000'], {
    env: {
      RENDER_API_KEY: 'pk_YOUR_KEY',
      RENDER_SECRET_KEY: 'sk_YOUR_KEY',
    },
  }),
  envFactory: () => ({ INFERENCE_SECRET: generatePassword(32) }),
  notice: 'Save your API key, Secret key, and Inference Secret — these values are not stored and must be re-entered on updates.',
  size: 'micro',
  group: 'apps',
  category: 'AI',
},
```

Placeholder values in `manifest.env` (`pk_YOUR_KEY`) signal that the user must edit them in the `ManifestEditor` before deploying. The `notice` field surfaces the warning prominently.

## Authoring conventions

- **Pin tags.** Use `redis:8.4`, not `redis:latest`. Predictable behaviour beats automatic upgrades.
- **Prefer micro.** Default to the smallest tier that works. Bump to `small` only when persistent storage is required.
- **Use `tmpfs`** for in-memory state directories that the image expects to write to (`/var/run/postgresql`, `/var/run/mysqld`).
- **Generate one password per logical credential.** When the same value needs to live in two env vars (e.g. WordPress and MySQL share a password), use `manifestFactory`.
- **Never hard-code production secrets.** If a user must supply a key, leave a clearly invalid placeholder (`pk_YOUR_KEY`) and add a `notice`.
- **Set `category` only for `group: 'apps'`.** Games and stacks ignore the field.

## Validation

After adding an entry, sanity-check:

```bash
npx tsc -b           # types
npx vitest run src/config       # if you add tests
npm run dev          # verify the button appears in the right tab
```

Example apps don't need their own tests as long as they reuse the `SERVICE_MANIFEST` helper — type-checking is sufficient. If you write a non-trivial `manifestFactory`, add a unit test that calls it and asserts the result shape.

## Documentation

Example apps are intentionally self-evident from the UI. There is no separate user-facing doc for the catalog — the deploy buttons speak for themselves. Don't add a doc page enumerating examples.
