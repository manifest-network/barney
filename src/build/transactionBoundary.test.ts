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

function rawTransactionAccesses(file: ts.SourceFile): string[] {
  const accesses: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTypeNode(node)
        || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
        || (ts.isExportDeclaration(node) && node.isTypeOnly)) return;
    let name: ts.Node | undefined;
    if (ts.isPropertyAccessExpression(node)) name = node.name;
    else if (ts.isElementAccessExpression(node)) name = node.argumentExpression;
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) name = node.expression;
    else if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && !node.isTypeOnly) {
      name = node.propertyName ?? node.name;
    } else if (ts.isBindingElement(node)) name = node.propertyName ?? node.name;
    if (name && ts.isComputedPropertyName(name)) name = name.expression;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && forbidden.has(name.text)) {
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
    return rawTransactionAccesses(file).map((name) => `${relative(src, path)}: ${name}`);
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
])('detects raw API access: %s', (source) => {
  const file = ts.createSourceFile('example.ts', source, ts.ScriptTarget.Latest, true);
  expect(rawTransactionAccesses(file)).not.toEqual([]);
});

it.each([
  'interface Signer { signAmino(address: string): void }',
  'type Signer = { signDirect: () => void }',
  'const handlers = { signAmino: callback }',
  "'signAmino' in signer",
  "import type { signDirect } from './types'",
  "import { type signDirect } from './types'",
  'fundCredits(ctx, { amount }, { signal })',
])('allows types, labels and supported operations: %s', (source) => {
  const file = ts.createSourceFile('example.ts', source, ts.ScriptTarget.Latest, true);
  expect(rawTransactionAccesses(file)).toEqual([]);
});
