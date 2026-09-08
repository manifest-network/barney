// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const src = fileURLToPath(new URL('..', import.meta.url));
const scriptExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const declarationFile = /\.d\.[cm]?ts$/;
const TEST_ONLY_SOURCE_FILES = new Set([
  'ai/toolExecutor/testHelpers.ts', // Vitest registry mocks; runtime imports from product code are rejected below.
]);

function isTestOnlyModulePath(path: string): boolean {
  return /\.test(?:\.|$)/.test(basename(path)) || [...TEST_ONLY_SOURCE_FILES].some(
    (fixture) => fixture.replace(scriptExtension, '') === path.replace(scriptExtension, ''),
  );
}

function sourceFiles(directory: string, root = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, root);
    return scriptExtension.test(entry.name)
      && !declarationFile.test(entry.name)
      && !/\.test\./.test(entry.name)
      && !TEST_ONLY_SOURCE_FILES.has(relative(root, path)) ? [path] : [];
  });
}

const forbidden = new Set([
  'cosmosTx', 'executeTx', 'getSigningClient', 'getBroadcastClient',
  'signAndBroadcast', 'signAndBroadcastSync', 'broadcastTx', 'broadcastTxSync',
  'signDirect', 'signAmino',
  'SigningStargateClient', 'connectWithSigner', 'sendTokens',
]);

function isPresenceCheck(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword) {
    return parent.left === node;
  }
  return ts.isCallExpression(parent)
    && parent.arguments.length === 2 && parent.arguments[1] === node
    && ts.isPropertyAccessExpression(parent.expression)
    && ts.isIdentifier(parent.expression.expression) && parent.expression.expression.text === 'Object'
    && parent.expression.name.text === 'hasOwn';
}

function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return parent.moduleSpecifier === node;
  if (ts.isExternalModuleReference(parent)) return parent.expression === node;
  return ts.isCallExpression(parent) && parent.arguments[0] === node
    && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require'));
}

