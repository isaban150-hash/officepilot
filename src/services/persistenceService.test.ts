import { describe, expect, it, vi } from 'vitest';
import { createCompanyProfileFromSetup } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import {
  STORAGE_KEY,
  STORAGE_VERSION,
  clearPersistedState,
  createSeedState,
  loadPersistedState,
  savePersistedState,
} from './persistenceService';
import type { AppPersistedState } from '../types/models';

function minimalState(overrides: Partial<AppPersistedState> = {}): AppPersistedState {
  return {
    version: STORAGE_VERSION,
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

describe('savePersistedState + loadPersistedState', () => {
  it('roundtrips valid state', () => {
    const state = minimalState();
    savePersistedState(state);

    const loaded = loadPersistedState();
    expect(loaded).not.toBeNull();
    expect(loaded!.setup.companyName).toBe('Test GmbH');
    expect(loaded!.version).toBe(STORAGE_VERSION);
    expect(loaded!.inboxItems).toEqual([]);
  });
});

describe('loadPersistedState error handling', () => {
  it('returns null for corrupt JSON without throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not-json');
    expect(loadPersistedState()).toBeNull();
  });

  it('returns null for wrong version', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 99,
        setup: DEFAULT_SETUP,
        inboxItems: [],
        vorgaenge: [],
        tasks: [],
        savedAt: '2026-01-01',
      }),
    );

    expect(loadPersistedState()).toBeNull();
    warn.mockRestore();
  });

  it('returns null when storage is empty', () => {
    expect(loadPersistedState()).toBeNull();
  });
});

describe('clearPersistedState', () => {
  it('removes stored data', () => {
    savePersistedState(minimalState());
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    clearPersistedState();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('createSeedState', () => {
  it('produces valid persisted shape', () => {
    const seed = createSeedState();
    expect(seed.version).toBe(STORAGE_VERSION);
    expect(seed.inboxItems.length).toBeGreaterThan(0);
    expect(seed.vorgaenge.length).toBeGreaterThan(0);
    expect(seed.documents.length).toBeGreaterThan(0);
    expect(seed.expenses?.length).toBeGreaterThan(0);
  });
});

describe('expenses persistence', () => {
  it('roundtrips expenses in persisted state', () => {
    const state = minimalState({
      expenses: [
        {
          id: 'exp-test-1',
          status: 'gebucht',
          category: 'material',
          supplierName: 'Test Lieferant',
          invoiceNumber: 'R-1',
          title: 'Test Ausgabe',
          description: '',
          issueDate: '2026-03-01',
          paymentDueDate: null,
          taxStatus: 'standard_19',
          netAmount: 100,
          taxAmount: 19,
          grossAmount: 119,
          currency: 'EUR',
          paymentStatus: 'offen',
          positions: [],
          allocations: [],
          isCreditNote: false,
          dedupeKey: 'test lieferant|r-1',
          tags: [],
          digitalFolder: { id: 'dig-1', name: 'Ausgaben', path: '/Ausgaben/' },
          paperFolder: { folderId: 'folder-1', register: 'A', label: 'Test' },
          createdAt: '2026-03-01T10:00:00.000Z',
          updatedAt: '2026-03-01T10:00:00.000Z',
        },
      ],
    });
    savePersistedState(state);
    const loaded = loadPersistedState();
    expect(loaded?.expenses).toHaveLength(1);
    expect(loaded?.expenses?.[0].title).toBe('Test Ausgabe');
  });
});
