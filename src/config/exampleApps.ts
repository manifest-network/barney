/**
 * Example app definitions shared between ChatPanel (deploy buttons) and
 * AppsSidebar (re-deploy fallback for entries without a stored manifest).
 */

import { generatePassword } from '../utils/hash';

export interface ExampleApp {
  label: string;
  manifest: Record<string, unknown>;
  envFactory?: () => Record<string, string>;
  /** Builds the complete manifest dynamically (overrides manifest + envFactory when present). */
  manifestFactory?: () => Record<string, unknown>;
  size?: string;
  group: 'games' | 'apps';
  category?: string;
}

const GAME_MANIFEST = (game: string) => ({
  image: `docker.io/lifted/demo-games:${game}`,
  ports: { '8080/tcp': {} },
  env: {},
  read_only: true,
  tmpfs: ['/var/cache/nginx', '/var/run'],
});

const SERVICE_MANIFEST = (
  image: string,
  ports: string[],
  opts?: { env?: Record<string, string>; user?: string; tmpfs?: string[]; command?: string[]; args?: string[] },
) => {
  const portMap: Record<string, Record<string, never>> = {};
  for (const p of ports) portMap[`${p}/tcp`] = {};
  return {
    image,
    ports: portMap,
    ...(opts?.env ? { env: opts.env } : {}),
    ...(opts?.user ? { user: opts.user } : {}),
    ...(opts?.tmpfs ? { tmpfs: opts.tmpfs } : {}),
    ...(opts?.command ? { command: opts.command } : {}),
    ...(opts?.args ? { args: opts.args } : {}),
  };
};