function rawTransactionUsages(file: ts.SourceFile, root = src): string[] {
  if (file.isDeclarationFile) return [];
  const accesses: string[] = [];
  const visit = (node: ts.Node) => {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
        || ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && !node.body)
        || (ts.isPropertyDeclaration(node) && modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword))) return;
    if (ts.isInterfaceDeclaration(node)
        || ts.isTypeAliasDeclaration(node)
        || ts.isTypeParameterDeclaration(node)
        || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
        || (ts.isExportDeclaration(node) && node.isTypeOnly)
        || ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.isTypeOnly)) return;
    if (ts.isHeritageClause(node)) {
      if (node.token === ts.SyntaxKind.ExtendsKeyword
          && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) {
        for (const base of node.types) visit(base);
      }
      return;
    }
    // Class bases and generic instantiation expressions run at runtime,
    // but TypeScript also classifies their wrapper as a TypeNode.
    if (ts.isExpressionWithTypeArguments(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const name = ts.isPrivateIdentifier(node) ? node.text.slice(1) : node.text;
      if (forbidden.has(name)) accesses.push(name);
      return;
    }
    if (ts.isStringLiteralLike(node)) {
      if (forbidden.has(node.text) && !isPresenceCheck(node)) accesses.push(node.text);
      if (isModuleSpecifier(node)) {
        if (node.text.startsWith('.') && isTestOnlyModulePath(relative(root, resolve(dirname(file.fileName), node.text)))) {
          accesses.push(`test-only module: ${node.text}`);
        }
        if (ts.isExportDeclaration(node.parent)
            && (!node.parent.exportClause || ts.isNamespaceExport(node.parent.exportClause))
            && /^(?:@cosmjs\/|@manifest-network\/(?:stargate|manifest-sdk)(?:\/|$))/.test(node.text)) {
          accesses.push(`wildcard transaction module export: ${node.text}`);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return accesses;
}

it('keeps raw transaction building, signing and broadcast APIs out of Barney product code', () => {
  const violations = sourceFiles(src).flatMap((path) => {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    return rawTransactionUsages(file).map((name) => `${relative(src, path)}: ${name}`);
  });
  expect(violations, 'Use typed Manifest SDK operations. Test fixtures belong in TEST_ONLY_SOURCE_FILES; see docs/dev/transaction-boundary.md.').toEqual([]);
});

it('scans JavaScript and TypeScript variants while excluding declarations and test fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'barney-transaction-boundary-'));
  try {
    const runtimeFiles = ['app.ts', 'app.tsx', 'app.mts', 'app.cts', 'app.js', 'app.jsx', 'nested/app.mjs', 'app.cjs', 'ai/toolExecutor/testHelpers.js'];
    const excludedFiles = ['app.test.ts', 'app.test.js', 'env.d.ts', 'types.d.mts', 'types.d.cts', ...TEST_ONLY_SOURCE_FILES];
    for (const file of [...runtimeFiles, ...excludedFiles]) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'client.sendTokens(a, b, coins, fee)');
    }
    const files = sourceFiles(root);
    expect(files.map((file) => relative(root, file)).sort()).toEqual([...runtimeFiles].sort());
    for (const path of files) {
      const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      expect(rawTransactionUsages(file, root)).toEqual(['sendTokens']);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['types.d.ts', 'types.d.mts', 'types.d.cts'])('ignores declaration-only file %s', (path) => {
  const file = ts.createSourceFile(path, 'export function signAmino(a: string): void;', ts.ScriptTarget.Latest, true);
  expect(rawTransactionUsages(file)).toEqual([]);
});

it.each([
  "import { makeRegistry } from './ai/toolExecutor/testHelpers'",
  "export * from './ai/toolExecutor/testHelpers.ts'",
  "const fixtures = await import('./ai/toolExecutor/testHelpers.js')",
  "const fixtures = require('./ai/toolExecutor/testHelpers')",
  "import './build/transactionBoundary.test'",
])('rejects runtime imports of excluded tests: %s', (source) => {
  const file = ts.createSourceFile(join(src, 'app.ts'), source, ts.ScriptTarget.Latest, true);
  expect(rawTransactionUsages(file)).toEqual([expect.stringContaining('test-only module:')]);
});

it.each([
  "signer['signAmino'](address, doc)",
  'signer?.["signDirect"]?.(address, doc)',
  'signer[`signDirect`](address, doc)',
  'const sign = signer.signAmino; sign(address, doc)',
  "const { 'signAmino': sign } = signer; sign(address, doc)",
  "const { ['signAmino']: sign } = signer; sign(address, doc)",
  'const { signAndBroadcast } = signer',
  'cosmosTx(manager, module, command, args)',
  "import { cosmosTx as raw } from '@manifest-network/manifest-sdk/chain'",
  "export { executeTx as raw } from '@manifest-network/manifest-sdk/deploy'",
  'class Foo extends mix(clientManager.getSigningClient()) {}',
  "const Foo = class extends mix(clientManager['getSigningClient']()) {}",
  'const offlineSigner = { getAccounts, signAmino: async (a,d) => rawSign(a,d) }',
  'class TxBroadcaster { async signAndBroadcast(msgs) { return this.post(msgs) } }',
  'const s = { signDirect(a,d) { return raw(a,d) } }',
  'const handlers = { signAmino: callback }',
  'const offlineSigner = { getAccounts, signAmino }',
  "const s = { ['signAmino']: rawSign }",
  'class Signer { signDirect = rawSign }',
  "class Signer { ['signDirect'](a,d) { return raw(a,d) } }",
  'class Signer { get signAmino() { return rawSign } }',
  'function signDirect(a,d) { return raw(a,d) }',
  'const signAmino = async (a,d) => rawSign(a,d)',
  'const sign = signAmino; sign(address, doc)',
  'const sign = signer.signAmino<Doc>',
  '@decorate(clientManager.getSigningClient()) class Foo {}',
  "const SIGN_METHOD = 'signAmino'; signer[SIGN_METHOD](address, doc)",
  'const method = `signDirect`; signer[method](address, doc)',
  "const methods = ['signAmino']; signer[methods[0]](address, doc)",
  "switch (method) { case 'signAmino': invoke(method); }",
  "Object.defineProperty(signer, 'signAmino', { value: rawSign })",
  "Reflect.get(signer, 'signDirect')(address, doc)",
  'class S { async #signDirect(a,d) { return raw(a,d) } run() { return this.#signDirect(a,d) } }',
  "export * from '@manifest-network/manifest-sdk/chain'",
  "export * from '@manifest-network/manifest-sdk'",
  "export * from '@manifest-network/manifest-sdk/deploy'",
  "export * from '@cosmjs/stargate'",
  "export * as chain from '@manifest-network/stargate'",
  "import { SigningStargateClient } from '@cosmjs/stargate'; const c = await SigningStargateClient.connectWithSigner(rpc, signer); c.sendTokens(a, b, coins, 'auto')",
  'const client = await Client.connectWithSigner(rpc, signer)',
  "client.sendTokens(a, b, coins, 'auto')",
  "import { 'cosmosTx' as raw } from './m'",
  "export { 'executeTx' as raw } from './m'",
  "function isDirect(s) { return typeof s.signDirect === 'function' }",
  'abstract class Signer { signDirect(a,d) { return raw(a,d) } }',
])('rejects raw API usage: %s', (source) => {
  const file = ts.createSourceFile('example.ts', source, ts.ScriptTarget.Latest, true);
  expect(rawTransactionUsages(file)).not.toEqual([]);
});

it.each([
  'interface Signer { signAmino(address: string): void }',
  'type Signer = { signDirect: () => void }',
  'type signAmino = (address: string) => void',
  'function identity<signDirect>(value: signDirect) { return value }',
  'interface Signer extends ns.signDirect {}',
  'class Foo implements ns.signDirect {}',
  'class Foo extends Base<ns.signDirect> {}',
  'const Foo = class extends Base<ns.signDirect> {}',
  'const specialized = factory<ns.signDirect>',
  'const signer = value as ns.signDirect',
  'const signer = value satisfies ns.signDirect',
  "'signAmino' in signer",
  "Object.hasOwn(signer, 'signDirect')",
  'declare function signAmino(address: string): void',
  'declare class Signer { signDirect(address: string): void }',
  'abstract class Signer { abstract signDirect(address: string): void }',
  "import type { signDirect } from './types'",
  "import { type signDirect } from './types'",
  "export type { signDirect } from './types'",
  "export { type signDirect } from './types'",
  'signer.signAminoDocument(address, doc)',
  "export type * from '@manifest-network/manifest-sdk/chain'",
  "export { cosmosQuery } from '@manifest-network/manifest-sdk/chain'",
  "import { calculateFee } from '@cosmjs/stargate'",
])('allows types, narrowing checks and supported operations: %s', (source) => {
  const file = ts.createSourceFile('example.ts', source, ts.ScriptTarget.Latest, true);
  expect(rawTransactionUsages(file)).toEqual([]);
});
