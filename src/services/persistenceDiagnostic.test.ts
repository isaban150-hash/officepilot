import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompanyProfileFromSetup } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import {
  STORAGE_VERSION,
  applyStateToStores,
  buildPersistedStateSnapshot,
  getLastPersistFailure,
  getPersistFailureDiagnosticForDev,
  isPersistDiagnosticEnabled,
  persistAll,
  resetLastPersistFailureForTests,
  savePersistedStateToKey,
  setActiveStorageScope,
  setPersistDiagnosticEnabledForTests,
} from './persistenceService';
import { createSyncClient } from './sync/syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './sync/syncOutboxService';
import {
  resetSyncChangeTrackerForTests,
  trackPersistedChanges,
} from './sync/syncChangeTrackerService';
import type { AppPersistedState } from '../types/models';
import { hydrateInboxStore } from './inboxService';

function minimalState(overrides: Partial<AppPersistedState> = {}): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: client,
    syncOutbox: [],
    setup: { ...DEFAULT_SETUP, companyName: 'Test GmbH' },
    companyProfile: createCompanyProfileFromSetup({ ...DEFAULT_SETUP, companyName: 'Test GmbH' }),
    invoiceNumberSequence: { year: 2026, lastIssuedNumber: 0 },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    savedAt: '2026-03-27T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  resetLastPersistFailureForTests();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MOBILE-PERSIST-DIAG-01 persistence diagnostics', () => {
  it('classifies JSON.stringify failure as serialization_failed', () => {
    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new TypeError('circular structure');
    });

    const result = savePersistedStateToKey({ type: 'guest' }, minimalState());

    expect(result.success).toBe(false);
    expect(result.failure?.reason).toBe('serialization_failed');
    expect(result.failure?.diagnostic?.phase).toBe('json_stringify');
    expect(result.failure?.diagnostic?.errorName).toBe('TypeError');
    stringifySpy.mockRestore();
  });

  it('classifies QuotaExceededError as quota_exceeded', () => {
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    const result = savePersistedStateToKey({ type: 'guest' }, minimalState());

    expect(result.success).toBe(false);
    expect(result.failure?.reason).toBe('quota_exceeded');
    expect(result.failure?.diagnostic?.phase).toBe('localStorage_setItem');
    expect(result.failure?.diagnostic?.errorName).toBe('QuotaExceededError');
    setItemSpy.mockRestore();
  });

  it('classifies storage SecurityError as storage_unavailable', () => {
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('storage blocked', 'SecurityError');
    });

    const result = savePersistedStateToKey({ type: 'guest' }, minimalState());

    expect(result.success).toBe(false);
    expect(result.failure?.reason).toBe('storage_unavailable');
    expect(result.failure?.diagnostic?.phase).toBe('localStorage_setItem');
    setItemSpy.mockRestore();
  });

  it('classifies unavailable storage as storage_unavailable', () => {
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new ReferenceError('localStorage is not defined');
    });

    const result = savePersistedStateToKey({ type: 'guest' }, minimalState());

    expect(result.success).toBe(false);
    expect(result.failure?.reason).toBe('storage_unavailable');
    setItemSpy.mockRestore();
  });

  it('diagnostic contains no document base64 or OCR payload fragments', () => {
    const secretBlob = 'data:image/jpeg;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg==';
    const ocrSnippet = 'AOK Beitragsbescheid 250,00 EUR Frist 15.08.2026';

    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    const result = savePersistedStateToKey(
      { type: 'guest' },
      minimalState({
        documentFileBlobs: { 'blob-1': secretBlob },
        inboxItems: [
          {
            id: 'inbox-1',
            title: 'Test',
            status: 'neu',
            priority: 'mittel',
            kind: 'bg_bau',
            digitalFolder: { id: 'dig-1', name: 'Eingang', path: '/Eingang/' },
            paperFiling: { folderId: 'folder-1', register: 'A', label: 'Test' },
            recognizedData: { text: ocrSnippet },
            createdAt: '2026-03-27T12:00:00.000Z',
            updatedAt: '2026-03-27T12:00:00.000Z',
          },
        ],
      }),
    );

    const diagnosticJson = JSON.stringify(result.failure?.diagnostic ?? {});
    expect(diagnosticJson).not.toContain('base64');
    expect(diagnosticJson).not.toContain('AOK');
    expect(diagnosticJson).not.toContain('QUJD');
    setItemSpy.mockRestore();
  });

  it('truncates error messages to 200 characters', () => {
    const longMessage = 'x'.repeat(300);
    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error(longMessage);
    });

    const result = savePersistedStateToKey({ type: 'guest' }, minimalState());

    expect(result.failure?.diagnostic?.errorMessage).toHaveLength(200);
    stringifySpy.mockRestore();
  });

  it('records payload size and storage key in diagnostic', () => {
    localStorage.setItem('officepilot-state:guest', '{"seed":true}');
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    const result = savePersistedStateToKey({ type: 'guest' }, minimalState());

    expect(result.failure?.diagnostic?.storageKey).toBe('officepilot-state:guest');
    expect(result.failure?.diagnostic?.payloadCharacters).toBeGreaterThan(0);
    expect(result.failure?.diagnostic?.payloadBytesApprox).toBeGreaterThan(0);
    expect(result.failure?.diagnostic?.existingStoredCharacters).toBe('{"seed":true}'.length);
    setItemSpy.mockRestore();
  });

  it('persistAll rolls back sync outbox changes when save fails', () => {
    applyStateToStores(minimalState());
    resetSyncChangeTrackerForTests();
    resetSyncOutboxForTests([]);
    trackPersistedChanges(buildPersistedStateSnapshot());
    const outboxBefore = getSyncOutboxSnapshot();

    hydrateInboxStore([
      {
        id: 'inbox-new',
        title: 'Neu',
        status: 'neu',
        priority: 'mittel',
        kind: 'bg_bau',
        digitalFolder: { id: 'dig-1', name: 'Eingang', path: '/Eingang/' },
        paperFiling: { folderId: 'folder-1', register: 'A', label: 'Test' },
        recognizedData: {},
        createdAt: '2026-03-27T12:00:00.000Z',
        updatedAt: '2026-03-27T12:00:00.000Z',
      },
    ]);

    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    const result = persistAll();

    expect(result.success).toBe(false);
    expect(getSyncOutboxSnapshot()).toEqual(outboxBefore);
    setItemSpy.mockRestore();
  });

  it('exposes diagnostic through getLastPersistFailure after persistAll failure', () => {
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    applyStateToStores(minimalState());
    persistAll();

    expect(getLastPersistFailure()?.reason).toBe('quota_exceeded');
    expect(getPersistFailureDiagnosticForDev()?.phase).toBe('localStorage_setItem');
    setItemSpy.mockRestore();
  });

  it('isPersistDiagnosticEnabled is true in test mode', () => {
    expect(isPersistDiagnosticEnabled()).toBe(true);
  });
});

describe('MOBILE-PERSIST-DIAG-01 production diagnostic gate', () => {
  it('does not expose diagnostic when diagnostic mode is disabled', () => {
    setPersistDiagnosticEnabledForTests(false);

    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    const result = savePersistedStateToKey({ type: 'guest' }, minimalState());

    expect(result.failure?.reason).toBe('quota_exceeded');
    expect(result.failure?.diagnostic).toBeUndefined();
    expect(getPersistFailureDiagnosticForDev()).toBeNull();

    setItemSpy.mockRestore();
  });
});
