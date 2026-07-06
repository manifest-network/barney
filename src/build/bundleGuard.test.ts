import { describe, it, expect } from 'vitest';
import { hasMcpNeedle, copyRoots } from '../../scripts/check-bundle.mjs';

describe('check-bundle guards', () => {
  it('flags the MCP-sdk package specifier', () => {
    expect(hasMcpNeedle('x=require("@modelcontextprotocol/sdk/server/mcp.js")')).toBe(true);
  });

  it('flags co-occurring MCP protocol-version date literals', () => {
    expect(hasMcpNeedle('const v=["2025-11-25","2025-06-18","2024-10-07"]')).toBe(true);
  });

  it('passes clean chunks (incl. an isolated date literal)', () => {
    expect(hasMcpNeedle('const a=1;export default a;')).toBe(false);
    expect(hasMcpNeedle('build date "2024-10-07" only')).toBe(false);
  });

  it('collapses one copy to a single root', () => {
    const names = [
      './node_modules/@manifest-network/manifest-mcp-core/dist/index.js',
      './node_modules/@manifest-network/manifest-mcp-core/dist/reads.js',
    ];
    expect(copyRoots(names, 'manifest-mcp-core').size).toBe(1);
  });

  it('detects two distinct copies (nested dedupe failure)', () => {
    const names = [
      './node_modules/@manifest-network/manifest-mcp-core/dist/index.js',
      './node_modules/@manifest-network/manifest-mcp-fred/node_modules/@manifest-network/manifest-mcp-core/dist/index.js',
    ];
    expect(copyRoots(names, 'manifest-mcp-core').size).toBe(2);
  });

  it('collapses name/identifier/absolute representations of one copy to a single root', () => {
    // Regression: rspack emits the same physical module as a relative name, a
    // bare-absolute identifier, AND a loader-prefixed identifier. copyRoots must
    // treat all three as ONE copy (the real-bundle false-positive the clean-relative
    // fixtures never exercised).
    const abs = `${process.cwd()}/node_modules/@manifest-network/manifest-mcp-core`;
    const names = [
      './node_modules/@manifest-network/manifest-mcp-core/dist/index.js',
      `${abs}/dist/reads.js`,
      `javascript/esm|${abs}/dist/deploy.js`,
      // rspack's real two-pipe identifier: `<loader>|<abspath>|<hash>`. The old
      // lastIndexOf('|') strip yielded the hash and broke canonicalization.
      `javascript/esm|${abs}/dist/deploy.js|9f2ab1c`,
    ];
    expect(copyRoots(names, 'manifest-mcp-core').size).toBe(1);
  });
});
