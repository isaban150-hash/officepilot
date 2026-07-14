import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DI_SHADOW_OBSERVABILITY,
  setDiShadowObservabilityEnabledForTests,
} from '../config/documentIntelligenceConfig';
import {
  appendDiShadowRecord,
  clearDiShadowLogForTests,
  getDiShadowLogMaxEntries,
  readDiShadowLog,
} from './documentShadowPersistenceService';
import type { DiClassificationShadowRecord } from '../types/documentShadowTypes';

function buildSampleRecord(overrides: Partial<DiClassificationShadowRecord> = {}): DiClassificationShadowRecord {
  return {
    observedAt: '2026-07-14T12:00:00.000Z',
    documentFingerprint: 'abc123',
    productiveKind: 'tankbeleg',
    productiveReasonKey: 'classification.detect.diReceiptScoring',
    cutoverApplied: true,
    cutoverLane: 'receipt',
    legacyKind: 'tankbeleg',
    legacyReasonKey: 'classification.detect.tankbeleg',
    globalWinnerKind: 'tankbeleg',
    globalMargin: 0.42,
    globalConfidence: 0.91,
    laneEvaluations: [
      {
        lane: 'receipt',
        eligible: true,
        winnerKind: 'tankbeleg',
        laneMargin: 0.42,
        laneConfidence: 0.91,
        evidenceRefCount: 4,
      },
    ],
    ocrQualityScore: 0.8,
    ocrReadable: true,
    conflictTypes: [],
    warningCodes: [],
    mismatchType: 'none',
    ...overrides,
  };
}

describe('documentShadowPersistenceService', () => {
  const storage = {
    store: new Map<string, string>(),
    getItem(key: string) {
      return this.store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      this.store.set(key, value);
    },
    removeItem(key: string) {
      this.store.delete(key);
    },
  } as Storage;

  afterEach(() => {
    clearDiShadowLogForTests(storage);
    setDiShadowObservabilityEnabledForTests(null);
  });

  it('appends sanitized records to the configured storage key', () => {
    setDiShadowObservabilityEnabledForTests(true);
    appendDiShadowRecord(buildSampleRecord(), storage);

    const entries = readDiShadowLog(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.productiveKind).toBe('tankbeleg');
    expect(storage.getItem(DI_SHADOW_OBSERVABILITY.storageKey)).toBeTruthy();
  });

  it('caps the ring buffer at 100 entries', () => {
    setDiShadowObservabilityEnabledForTests(true);
    const maxEntries = getDiShadowLogMaxEntries();
    expect(maxEntries).toBe(100);

    for (let index = 0; index < maxEntries + 5; index += 1) {
      appendDiShadowRecord(
        buildSampleRecord({
          observedAt: `2026-07-14T12:00:${String(index).padStart(2, '0')}.000Z`,
        }),
        storage,
      );
    }

    const entries = readDiShadowLog(storage);
    expect(entries).toHaveLength(maxEntries);
    expect(entries[0]?.observedAt).toBe('2026-07-14T12:00:05.000Z');
    expect(entries.at(-1)?.observedAt).toBe('2026-07-14T12:00:104.000Z');
  });

  it('does not persist when the feature flag is disabled', () => {
    setDiShadowObservabilityEnabledForTests(false);
    appendDiShadowRecord(buildSampleRecord(), storage);
    expect(readDiShadowLog(storage)).toHaveLength(0);
  });

  it('swallows localStorage failures without throwing', () => {
    setDiShadowObservabilityEnabledForTests(true);
    const failingStorage = {
      getItem: () => {
        throw new Error('storage read failed');
      },
      setItem: () => {
        throw new Error('storage write failed');
      },
      removeItem: () => undefined,
    } as Storage;

    expect(() => appendDiShadowRecord(buildSampleRecord(), failingStorage)).not.toThrow();
    expect(readDiShadowLog(failingStorage)).toEqual([]);
  });

  it('rejects persistence when forbidden content patterns are detected', () => {
    setDiShadowObservabilityEnabledForTests(true);
    appendDiShadowRecord(
      buildSampleRecord({
        warningCodes: ['contains IBAN DE89370400440532013000'],
      }),
      storage,
    );

    expect(readDiShadowLog(storage)).toHaveLength(0);
  });
});
