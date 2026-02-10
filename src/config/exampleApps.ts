/**
 * Example app definitions shared between ChatPanel (deploy buttons) and
 * AppsSidebar (re-deploy fallback for entries without a stored manifest).
 */

import { generatePassword } from '../utils/hash';

export interface ExampleApp {
  label: string;
  manifest: Record<string, unknown>;
  envFactory?: () => Record<string, string>;
  size?: string;
  group: 'games' | 'apps';
}

const GAME_MANIFEST = (game: string) => ({
  image: `docker.io/lifted/demo-games:${game}`,
  ports: { '8080/tcp': {} },
  env: {},
  read_only: true,
  tmpfs: ['/var/cache/nginx', '/var/run'],
});

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
  { label: 'Redis 8.4', manifest: { image: 'redis:8.4', ports: { '6379/tcp': {} } }, size: 'small', group: 'apps' },
  { label: 'Postgres 18', manifest: { image: 'postgres:18', ports: { '5432/tcp': {} }, user: '999:999', tmpfs: ['/var/run/postgresql'] }, envFactory: () => ({ POSTGRES_PASSWORD: generatePassword() }), size: 'small', group: 'apps' },
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
  const manifest = app.envFactory
    ? { ...app.manifest, env: { ...(app.manifest.env as Record<string, string> | undefined), ...app.envFactory() } }
    : app.manifest;
  return JSON.stringify(manifest, null, 2);
}
