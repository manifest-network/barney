/**
 * Known Docker image configurations.
 * Single source of truth consumed by:
 * 1. System prompt — compact reference so the model generates correct tool calls
 * 2. Tool executor — safety net to merge known defaults when the model omits args
 */

import type { HealthCheckConfig } from './manifest';

export interface KnownImageConfig {
  /** Canonical image name (without tag), e.g. "postgres" */
  image: string;
  /** Default exposed port(s), comma-separated for multiple */
  port: string;
  /** Required/recommended env vars. Empty string = auto-generated password. Trailing "/" = append generated password. */
  env?: Record<string, string>;
  /** Container user override (uid:gid) */
  user?: string;
  /** Tmpfs mount path(s), comma-separated */
  tmpfs?: string;
  /** Container entrypoint override */
  command?: string[];
  /** Container CMD override */
  args?: string[];
  /** Whether the image needs persistent storage */
  storage?: boolean;
  /** Alternative names that should resolve to this config */
  aliases?: string[];
  /** Container health check configuration */
  health_check?: HealthCheckConfig;
  /** Grace period before SIGKILL after SIGTERM */
  stop_grace_period?: string;
  /** Run init process (tini) as PID 1 */
  init?: boolean;
  /** Inter-service ports to document, comma-separated */
  expose?: string;
  /** Container labels */
  labels?: Record<string, string>;
}

