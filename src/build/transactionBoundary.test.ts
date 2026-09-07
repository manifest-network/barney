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

it('keeps raw transaction building, signing and broadcast APIs out of Barney product code', () => {
  const forbidden = new Set([
    'cosmosTx', 'executeTx', 'getSigningClient', 'getBroadcastClient',
    'signAndBroadcast', 'signAndBroadcastSync', 'broadcastTx', 'broadcastTxSync',
    'signDirect', 'signAmino',
  ]);
  const violations: string[] = [];
  for (const path of sourceFiles(src)) {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && forbidden.has(node.text)) {
        violations.push(`${relative(src, path)}: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(violations).toEqual([]);
});
