# Manifest format

A manifest describes what to run on a provider: the container image, ports, environment, resource needs, and lifecycle behaviour. Barney accepts manifests as JSON or YAML files and supports two shapes:

- **Single-service manifest** — one container.
- **Stack manifest** — multiple coordinated containers under `{ "services": { ... } }`.

This document is the user-facing reference. The canonical implementation lives in `src/ai/manifest.ts` and `@manifest-network/manifest-mcp-fred`.

## File limits

- **Maximum size:** 5 KB after JSON serialization.
- **Allowed extensions:** `.json`, `.yaml`, `.yml`, `.txt`.
- **Filename character limit:** 255 characters.

The 5 KB ceiling exists because manifests are uploaded to providers as raw payloads. Most well-formed manifests are well under 1 KB.

## Single-service manifest

```json
{
  "image": "redis:8.4",
  "ports": {
    "6379/tcp": {}
  },
  "env": {
    "REDIS_PASSWORD": ""
  },
  "user": "999:999",
  "tmpfs": ["/var/run/redis"],
  "command": ["redis-server"],
  "args": ["--appendonly", "yes"],
  "health_check": {
    "test": ["CMD", "redis-cli", "ping"],
    "interval": "10s",
    "timeout": "3s",
    "retries": 3,
    "start_period": "5s"
  },
  "stop_grace_period": "30s",
  "init": true,
  "expose": ["9090"],
  "labels": {
    "team": "platform"
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `image` | `string` | yes | Docker image reference, including tag. Examples: `redis:8.4`, `ghcr.io/org/app:v1.2.3`, `postgres:17`. |
| `ports` | `object` | no | Map of `"<port>/<proto>"` to options object. Protocol is `tcp` or `udp`. Options can include `{ "ingress": true }` to mark the preferred port for FQDN routing (at most one TCP port per service). |
| `env` | `object` | no | String-keyed environment variables. **Empty values (`""`) auto-generate alphanumeric passwords**. Values ending in `/` get a generated suffix. |
| `user` | `string` | no | Container user/UID, e.g. `999:999`. |
| `tmpfs` | `string[]` | no | Tmpfs mount paths. |
| `command` | `string[]` | no | Override the image `ENTRYPOINT`. |
| `args` | `string[]` | no | Override the image `CMD`. |
| `health_check` | `object` | no | Container health check. See below. |
| `stop_grace_period` | `string` | no | SIGTERM-to-SIGKILL grace period. Format: `30s`, `1m`. Range: 1 s – 120 s. Default 10 s. |
| `init` | `boolean` | no | Run `tini` as PID 1 for zombie reaping and signal forwarding. |
| `expose` | `string[]` | no | Inter-service ports to document. Does not create host bindings. Useful in stacks. |
| `labels` | `object` | no | Custom container labels. |
| `depends_on` | `object` | stack-only | See [stack manifests](#stack-manifest). |

### Port format

Ports are written as `"<port>/<protocol>"`:

```json
{
  "ports": {
    "8080/tcp": {},
    "53/udp": {}
  }
}
```

When you ask the AI to deploy by image (`Deploy redis with port 6379,8080`), Barney's `normalizePorts` accepts a comma-separated string, defaults the protocol to `tcp`, and emits this object form.

To mark a TCP port as the ingress port (the one used to derive a public FQDN), use:

```json
{
  "ports": {
    "8080/tcp": { "ingress": true },
    "9090/tcp": {}
  }
}
```

The single-service `ManifestEditor` enforces the "at most one ingress per service" rule. The provider (Fred) reads `ingress` to decide which port to put behind the assigned public FQDN. If no port has `ingress: true`, the provider picks one heuristically; the resulting URL may not be the one you expect, and a service with only UDP ports may not be reachable externally at all.

### Auto-generated passwords

Empty env values trigger automatic password generation on deploy. This is the recommended pattern for database images:

```json
{
  "image": "postgres:17",
  "env": {
    "POSTGRES_PASSWORD": ""
  }
}
```

Passwords are 16-character cryptographically random alphanumeric strings, generated client-side via `crypto.getRandomValues`. The generated value is part of the uploaded manifest payload — it is not derivable from any seed.

When manifests are persisted to your local app registry, sensitive env values are scrubbed before write. Re-deploying from the registry regenerates them.

### Health checks

```json
{
  "health_check": {
    "test": ["CMD-SHELL", "curl -f http://localhost/health"],
    "interval": "30s",
    "timeout": "5s",
    "retries": 3,
    "start_period": "10s"
  }
}
```

The `test` array follows Docker conventions:

- `["CMD", "executable", "arg", ...]` — exec form.
- `["CMD-SHELL", "shell command"]` — shell form.

Curated images in Barney's catalog ship with sensible default health checks.

## Stack manifest

A stack runs multiple services that share a tier and communicate over an internal DNS network using their service name as hostname.

```json
{
  "services": {
    "web": {
      "image": "wordpress:6",
      "ports": {
        "80/tcp": { "ingress": true }
      },
      "env": {
        "WORDPRESS_DB_HOST": "db:3306",
        "WORDPRESS_DB_USER": "wp",
        "WORDPRESS_DB_PASSWORD": ""
      },
      "depends_on": {
        "db": { "condition": "service_healthy" }
      }
    },
    "db": {
      "image": "mysql:8",
      "expose": ["3306"],
      "env": {
        "MYSQL_DATABASE": "wp",
        "MYSQL_USER": "wp",
        "MYSQL_PASSWORD": "",
        "MYSQL_ROOT_PASSWORD": ""
      },
      "tmpfs": ["/var/run/mysqld"],
      "health_check": {
        "test": ["CMD", "mysqladmin", "ping", "-h", "localhost"],
        "interval": "10s",
        "timeout": "5s",
        "retries": 5
      }
    }
  }
}
```

### Stack-only fields

| Field | Type | Description |
|-------|------|-------------|
| `services` | `object` | Map of service name to a single-service manifest body. Service names follow RFC 1123: lowercase alphanumeric and hyphens, no leading/trailing hyphen, ≤ 63 characters. |
| `services.<name>.depends_on` | `object` | Map of dependency service name to `{ "condition": "service_started" \| "service_healthy" }`. Use `service_healthy` when a service must wait for its dependency's health check to pass. |

### Service discovery

Within a stack, services resolve each other by service name:

- `db:3306` from inside `web` resolves to the `db` service's exposed port.
- DNS is local to the stack — service names do not collide across apps.

### Cross-service password coordination

Stacks often need the same password in multiple services (e.g. WordPress and MySQL share `WORDPRESS_DB_PASSWORD` / `MYSQL_PASSWORD`). Three deploy paths handle this differently:

| Path | Behaviour |
|------|-----------|
| Curated stack via chat (e.g. "Deploy WordPress with MySQL") | The example app's `manifestFactory` generates one password and threads it through every service. |
| AI deploy with the `services` JSON parameter | Barney generates one shared password and applies it to every empty env value across all services in the stack. Values ending in `/` get the same shared password appended. |
| Hand-authored stack manifest file | Auto-generation runs per service: two empty strings produce two different passwords. Set the same explicit value in each service if they need to match. |

If you need predictable cross-service credentials in a hand-authored stack, supply the value yourself rather than relying on auto-generation.

### Persistent storage

Larger disk requires the `docker-small` (or larger) SKU. There is no `storage` deploy flag; select the tier by naming the size explicitly (e.g. "Deploy as small") when you submit the deploy.

## Validation rules

Barney validates manifests at three stages:

1. **Client-side, before upload** (`src/utils/fileValidation.ts`):
   - File extension and MIME type.
   - File size ≤ 5 KB.
   - JSON: full `JSON.parse` plus structural validation (top-level object; if `services` is present, each entry must be an object with an `image` key).
   - YAML: lightweight regex check — no parser is invoked. The file must contain a top-level `image:` line, or a top-level `services:` block whose immediate child keys parse out to RFC 1123 service names. Anything more sophisticated is left to the provider.
2. **Manifest construction** (`src/ai/manifest.ts`):
   - Port numbers are integers in `[1, 65535]`.
   - Protocols are `tcp` or `udp`.
   - Service names (stack only) match RFC 1123 DNS label rules.
   - Generated payload size ≤ 5 KB.
3. **Provider-side, after upload**:
   - The provider may reject manifests that target unavailable resources or violate provider-specific constraints. Surfaced via `app_diagnostics`.

## Worked examples

### Postgres with persistent storage

```json
{
  "image": "postgres:17",
  "ports": { "5432/tcp": { "ingress": true } },
  "env": { "POSTGRES_PASSWORD": "" },
  "user": "999:999",
  "tmpfs": ["/var/run/postgresql"]
}
```

Deploy as `small` for persistent disk:

```
Deploy as small  (File attached: postgres.json)
```

### Static nginx

```json
{
  "image": "nginx:alpine",
  "ports": { "80/tcp": { "ingress": true } }
}
```

### Worker without ingress

```json
{
  "image": "ghcr.io/org/worker:v1.0.0",
  "command": ["python", "-m", "worker"],
  "env": {
    "QUEUE_URL": "redis://queue:6379"
  },
  "labels": {
    "team": "platform",
    "tier": "background"
  }
}
```

No `ports` field — the worker is internal and not exposed externally.

### WordPress + MySQL (compact)

```json
{
  "services": {
    "web": {
      "image": "wordpress:6",
      "ports": { "80/tcp": { "ingress": true } },
      "env": {
        "WORDPRESS_DB_HOST": "db:3306",
        "WORDPRESS_DB_USER": "wp",
        "WORDPRESS_DB_PASSWORD": "shared-password"
      },
      "depends_on": { "db": { "condition": "service_healthy" } }
    },
    "db": {
      "image": "mysql:8",
      "expose": ["3306"],
      "env": {
        "MYSQL_USER": "wp",
        "MYSQL_PASSWORD": "shared-password",
        "MYSQL_ROOT_PASSWORD": "different-password"
      },
      "health_check": {
        "test": ["CMD", "mysqladmin", "ping", "-h", "localhost"],
        "interval": "10s",
        "timeout": "5s",
        "retries": 5
      }
    }
  }
}
```

## Editing a manifest before deploy

When the AI submits a deploy, you see a `ConfirmationCard` with the rendered manifest. Click **Edit** to change fields in-place — port, env, command, args, etc. — before broadcasting the transaction. The `StackManifestEditor` tab handles per-service editing for stack manifests. Validation runs as you type; broken manifests cannot be submitted.