export const KNOWN_IMAGES: readonly KnownImageConfig[] = [
  // --- Databases ---
  { image: 'postgres', port: '5432', env: { POSTGRES_PASSWORD: '' }, user: '999:999', tmpfs: '/var/run/postgresql', storage: true, aliases: ['postgresql'], health_check: { test: ['CMD-SHELL', 'pg_isready -U postgres'], interval: '10s', timeout: '5s', retries: 5, start_period: '30s' } },
  { image: 'mysql', port: '3306', env: { MYSQL_ROOT_PASSWORD: '' }, tmpfs: '/var/run/mysqld', storage: true, health_check: { test: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1'], interval: '10s', timeout: '5s', retries: 5, start_period: '30s' } },
  { image: 'mariadb', port: '3306', env: { MARIADB_ROOT_PASSWORD: '' }, storage: true, health_check: { test: ['CMD-SHELL', 'mariadb-admin ping -h 127.0.0.1'], interval: '10s', timeout: '5s', retries: 5, start_period: '30s' } },
  { image: 'mongo', port: '27017', env: { MONGO_INITDB_ROOT_USERNAME: 'admin', MONGO_INITDB_ROOT_PASSWORD: '' }, storage: true, aliases: ['mongodb'] },
  { image: 'neo4j', port: '7474,7687', env: { NEO4J_AUTH: 'neo4j/' }, storage: true },
  { image: 'redis', port: '6379', aliases: ['valkey'], health_check: { test: ['CMD', 'redis-cli', 'ping'], interval: '10s', timeout: '3s', retries: 3, start_period: '5s' } },
  { image: 'memcached', port: '11211' },
  { image: 'clickhouse-server', port: '8123,9000', aliases: ['clickhouse/clickhouse-server', 'clickhouse'] },
  { image: 'influxdb', port: '8086', storage: true },

  // --- Message Brokers ---
  { image: 'rabbitmq', port: '5672,15672', env: { RABBITMQ_DEFAULT_USER: 'guest', RABBITMQ_DEFAULT_PASS: '' }, aliases: ['rabbitmq-management'] },
  { image: 'nats', port: '4222,8222' },

  // --- CMS ---
  { image: 'wordpress', port: '80', tmpfs: '/run/lock,/var/run/apache2', storage: true },
  { image: 'ghost', port: '2368', storage: true },

  // --- Web Servers ---
  { image: 'nginx', port: '80' },
  { image: 'httpd', port: '80', aliases: ['apache'] },
  { image: 'caddy', port: '80,443' },

  // --- Search ---
  { image: 'elasticsearch', port: '9200,9300', env: { 'discovery.type': 'single-node' }, aliases: ['elastic'] },

  // --- Object Storage ---
  { image: 'minio', port: '9000,9001', env: { MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: '' }, aliases: ['minio/minio'], storage: true },

  // --- Monitoring ---
  { image: 'grafana', port: '3000', aliases: ['grafana/grafana'] },
  { image: 'prometheus', port: '9090', aliases: ['prom/prometheus'] },

  // --- AI Tools ---
  { image: 'openclaw', port: '18789', env: { OPENCLAW_GATEWAY_TOKEN: '', OLLAMA_HOST: '172.17.0.1' }, command: ['/bin/sh', '-c'], args: ['mkdir -p /home/node/.openclaw && echo \'{"gateway":{"controlUi":{"enabled":true,"allowInsecureAuth":true}},"models":{"providers":{"ollama":{"baseUrl":"http://172.17.0.1:11434/v1","apiKey":"ollama-local","api":"openai-completions","models":[{"id":"qwen3-coder:30b","name":"Qwen3 Coder 30B","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":131072,"maxTokens":16000}]}}},"agents":{"defaults":{"model":{"primary":"ollama/qwen3-coder:30b"}}}}\' > /home/node/.openclaw/openclaw.json && exec docker-entrypoint.sh node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789'], aliases: ['ghcr.io/openclaw/openclaw'] },

  // --- Admin Tools ---
  { image: 'adminer', port: '8080' },
  { image: 'registry', port: '5000', aliases: ['docker-registry'] },

  // --- Render Demo (requires external OTOY/Render API credentials — not auto-generated) ---
  { image: 'ghcr.io/manifest-network/render-image-gen', port: '8000', aliases: ['render-image-gen', 'render-demo'] },
];

/**
 * Find a known image config by matching image reference.
 * Strips tag, digest, and registry prefix before matching by name or alias.
 *
 * Examples:
 *   "postgres:16"                      → postgres config
 *   "docker.io/library/redis:8.4"      → redis config
 *   "clickhouse/clickhouse-server:24"  → clickhouse config
 *   "unknown-app:latest"               → undefined
 */
export function findKnownImage(imageRef: string): KnownImageConfig | undefined {
  // Strip digest (@sha256:...)
  let name = imageRef.replace(/@sha256:[a-fA-F0-9]+$/, '');
  // Strip tag (:...)
  name = name.replace(/:[\w][\w.-]*$/, '');

  // Strip docker.io/library/ prefix (official images)
  name = name.replace(/^docker\.io\/library\//, '');

  // Normalize to lowercase
  name = name.toLowerCase();

  // Try exact match on image name (with or without registry prefix stripped)
  for (const config of KNOWN_IMAGES) {
    if (name === config.image) return config;
  }

  // Try matching after stripping registry prefix (last path segment)
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash !== -1) {
    const shortName = name.slice(lastSlash + 1);

    // Match short name against image names
    for (const config of KNOWN_IMAGES) {
      if (shortName === config.image) return config;
    }

    // Match full org/image against aliases
    for (const config of KNOWN_IMAGES) {
      if (config.aliases?.includes(name)) return config;
    }

    // Match short name against aliases
    for (const config of KNOWN_IMAGES) {
      if (config.aliases?.includes(shortName)) return config;
    }
  } else {
    // No registry prefix — check aliases
    for (const config of KNOWN_IMAGES) {
      if (config.aliases?.includes(name)) return config;
    }
  }

  return undefined;
}

export interface KnownStackServiceConfig {
  image: string;
  port: string;
  env?: Record<string, string>;
  user?: string;
  tmpfs?: string;
  command?: string[];
  args?: string[];
  description: string;
  health_check?: HealthCheckConfig;
  stop_grace_period?: string;
  init?: boolean;
  expose?: string;
  labels?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
}

export interface KnownStackConfig {
  /** Stack name, e.g. "wordpress" */
  name: string;
  /** Services keyed by DNS name */
  services: Record<string, KnownStackServiceConfig>;
  /** Alternative names that should resolve to this stack */
  aliases?: string[];
}

export const KNOWN_STACKS: readonly KnownStackConfig[] = [
  {
    name: 'wordpress',
    services: {
      web: {
        image: 'wordpress',
        port: '80',
        env: { WORDPRESS_DB_HOST: 'db:3306', WORDPRESS_DB_USER: 'wordpress', WORDPRESS_DB_PASSWORD: '', WORDPRESS_DB_NAME: 'wordpress' },
        tmpfs: '/run/lock,/var/run/apache2',
        description: 'WordPress CMS',
        depends_on: { db: { condition: 'service_healthy' } },
      },
      db: {
        image: 'mysql',
        port: '3306',
        env: { MYSQL_DATABASE: 'wordpress', MYSQL_USER: 'wordpress', MYSQL_PASSWORD: '', MYSQL_ROOT_PASSWORD: '' },
        description: 'MySQL database',
      },
    },
    aliases: ['wp'],
  },
  {
    name: 'ghost',
    services: {
      web: {
        image: 'ghost',
        port: '2368',
        env: { 'database__client': 'mysql', 'database__connection__host': 'db', 'database__connection__user': 'ghost', 'database__connection__password': '', 'database__connection__database': 'ghost' },
        description: 'Ghost publishing platform',
        depends_on: { db: { condition: 'service_healthy' } },
      },
      db: {
        image: 'mysql',
        port: '3306',
        env: { MYSQL_DATABASE: 'ghost', MYSQL_USER: 'ghost', MYSQL_PASSWORD: '', MYSQL_ROOT_PASSWORD: '' },
        description: 'MySQL database',
      },
    },
  },
  {
    name: 'adminer-postgres',
    services: {
      adminer: {
        image: 'adminer',
        port: '8080',
        description: 'Database management UI',
        depends_on: { db: { condition: 'service_healthy' } },
      },
      db: {
        image: 'postgres',
        port: '5432',
        env: { POSTGRES_PASSWORD: '' },
        user: '999:999',
        tmpfs: '/var/run/postgresql',
        description: 'PostgreSQL database',
      },
    },
    aliases: ['pgadmin'],
  },
];

/**
 * Find a known stack config by name or alias.
 */
export function findKnownStack(name: string): KnownStackConfig | undefined {
  const normalized = name.toLowerCase();
  for (const stack of KNOWN_STACKS) {
    if (normalized === stack.name) return stack;
    if (stack.aliases?.includes(normalized)) return stack;
  }
  return undefined;
}

/**
 * Generate a compact image reference table for the system prompt.
 * One line per image, showing port, env, and flags.
 */
export function generateImageReferenceForPrompt(): string {
  const lines = KNOWN_IMAGES.map((cfg) => {
    const parts = [`${cfg.image}: port=${cfg.port}`];
    if (cfg.env) {
      const envParts = Object.entries(cfg.env).map(([k, v]) => {
        if (v === '') return `${k}=""`;
        if (v.endsWith('/')) return `${k}="${v}<password>"`;
        return `${k}="${v}"`;
      });
      parts.push(`env={${envParts.join(', ')}}`);
    }
    if (cfg.user) parts.push(`user="${cfg.user}"`);
    if (cfg.tmpfs) parts.push(`tmpfs="${cfg.tmpfs}"`);
    if (cfg.command) parts.push(`command=${JSON.stringify(cfg.command)}`);
    if (cfg.args) parts.push(`args=${JSON.stringify(cfg.args)}`);
    if (cfg.storage) parts.push('storage=true');
    if (cfg.health_check) parts.push('health_check=yes');
    if (cfg.aliases?.length) parts.push(`(aka ${cfg.aliases.join(', ')})`);
    return parts.join(' ');
  });
  return lines.join('\n');
}

/**
 * Generate a compact stack reference table for the system prompt.
 * One line per stack showing service names and images.
 */
export function generateStackReferenceForPrompt(): string {
  const lines = KNOWN_STACKS.map((stack) => {
    const svcs = Object.entries(stack.services)
      .map(([name, cfg]) => `${name}(${cfg.image})`)
      .join(' + ');
    const aliases = stack.aliases?.length ? ` (aka ${stack.aliases.join(', ')})` : '';
    return `${stack.name}: ${svcs}${aliases}`;
  });
  return lines.join('\n');
}
