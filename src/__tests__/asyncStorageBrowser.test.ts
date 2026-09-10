// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';

const appRequire = createRequire(import.meta.url);
const walletRequire = createRequire(appRequire.resolve('@cosmos-kit/web3auth'));
const storagePackagePath = walletRequire.resolve('@react-native-async-storage/async-storage/package.json');
const storageRequire = createRequire(storagePackagePath);
const storagePackage = storageRequire(storagePackagePath);
const browserEntry = join(dirname(storagePackagePath), storagePackage.module);
const loadedPaths = new Set<string>();

// Load the installed browser module field, including its actual relative
// imports. Its extensionless ESM needs transformation for Node's test runner;
// dependencies and storage behavior are not mocked.
function loadBrowserModule(filename: string): Record<string, unknown> {
  loadedPaths.add(filename);
  const moduleRequire = createRequire(filename);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const evaluate = compileFunction(source, ['require', 'exports'], { filename });
  evaluate((name: string) => name.startsWith('.')
    ? loadBrowserModule(moduleRequire.resolve(name))
    : moduleRequire(name), exports);
  return exports;
}

interface BrowserStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  mergeItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const storage = loadBrowserModule(browserEntry).default as BrowserStorage;
const key = 'eng-832:async-storage-browser';
afterEach(() => window.localStorage.removeItem(key));

it('resolves the wallet storage browser entry and its official web platform peer', () => {
  expect(storagePackage.version).toBe('2.2.0');
  expect(storageRequire('react-native/package.json').name).toBe('react-native-web');
  expect(storageRequire('react-native').Platform.OS).toBe('web');
  expect(loadedPaths).toContain(join(dirname(browserEntry), 'AsyncStorage.js'));
  expect([...loadedPaths].some(path => /AsyncStorage\.native|NativeAsyncStorageModule|RCTAsyncStorage/.test(path))).toBe(false);
});

it('persists, reads, merges, and removes through real browser localStorage without a native bridge', async () => {
  expect(await storage.getItem(key)).toBeNull();
  const initial = JSON.stringify({ session: { account: 'manifest-test', expires: 1 }, providers: ['google'] });
  await storage.setItem(key, initial);
  expect(window.localStorage.getItem(key)).toBe(initial);
  expect(await storage.getItem(key)).toBe(initial);

  // A browser-side write must be visible through AsyncStorage as well.
  const browserValue = JSON.stringify({ session: { account: 'manifest-test', expires: 9 }, providers: ['google'] });
  window.localStorage.setItem(key, browserValue);
  expect(await storage.getItem(key)).toBe(browserValue);
  await storage.mergeItem(key, JSON.stringify({ session: { expires: 2 }, providers: ['email'] }));
  const merged = { session: { account: 'manifest-test', expires: 2 }, providers: ['google', 'email'] };
  expect(JSON.parse((await storage.getItem(key))!)).toEqual(merged);
  expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(merged);

  await storage.removeItem(key);
  expect(await storage.getItem(key)).toBeNull();
  expect(window.localStorage.getItem(key)).toBeNull();
});
