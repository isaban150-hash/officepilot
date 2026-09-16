/**
 * DELIVERY-SHA256-GUARD-01A — der Anhangs-Hash des Dokumentversands läuft über
 * den kanonischen `digestSha256`-Helfer.
 *
 *  A  deterministisch: bekannter Input → bekannter SHA-256-Hex-Digest
 *  B  Fallback: ohne `crypto.subtle` (unsicherer Kontext) liefert `sha256Hex`
 *     denselben Digest statt mit TypeError zu scheitern
 *  C  Format unverändert: 64 Zeichen Hex, kleingeschrieben, identisch zum
 *     Dateihash-Pfad (`computeBufferContentHash`)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './documentDeliveryContract';
import { computeBufferContentHash } from '../documentFileHashService';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const PDF_HEAD = new TextEncoder().encode('%PDF-1.4 test');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DELIVERY-SHA256-GUARD-01A — sha256Hex', () => {
  it('A: liefert den bekannten SHA-256-Digest als Hex', async () => {
    await expect(sha256Hex(new TextEncoder().encode('abc'))).resolves.toBe(ABC_SHA256);
  });

  it('B: funktioniert ohne crypto.subtle (unsicherer Kontext) mit identischem Ergebnis', async () => {
    const expected = await sha256Hex(PDF_HEAD);
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto?.getRandomValues?.bind(globalThis.crypto) });
    expect(globalThis.crypto?.subtle).toBeUndefined();
    await expect(sha256Hex(PDF_HEAD)).resolves.toBe(expected);
    await expect(sha256Hex(new TextEncoder().encode('abc'))).resolves.toBe(ABC_SHA256);
  });

  it('C: Format bleibt 64 Hex-Zeichen und deckt sich mit dem Dateihash-Pfad', async () => {
    const hex = await sha256Hex(PDF_HEAD);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    await expect(computeBufferContentHash(PDF_HEAD)).resolves.toBe(hex);
  });
});
