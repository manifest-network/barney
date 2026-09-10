// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const imageSizePath = require.resolve('image-size');

// Decode in a disposable process: an unapplied/regressed patch must fail the
// test without trapping the Vitest worker in the upstream infinite loops.
function decode(input, checkFileApis = false) {
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', `
    const imageSize = require(process.argv[1]);
    const input = Buffer.from(process.argv[2], 'base64');
    const output = value => process.stdout.write(JSON.stringify(value));
    if (process.argv[3] === 'files') {
      const fs = require('node:fs');
      const path = require('node:path');
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'barney-image-size-'));
      const file = path.join(dir, 'pixel.png');
      try {
        fs.writeFileSync(file, input);
        const results = [imageSize(input), imageSize.imageSize(input), imageSize(file)];
        imageSize(file, (error, result) => {
          fs.rmSync(dir, { recursive: true, force: true });
          if (error) throw error;
          output([...results, result]);
        });
      } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    } else {
      try {
        output({ ok: true, dimensions: imageSize(input) });
      } catch (error) {
        output({ ok: false, message: error.message });
      }
    }
  `, imageSizePath, input.toString('base64'), checkFileApis ? 'files' : 'buffer'], {
    encoding: 'utf8',
    timeout: 2_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
  });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

function box(type, payload = Buffer.alloc(0), length = payload.length + 8) {
  const result = Buffer.alloc(payload.length + 8);
  result.writeUInt32BE(length, 0);
  result.write(type, 4, 'ascii');
  payload.copy(result, 8);
  return result;
}

function icns(entryLengths) {
  const result = Buffer.alloc(8 + entryLengths.length * 8);
  result.write('icns', 0, 'ascii');
  result.writeUInt32BE(result.length, 4);
  entryLengths.forEach((length, index) => {
    result.write('icp4', 8 + index * 8, 'ascii');
    result.writeUInt32BE(length, 12 + index * 8);
  });
  return result;
}

const jxlHeader = Buffer.concat([
  box('JXL ', Buffer.from([0x0d, 0x0a, 0x87, 0x0a])),
  box('ftyp', Buffer.from('jxl ', 'ascii')),
]);

describe('image-size advisory patches', () => {
  it.each([
    ['first zero-length ICNS entry', icns([0])],
    ['later zero-length ICNS entry', icns([8, 0])],
    ['undersized ICNS entry', icns([7])],
    ['truncated ICNS entry header', icns([8]).subarray(0, 15)],
    ['zero-length JXL partial box', Buffer.concat([jxlHeader, box('jxlp', Buffer.alloc(4), 0)])],
    ['undersized JXL partial box', Buffer.concat([jxlHeader, box('jxlp', Buffer.alloc(4), 7)])],
    ['zero-length HEIF metadata box', Buffer.concat([
      box('ftyp', Buffer.from('heic', 'ascii')),
      box('meta', Buffer.alloc(4), 0),
    ])],
  ])('rejects %s within a bounded child process', (_name, input) => {
    expect(decode(input)).toMatchObject({ ok: false });
  });

  it('preserves dimensions for an ICNS header and multiple entries', () => {
    expect(decode(icns([8]))).toMatchObject({
      ok: true, dimensions: { width: 16, height: 16, type: 'icp4' },
    });
    expect(decode(icns([8, 8]))).toMatchObject({
      ok: true, dimensions: { width: 16, height: 16, images: [
        { width: 16, height: 16 }, { width: 16, height: 16 },
      ] },
    });
  });

  it('preserves HEIF dimensions through nested nonempty boxes', () => {
    const size = Buffer.alloc(12);
    size.writeUInt32BE(2, 4);
    size.writeUInt32BE(3, 8);
    const image = Buffer.concat([
      box('ftyp', Buffer.from('heic', 'ascii')),
      box('meta', Buffer.concat([Buffer.alloc(4), box('iprp', box('ipco', box('ispe', size)))])),
    ]);
    expect(decode(image)).toEqual({ ok: true, dimensions: { width: 2, height: 3, type: 'heic' } });
  });

  it('preserves buffer, named, filename and callback APIs used by asset tooling', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSAAAAABJRU5ErkJggg==',
      'base64',
    );
    expect(decode(png, true)).toEqual(Array(4).fill({ width: 1, height: 1, type: 'png' }));
  });
});