export const EXAMPLE_APPS: ExampleApp[] = [
  { label: 'Tetris', manifest: GAME_MANIFEST('tetris'), group: 'games' },
  { label: '2048', manifest: GAME_MANIFEST('2048'), group: 'games' },
  { label: 'Pac-Man', manifest: GAME_MANIFEST('pacman'), group: 'games' },
  { label: 'Floppy Bird', manifest: GAME_MANIFEST('floppybird'), group: 'games' },
  { label: 'Hextris', manifest: GAME_MANIFEST('hextris'), group: 'games' },
  { label: 'Clumsy Bird', manifest: GAME_MANIFEST('clumsy-bird'), group: 'games' },
  { label: 'Scorch', manifest: GAME_MANIFEST('scorch'), group: 'games' },
  { label: 'Secret Agent', manifest: GAME_MANIFEST('secretagent'), group: 'games' },
  { label: 'SimCity', manifest: GAME_MANIFEST('simcity'), group: 'games' },
  { label: 'SimCity 2000', manifest: GAME_MANIFEST('simcity2000'), group: 'games' },
  { label: 'Colossal Cave', manifest: GAME_MANIFEST('colossalcave'), group: 'games' },
  { label: 'Civilization', manifest: GAME_MANIFEST('civilization'), group: 'games' },
  { label: 'Space Quest 4', manifest: GAME_MANIFEST('spacequest4'), group: 'games' },
  { label: "King's Quest 5", manifest: GAME_MANIFEST('kingsquest5'), group: 'games' },
  { label: "King's Quest 6", manifest: GAME_MANIFEST('kingsquest6'), group: 'games' },
  { label: "King's Quest 7", manifest: GAME_MANIFEST('kingsquest7'), group: 'games' },
  { label: 'Monkey Island', manifest: GAME_MANIFEST('monkeyisland'), group: 'games' },
  { label: 'Battle Chess', manifest: GAME_MANIFEST('battlechess'), group: 'games' },
  { label: 'Oregon Trail', manifest: GAME_MANIFEST('oregontrail'), group: 'games' },
  { label: 'Doom', manifest: GAME_MANIFEST('doom'), group: 'games' },
  { label: 'ClassiCube', manifest: GAME_MANIFEST('classicube'), group: 'games' },
  // --- Databases ---
  { label: 'Postgres 18', manifest: SERVICE_MANIFEST('postgres:18', ['5432'], { user: '999:999', tmpfs: ['/var/run/postgresql'] }), envFactory: () => ({ POSTGRES_PASSWORD: generatePassword() }), size: 'small', group: 'apps', category: 'Databases' },
  { label: 'MySQL 9', manifest: SERVICE_MANIFEST('mysql:9', ['3306'], { tmpfs: ['/var/run/mysqld'] }), envFactory: () => ({ MYSQL_ROOT_PASSWORD: generatePassword() }), size: 'small', group: 'apps', category: 'Databases' },
  { label: 'MariaDB 12', manifest: SERVICE_MANIFEST('mariadb:12', ['3306'], { tmpfs: ['/run/mysqld'] }), envFactory: () => ({ MARIADB_ROOT_PASSWORD: generatePassword() }), size: 'small', group: 'apps', category: 'Databases' },
  { label: 'MongoDB 8', manifest: SERVICE_MANIFEST('mongo:8', ['27017']), envFactory: () => ({ MONGO_INITDB_ROOT_USERNAME: 'admin', MONGO_INITDB_ROOT_PASSWORD: generatePassword() }), size: 'small', group: 'apps', category: 'Databases' },
  { label: 'Neo4j 2026.01', manifest: SERVICE_MANIFEST('neo4j:2026.01', ['7474', '7687']), envFactory: () => ({ NEO4J_AUTH: `neo4j/${generatePassword()}` }), size: 'small', group: 'apps', category: 'Databases' },
  { label: 'Redis 8.4', manifest: SERVICE_MANIFEST('redis:8.4', ['6379']), size: 'micro', group: 'apps', category: 'Databases' },
  { label: 'Memcached 1.6', manifest: SERVICE_MANIFEST('memcached:1.6', ['11211']), size: 'micro', group: 'apps', category: 'Databases' },
  { label: 'ClickHouse 25', manifest: SERVICE_MANIFEST('clickhouse/clickhouse-server:25.12', ['8123', '9000']), size: 'small', group: 'apps', category: 'Databases' },
  { label: 'InfluxDB 2', manifest: SERVICE_MANIFEST('influxdb:2', ['8086']), size: 'small', group: 'apps', category: 'Databases' },

  // --- Messaging ---
  { label: 'RabbitMQ 4', manifest: SERVICE_MANIFEST('rabbitmq:4-management', ['5672', '15672']), envFactory: () => ({ RABBITMQ_DEFAULT_USER: 'guest', RABBITMQ_DEFAULT_PASS: generatePassword() }), size: 'small', group: 'apps', category: 'Messaging' },
  { label: 'NATS 2', manifest: SERVICE_MANIFEST('nats:2', ['4222', '8222']), size: 'micro', group: 'apps', category: 'Messaging' },

  // --- Web Servers ---
  { label: 'Nginx 1', manifest: SERVICE_MANIFEST('nginx:1', ['80']), size: 'micro', group: 'apps', category: 'Web Servers' },
  { label: 'Apache 2.4', manifest: SERVICE_MANIFEST('httpd:2.4', ['80']), size: 'micro', group: 'apps', category: 'Web Servers' },
  { label: 'Caddy 2', manifest: SERVICE_MANIFEST('caddy:2', ['80', '443']), size: 'micro', group: 'apps', category: 'Web Servers' },

  // --- Search & Storage ---
  { label: 'Elasticsearch 8', manifest: SERVICE_MANIFEST('elasticsearch:8', ['9200', '9300'], { env: { 'discovery.type': 'single-node' } }), size: 'small', group: 'apps', category: 'Search & Storage' },
  { label: 'MinIO', manifest: SERVICE_MANIFEST('minio/minio', ['9000', '9001']), envFactory: () => ({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: generatePassword() }), size: 'small', group: 'apps', category: 'Search & Storage' },

  // --- Monitoring ---
  { label: 'Grafana 11', manifest: SERVICE_MANIFEST('grafana/grafana:11', ['3000']), size: 'micro', group: 'apps', category: 'Monitoring' },
  { label: 'Prometheus 3', manifest: SERVICE_MANIFEST('prom/prometheus:v3', ['9090']), size: 'micro', group: 'apps', category: 'Monitoring' },

  // --- Tools ---
  { label: 'Adminer 5', manifest: SERVICE_MANIFEST('adminer:5', ['8080']), size: 'micro', group: 'apps', category: 'Tools' },
  { label: 'OpenClaw', manifest: SERVICE_MANIFEST('ghcr.io/openclaw/openclaw:2026.2.12', ['18789'], { command: ['/bin/sh', '-c'], args: ['mkdir -p /home/node/.openclaw && echo \'{"gateway":{"controlUi":{"enabled":true,"allowInsecureAuth":true}},"models":{"providers":{"ollama":{"baseUrl":"http://172.17.0.1:11434/v1","apiKey":"ollama-local","api":"openai-completions","models":[{"id":"qwen3-coder:30b","name":"Qwen3 Coder 30B","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":131072,"maxTokens":16000}]}}},"agents":{"defaults":{"model":{"primary":"ollama/qwen3-coder:30b"}}}}\' > /home/node/.openclaw/openclaw.json && exec docker-entrypoint.sh node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789'] }), manifestFactory: () => {
    const token = generatePassword();
    return {
      ...SERVICE_MANIFEST('ghcr.io/openclaw/openclaw:2026.2.12', ['18789'], {
        command: ['/bin/sh', '-c'],
        args: [`mkdir -p /home/node/.openclaw && echo '{"gateway":{"controlUi":{"enabled":true,"allowInsecureAuth":true}},"models":{"providers":{"ollama":{"baseUrl":"http://172.17.0.1:11434/v1","apiKey":"ollama-local","api":"openai-completions","models":[{"id":"qwen3-coder:30b","name":"Qwen3 Coder 30B","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":131072,"maxTokens":16000}]}}},"agents":{"defaults":{"model":{"primary":"ollama/qwen3-coder:30b"}}}}' > /home/node/.openclaw/openclaw.json && exec docker-entrypoint.sh node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789 --token ${token}`],
      }),
      env: { OPENCLAW_GATEWAY_TOKEN: token, OLLAMA_HOST: '172.17.0.1' },
    };
  }, size: 'large', group: 'apps', category: 'Tools' },
  { label: 'Registry 2', manifest: SERVICE_MANIFEST('registry:2', ['5000']), size: 'micro', group: 'apps', category: 'Tools' },
];

/**
 * Normalize a label to the format used for app names in the registry.
 * e.g. "King's Quest 5" → "manifest-king-s-quest-5"
 */
function toRegistryName(label: string): string {
  return `manifest-${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
}

/**
 * Find an example app by registry app name.
 * Matches by converting the example label to the same name format
 * used by deployExample() in ChatPanel.
 */
export function findExampleByAppName(appName: string): ExampleApp | undefined {
  return EXAMPLE_APPS.find((ex) => toRegistryName(ex.label) === appName);
}

/**
 * Build manifest JSON for an example app, calling envFactory if present.
 */
export function buildExampleManifest(app: ExampleApp): string {
  if (app.manifestFactory) {
    return JSON.stringify(app.manifestFactory(), null, 2);
  }
  const manifest = app.envFactory
    ? { ...app.manifest, env: { ...(app.manifest.env as Record<string, string> | undefined), ...app.envFactory() } }
    : app.manifest;
  return JSON.stringify(manifest, null, 2);
}
