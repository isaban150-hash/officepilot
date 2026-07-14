import { DI_SHADOW_OBSERVABILITY, getDiShadowObservabilityEnabled } from '../config/documentIntelligenceConfig';
import {
  assertNoForbiddenPersistenceContent,
  sanitizeDiClassificationShadowRecord,
  type DiClassificationShadowRecord,
} from '../types/documentShadowTypes';

export function getDiShadowLogStorageKey(): string {
  return DI_SHADOW_OBSERVABILITY.storageKey;
}

export function getDiShadowLogMaxEntries(): number {
  return DI_SHADOW_OBSERVABILITY.maxEntries;
}

export function readDiShadowLog(storage: Storage = localStorage): DiClassificationShadowRecord[] {
  try {
    const raw = storage.getItem(getDiShadowLogStorageKey());
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as DiClassificationShadowRecord[];
  } catch {
    return [];
  }
}

export function appendDiShadowRecord(
  record: DiClassificationShadowRecord,
  storage: Storage = localStorage,
): DiClassificationShadowRecord[] {
  if (!getDiShadowObservabilityEnabled()) {
    return readDiShadowLog(storage);
  }

  try {
    const sanitized = sanitizeDiClassificationShadowRecord(record);
    const serialized = JSON.stringify(sanitized);
    assertNoForbiddenPersistenceContent(serialized);

    const existing = readDiShadowLog(storage);
    const next = [...existing, sanitized];
    const capped = next.slice(Math.max(0, next.length - getDiShadowLogMaxEntries()));
    storage.setItem(getDiShadowLogStorageKey(), JSON.stringify(capped));
    return capped;
  } catch {
    return readDiShadowLog(storage);
  }
}

export function clearDiShadowLogForTests(storage: Storage = localStorage): void {
  try {
    storage.removeItem(getDiShadowLogStorageKey());
  } catch {
    // Ignore storage failures in tests.
  }
}
