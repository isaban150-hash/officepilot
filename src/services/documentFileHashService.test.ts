import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeBufferContentHash,
  computeDataUrlContentHash,
  computeFileContentHash,
} from './documentFileHashService';
import { isSubtleDigestAvailable } from './sha256Digest';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('documentFileHashService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hashes empty input with the SHA-256 test vector', async () => {
    await expect(computeBufferContentHash(new Uint8Array(0))).resolves.toBe(EMPTY_SHA256);
  });

  it('hashes known bytes with the SHA-256 test vector', async () => {
    await expect(computeBufferContentHash(new TextEncoder().encode('abc'))).resolves.toBe(ABC_SHA256);
  });

  it('hashes Uint8Array views on shared buffers', async () => {
    const shared = new Uint8Array([0, 97, 98, 99, 0]);
    const view = shared.subarray(1, 4);
    await expect(computeBufferContentHash(view)).resolves.toBe(ABC_SHA256);
  });

  it('hashes files and data URLs consistently', async () => {
    const file = new File(['abc'], 'sample.txt', { type: 'text/plain' });
    const fileHash = await computeFileContentHash(file);
    const dataUrlHash = await computeDataUrlContentHash('data:text/plain;base64,YWJj');
    expect(fileHash).toBe(ABC_SHA256);
    expect(dataUrlHash).toBe(ABC_SHA256);
  });

  it('uses the pure JS fallback when crypto.subtle is unavailable', async () => {
    if (!globalThis.crypto) {
      await expect(computeBufferContentHash(new TextEncoder().encode('abc'))).resolves.toBe(ABC_SHA256);
      return;
    }

    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    });

    try {
      expect(isSubtleDigestAvailable()).toBe(false);
      await expect(computeBufferContentHash(new Uint8Array(0))).resolves.toBe(EMPTY_SHA256);
      await expect(computeBufferContentHash(new TextEncoder().encode('abc'))).resolves.toBe(ABC_SHA256);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it('uses the fallback when subtle.digest rejects the promise', async () => {
    if (!globalThis.crypto) return;

    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        subtle: {
          digest: () => Promise.reject(new Error('digest rejected')),
        },
      },
    });

    try {
      await expect(computeBufferContentHash(new TextEncoder().encode('abc'))).resolves.toBe(ABC_SHA256);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it('matches subtle and fallback digests for the same payload', async () => {
    if (!isSubtleDigestAvailable()) return;

    const payload = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128, 64, 32]);
    const subtleHash = await computeBufferContentHash(payload);

    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    });

    try {
      await expect(computeBufferContentHash(payload)).resolves.toBe(subtleHash);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });
});
