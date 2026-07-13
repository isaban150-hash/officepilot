import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestSha256, isSubtleDigestAvailable, sha256Bytes } from './sha256Digest';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function listSourceFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('sha256Bytes', () => {
  it('matches the empty SHA-256 test vector', () => {
    expect(toHex(sha256Bytes(new Uint8Array(0)).buffer)).toBe(EMPTY_SHA256);
  });

  it('matches the abc SHA-256 test vector', () => {
    expect(toHex(sha256Bytes(new TextEncoder().encode('abc')).buffer)).toBe(ABC_SHA256);
  });

  it('hashes Uint8Array views on shared buffers', () => {
    const shared = new Uint8Array([0, 97, 98, 99, 0]);
    expect(toHex(sha256Bytes(shared.subarray(1, 4)).buffer)).toBe(ABC_SHA256);
  });
});

describe('digestSha256', () => {
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    });
    vi.restoreAllMocks();
  });

  it('uses the fallback when globalThis.crypto is missing', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
    });

    await expect(digestSha256(new TextEncoder().encode('abc'))).resolves.toSatisfy(
      (buffer: ArrayBuffer) => toHex(buffer) === ABC_SHA256,
    );
  });

  it('uses the fallback when crypto.subtle is missing', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    });

    await expect(digestSha256(new Uint8Array(0))).resolves.toSatisfy(
      (buffer: ArrayBuffer) => toHex(buffer) === EMPTY_SHA256,
    );
  });

  it('uses the fallback when subtle.digest is missing', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { subtle: {} },
    });

    await expect(digestSha256(new TextEncoder().encode('abc'))).resolves.toSatisfy(
      (buffer: ArrayBuffer) => toHex(buffer) === ABC_SHA256,
    );
  });

  it('uses the fallback when subtle.digest throws synchronously', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        subtle: {
          digest: () => {
            throw new TypeError('subtle unavailable');
          },
        },
      },
    });

    await expect(digestSha256(new TextEncoder().encode('abc'))).resolves.toSatisfy(
      (buffer: ArrayBuffer) => toHex(buffer) === ABC_SHA256,
    );
  });

  it('uses the fallback when subtle.digest rejects the promise', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        subtle: {
          digest: () => Promise.reject(new Error('digest rejected')),
        },
      },
    });

    await expect(digestSha256(new TextEncoder().encode('abc'))).resolves.toSatisfy(
      (buffer: ArrayBuffer) => toHex(buffer) === ABC_SHA256,
    );
  });

  it('uses the native digest when subtle.digest works', async () => {
    if (!isSubtleDigestAvailable()) return;

    const payload = new TextEncoder().encode('abc');
    const native = await originalCrypto.subtle.digest('SHA-256', payload);
    await expect(digestSha256(payload)).resolves.toSatisfy(
      (buffer: ArrayBuffer) => toHex(buffer) === toHex(native),
    );
  });
});

describe('sha256 digest usage guard', () => {
  it('has no direct crypto.subtle.digest or subtle.digest calls outside sha256Digest.ts', () => {
    const srcRoot = join(process.cwd(), 'src');
    const offenders = listSourceFiles(srcRoot).flatMap((filePath) => {
      if (filePath.endsWith('sha256Digest.ts')) return [];
      const content = readFileSync(filePath, 'utf8');
      const matches: string[] = [];
      if (content.includes('crypto.subtle.digest')) {
        matches.push(`${filePath}: crypto.subtle.digest`);
      }
      if (/(?<!\?)subtle\.digest/.test(content)) {
        matches.push(`${filePath}: subtle.digest`);
      }
      return matches;
    });

    expect(offenders).toEqual([]);
  });
});
