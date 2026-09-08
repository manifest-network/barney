// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const src = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

const forbidden = new Set([
  'cosmosTx', 'executeTx', 'getSigningClient', 'getBroadcastClient',
  'signAndBroadcast', 'signAndBroadcastSync', 'broadcastTx', 'broadcastTxSync',
  'signDirect', 'signAmino',
]);

function rawTransactionUsages(file: ts.SourceFile): string[] {
  const accesses: string[] = [];
  const visit = (node: ts.Node) => {
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
    if (ts.isIdentifier(node)) {
      if (forbidden.has(node.text)) accesses.push(node.text);
      return;
    }
    let name: ts.Node | undefined;
    if (ts.isElementAccessExpression(node)) name = node.argumentExpression;
    else if (ts.isPropertyAssignment(node)
        || ts.isMethodDeclaration(node)
        || ts.isPropertyDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node)) name = node.name;
    else if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
      name = node.propertyName ?? node.name;
    } else if (ts.isBindingElement(node)) name = node.propertyName ?? node.name;
    if (name && ts.isComputedPropertyName(name)) name = name.expression;
    if (name && ts.isStringLiteralLike(name) && forbidden.has(name.text)) {
      accesses.push(name.text);
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
  expect(violations).toEqual([]);
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
  "import type { signDirect } from './types'",
  "import { type signDirect } from './types'",
  "export type { signDirect } from './types'",
  "export { type signDirect } from './types'",
  'fundCredits(ctx, { amount }, { signal })',
])('allows types, narrowing checks and supported operations: %s', (source) => {
  const file = ts.createSourceFile('example.ts', source, ts.ScriptTarget.Latest, true);
  expect(rawTransactionUsages(file)).toEqual([]);
});
