/**
 * Example app definitions shared between ChatPanel (deploy buttons) and
 * AppsSidebar (re-deploy fallback for entries without a stored manifest).
 */

import { generatePassword } from '../utils/hash';
import { MANIFEST_NOTICE_KEY } from './constants';

export interface ExampleApp {
  label: string;
  manifest: Record<string, unknown>;
  envFactory?: () => Record<string, string>;
  /** Builds the complete manifest dynamically (overrides manifest + envFactory when present). */
  manifestFactory?: () => Record<string, unknown>;
  /** Notice shown in the ManifestEditor during deploy/update confirmation. */
  notice?: string;
  size?: string;
  group: 'games' | 'apps' | 'stacks';
  category?: string;
}

const GAME_MANIFEST = (game: string) => ({
  image: `docker.io/lifted/demo-games:${game}`,
  ports: { '8080/tcp': {} },
  env: {},
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

// const OPENCLAW_SHELL_CMD =
//   `mkdir -p /home/node/.openclaw && echo '{"gateway":{"controlUi":{"enabled":true,"allowInsecureAuth":true}},"models":{"providers":{"ollama":{"baseUrl":"http://172.17.0.1:11434/v1","apiKey":"ollama-local","api":"openai-completions","models":[{"id":"qwen3-coder:30b","name":"Qwen3 Coder 30B","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":131072,"maxTokens":16000}]}}},"agents":{"defaults":{"model":{"primary":"ollama/qwen3-coder:30b"}}}}' > /home/node/.openclaw/openclaw.json && exec docker-entrypoint.sh node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789`;

// const OPENCLAW_MANIFEST = SERVICE_MANIFEST('ghcr.io/openclaw/openclaw:2026.2.12', ['18789'], {
//   command: ['/bin/sh', '-c'],
//   args: [OPENCLAW_SHELL_CMD],
// });

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
  // { label: 'MariaDB 12', manifest: SERVICE_MANIFEST('mariadb:12', ['3306'], { tmpfs: ['/run/mysqld'] }), envFactory: () => ({ MARIADB_ROOT_PASSWORD: generatePassword() }), size: 'small', group: 'apps', category: 'Databases' },
  // { label: 'MongoDB 8', manifest: SERVICE_MANIFEST('mongo:8', ['27017']), envFactory: () => ({ MONGO_INITDB_ROOT_USERNAME: 'admin', MONGO_INITDB_ROOT_PASSWORD: generatePassword() }), size: 'small', group: 'apps', category: 'Databases' },
  // { label: 'Neo4j 2026.01', manifest: SERVICE_MANIFEST('neo4j:2026.01', ['7474', '7687']), envFactory: () => ({ NEO4J_AUTH: `neo4j/${generatePassword()}` }), size: 'small', group: 'apps', category: 'Databases' },
  { label: 'Redis 8.4', manifest: SERVICE_MANIFEST('redis:8.4', ['6379']), size: 'micro', group: 'apps', category: 'Databases' },
  { label: 'Memcached 1.6', manifest: SERVICE_MANIFEST('memcached:1.6', ['11211']), size: 'micro', group: 'apps', category: 'Databases' },
  // { label: 'ClickHouse 25', manifest: SERVICE_MANIFEST('clickhouse/clickhouse-server:25.12', ['8123', '9000']), size: 'small', group: 'apps', category: 'Databases' },
  // { label: 'InfluxDB 2', manifest: SERVICE_MANIFEST('influxdb:2', ['8086']), size: 'small', group: 'apps', category: 'Databases' },

  // --- Messaging ---
  // { label: 'RabbitMQ 4', manifest: SERVICE_MANIFEST('rabbitmq:4-management', ['5672', '15672']), envFactory: () => ({ RABBITMQ_DEFAULT_USER: 'guest', RABBITMQ_DEFAULT_PASS: generatePassword() }), size: 'small', group: 'apps', category: 'Messaging' },
  // { label: 'NATS 2', manifest: SERVICE_MANIFEST('nats:2', ['4222', '8222']), size: 'micro', group: 'apps', category: 'Messaging' },

  // --- Web Servers ---
  // { label: 'Nginx 1', manifest: SERVICE_MANIFEST('nginx:1', ['80']), size: 'micro', group: 'apps', category: 'Web Servers' },
  // { label: 'Apache 2.4', manifest: SERVICE_MANIFEST('httpd:2.4', ['80']), size: 'micro', group: 'apps', category: 'Web Servers' },
  // { label: 'Caddy 2', manifest: SERVICE_MANIFEST('caddy:2', ['80', '443']), size: 'micro', group: 'apps', category: 'Web Servers' },

  // --- Search & Storage ---
  // { label: 'Elasticsearch 8', manifest: SERVICE_MANIFEST('elasticsearch:8', ['9200', '9300'], { env: { 'discovery.type': 'single-node' } }), size: 'small', group: 'apps', category: 'Search & Storage' },
  // { label: 'MinIO', manifest: SERVICE_MANIFEST('minio/minio', ['9000', '9001']), envFactory: () => ({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: generatePassword() }), size: 'small', group: 'apps', category: 'Search & Storage' },

  // --- Monitoring ---
  // { label: 'Grafana 11', manifest: SERVICE_MANIFEST('grafana/grafana:11', ['3000']), size: 'micro', group: 'apps', category: 'Monitoring' },
  // { label: 'Prometheus 3', manifest: SERVICE_MANIFEST('prom/prometheus:v3', ['9090']), size: 'micro', group: 'apps', category: 'Monitoring' },

  // --- Tools ---
  // { label: 'Adminer 5', manifest: SERVICE_MANIFEST('adminer:5', ['8080']), size: 'micro', group: 'apps', category: 'Tools' },
  // { label: 'OpenClaw', manifest: OPENCLAW_MANIFEST, manifestFactory: () => {
  //   const token = generatePassword();
  //   return {
  //     ...OPENCLAW_MANIFEST,
  //     args: [OPENCLAW_SHELL_CMD + ` --token ${token}`],
  //     env: { OPENCLAW_GATEWAY_TOKEN: token, OLLAMA_HOST: '172.17.0.1' },
  //   };
  // }, size: 'large', group: 'apps', category: 'Tools' },
  // { label: 'EverClaw', manifest: SERVICE_MANIFEST('ghcr.io/everclaw/everclaw:latest', ['18789', '8083']), manifestFactory: () => {
  //   return {
  //     image: 'ghcr.io/everclaw/everclaw:latest',
  //     ports: { '18789/tcp': {}, '8083/tcp': {} },
  //     env: { MORPHEUS_GATEWAY_API_KEY: '', OPENCLAW_GATEWAY_TOKEN: generatePassword(64), OPENCLAW_GATEWAY_PASSWORD: generatePassword(64), EVERCLAW_AGENT_NAME: 'Barney', EVERCLAW_USER_NAME: 'Tester', TZ: 'America/New_York' },
  //     command: ['/bin/sh', '-c'],
  //   };
  // }, size: 'large', group: 'apps', category: 'Tools' },
  // { label: 'Registry 2', manifest: SERVICE_MANIFEST('registry:2', ['5000']), size: 'micro', group: 'apps', category: 'Tools' },

  // --- Render Demo (user-supplied credentials, not auto-generated) ---
  {
    label: 'Render Image Gen',
    manifest: SERVICE_MANIFEST('ghcr.io/manifest-network/render-image-gen:v1.0', ['8000'], {
      env: {
        RENDER_API_KEY: 'pk_YOUR_KEY',
        RENDER_SECRET_KEY: 'sk_YOUR_KEY',
        RENDER_INFERENCE_MODELS: JSON.stringify({
          'SDXL-Turbo': { image: 'ghcr.io/manifest-network/render-image-gen-inference:sdxl-turbo', min_vram_gb: 7, max_vram_gb: 12 },
          'FLUX.1-schnell': { image: 'ghcr.io/manifest-network/render-image-gen-inference:flux-schnell', min_vram_gb: 30, max_vram_gb: 40 },
          'Kolors': { image: 'ghcr.io/manifest-network/render-image-gen-inference:kolors', min_vram_gb: 23, max_vram_gb: 40 },
          'SD 3.5 Large Turbo': { image: 'ghcr.io/manifest-network/render-image-gen-inference:sd35-large-turbo', min_vram_gb: 30, max_vram_gb: 40 },
        }),
      },
    }),
    envFactory: () => ({ INFERENCE_SECRET: generatePassword(32) }),
    notice: 'Save your API key, Secret key, and Inference Secret — these values are not stored and must be re-entered on updates.',
    size: 'micro',
    group: 'apps',
    category: 'AI',
  },

  {
    label: 'Render Music Gen',
    manifest: SERVICE_MANIFEST('ghcr.io/manifest-network/render-music-gen:v1.0', ['8000'], {
      env: {
        RENDER_API_KEY: 'pk_YOUR_KEY',
        RENDER_SECRET_KEY: 'sk_YOUR_KEY',
        RENDER_INFERENCE_MODELS: JSON.stringify({
          'ACE-Step 1.5': { image: 'ghcr.io/manifest-network/render-music-gen-inference:ace-step', min_vram_gb: 15 },
          'DiffRhythm2': { image: 'ghcr.io/manifest-network/render-music-gen-inference:diffrhythm2', min_vram_gb: 10 },
        }),
      },
    }),
    envFactory: () => ({ INFERENCE_SECRET: generatePassword(32) }),
    notice: 'Save your API key, Secret key, and Inference Secret — these values are not stored and must be re-entered on updates.',
    size: 'micro',
    group: 'apps',
    category: 'AI',
  },

  {
    label: 'Render Hum to Music',
    manifest: SERVICE_MANIFEST('ghcr.io/manifest-network/render-hum-music-gen:v1.0', ['8000'], {
      env: {
        RENDER_API_KEY: 'pk_YOUR_KEY',
        RENDER_SECRET_KEY: 'sk_YOUR_KEY',
        RENDER_INFERENCE_MODELS: JSON.stringify({
          'MusicGen Melody Large': { image: 'ghcr.io/manifest-network/render-hum-music-gen-inference:musicgen-melody-large', min_vram_gb: 15 },
        }),
      },
    }),
    envFactory: () => ({ INFERENCE_SECRET: generatePassword(32) }),
    notice: 'Save your API key, Secret key, and Inference Secret — these values are not stored and must be re-entered on updates.',
    size: 'micro',
    group: 'apps',
    category: 'AI',
  },

  {
    label: 'Render Voice Clone',
    manifest: SERVICE_MANIFEST('ghcr.io/manifest-network/render-voice-clone:v1.0', ['8000'], {
      env: {
        RENDER_API_KEY: 'pk_YOUR_KEY',
        RENDER_SECRET_KEY: 'sk_YOUR_KEY',
        RENDER_INFERENCE_MODELS: JSON.stringify({
          'Voice Clone': { image: 'ghcr.io/manifest-network/render-voice-clone-inference:xtts-musetalk', min_vram_gb: 15 },
        }),
      },
    }),
    envFactory: () => ({ INFERENCE_SECRET: generatePassword(32) }),
    notice: 'Save your API key, Secret key, and Inference Secret — these values are not stored and must be re-entered on updates.',
    size: 'micro',
    group: 'apps',
    category: 'AI',
  },

  {
    label: 'Render Dashboard',
    manifest: SERVICE_MANIFEST('ghcr.io/manifest-network/render-dashboard:v1.0', ['8000'], {
      env: {
        RENDER_ACCOUNTS: JSON.stringify([
          { label: 'Account 1', public_key: 'pk_YOUR_KEY', secret_key: 'sk_YOUR_KEY' },
        ]),
      },
    }),
    envFactory: () => ({ DASHBOARD_API_TOKEN: generatePassword(32) }),
    notice: 'Update RENDER_ACCOUNTS with your Render Network API credentials. Each account needs a label, public_key, and secret_key.',
    size: 'micro',
    group: 'apps',
    category: 'AI',
  },

  // --- Stacks (multi-service) ---
  {
    label: 'WordPress + MySQL',
    manifest: { services: {
      web: { image: 'wordpress:6', ports: { '80/tcp': {} }, env: {}, tmpfs: ['/run/lock', '/var/run/apache2'] },
      db: { image: 'mysql:9', env: {}, tmpfs: ['/var/run/mysqld'] },
    }},
    manifestFactory: () => {
      const dbPass = generatePassword();
      return { services: {
        web: {
          image: 'wordpress:6',
          ports: { '80/tcp': {} },
          env: { WORDPRESS_DB_HOST: 'db:3306', WORDPRESS_DB_USER: 'wordpress', WORDPRESS_DB_PASSWORD: dbPass, WORDPRESS_DB_NAME: 'wordpress' },
          tmpfs: ['/run/lock', '/var/run/apache2'],
          depends_on: { db: { condition: 'service_healthy' } },
        },
        db: {
          image: 'mysql:9',
          env: { MYSQL_DATABASE: 'wordpress', MYSQL_USER: 'wordpress', MYSQL_PASSWORD: dbPass, MYSQL_ROOT_PASSWORD: generatePassword() },
          tmpfs: ['/var/run/mysqld'],
          health_check: { test: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1'], interval: '10s', timeout: '5s', retries: 5, start_period: '30s' },
        },
      }};
    },
    size: 'small',
    group: 'stacks',
    category: 'Stacks',
  },
  // {
  //   label: 'Ghost + MySQL',
  //   manifest: { services: {
  //     web: { image: 'ghost:5', ports: { '2368/tcp': {} }, env: {} },
  //     db: { image: 'mysql:9', env: {}, tmpfs: ['/var/run/mysqld'] },
  //   }},
  //   manifestFactory: () => {
  //     const dbPass = generatePassword();
  //     return { services: {
  //       web: {
  //         image: 'ghost:5',
  //         ports: { '2368/tcp': {} },
  //         env: { 'database__client': 'mysql', 'database__connection__host': 'db', 'database__connection__user': 'ghost', 'database__connection__password': dbPass, 'database__connection__database': 'ghost' },
  //         depends_on: { db: { condition: 'service_healthy' } },
  //       },
  //       db: {
  //         image: 'mysql:9',
  //         env: { MYSQL_DATABASE: 'ghost', MYSQL_USER: 'ghost', MYSQL_PASSWORD: dbPass, MYSQL_ROOT_PASSWORD: generatePassword() },
  //         tmpfs: ['/var/run/mysqld'],
  //         health_check: { test: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1'], interval: '10s', timeout: '5s', retries: 5, start_period: '30s' },
  //       },
  //     }};
  //   },
  //   size: 'small',
  //   group: 'stacks',
  //   category: 'Stacks',
  // },
  // {
  //   label: 'Adminer + Postgres',
  //   manifest: { services: {
  //     adminer: { image: 'adminer:5', ports: { '8080/tcp': {} }, env: {} },
  //     db: { image: 'postgres:18', env: {}, user: '999:999', tmpfs: ['/var/run/postgresql'], health_check: { test: ['CMD-SHELL', 'pg_isready -U postgres'], interval: '10s', timeout: '5s', retries: 5, start_period: '30s' } },
  //   }},
  //   manifestFactory: () => {
  //     const dbPass = generatePassword();
  //     return { services: {
  //       adminer: {
  //         image: 'adminer:5',
  //         ports: { '8080/tcp': {} },
  //         env: { ADMINER_DEFAULT_SERVER: 'db' },
  //         depends_on: { db: { condition: 'service_healthy' } },
  //       },
  //       db: {
  //         image: 'postgres:18',
  //         env: { POSTGRES_PASSWORD: dbPass },
  //         user: '999:999',
  //         tmpfs: ['/var/run/postgresql'],
  //         health_check: { test: ['CMD-SHELL', 'pg_isready -U postgres'], interval: '10s', timeout: '5s', retries: 5, start_period: '30s' },
  //       },
  //     }};
  //   },
  //   size: 'small',
  //   group: 'stacks',
  //   category: 'Stacks',
  // },
];

/**
 * Normalize a label to the format used for app names in the registry.
 * e.g. "King's Quest 5" → "manifest-king-s-quest-5"
 */
function toRegistryName(label: string): string {
  return `manifest-${label.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}`;
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
  let manifest: Record<string, unknown>;
  if (app.manifestFactory) {
    manifest = app.manifestFactory();
  } else if (app.envFactory) {
    manifest = { ...app.manifest, env: { ...(app.manifest.env as Record<string, string> | undefined), ...app.envFactory() } };
  } else {
    manifest = app.manifest;
  }
  if (app.notice) {
    manifest = { ...manifest, [MANIFEST_NOTICE_KEY]: app.notice };
  }
  return JSON.stringify(manifest, null, 2);
}
