import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistenceFailureBanner } from '../components/system/PersistenceFailureBanner';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import {
  persistAll,
  resetLastPersistFailureForTests,
} from './persistenceService';
import {
  getPersistenceHealthSnapshot,
  notifyPersistenceHealthChanged,
  resetPersistenceHealthForTests,
  subscribePersistenceHealth,
} from './persistenceHealthService';
import { resetTestStores } from '../test/resetStores';

describe('persistence health + banner', () => {
  beforeEach(() => {
    resetTestStores();
    resetLastPersistFailureForTests();
    resetPersistenceHealthForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('failed persistAll surfaces global banner without raw errors', async () => {
    const listeners: string[] = [];
    const unsubscribe = subscribePersistenceHealth((snap) => {
      listeners.push(snap.hasFailure ? 'fail' : 'ok');
    });

    const setItem = vi.fn(() => {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });

    const result = persistAll();
    expect(result.success).toBe(false);
    expect(setItem).toHaveBeenCalled();
    expect(getPersistenceHealthSnapshot().hasFailure).toBe(true);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
            <PersistenceFailureBanner />
          </AppProvider>
        </MemoryRouter>,
      );
    });

    const banner = container.querySelector('[data-testid="persistence-failure-banner"]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toMatch(/Speichern fehlgeschlagen|Browserspeicher|Datensicherung/i);
    expect(banner?.textContent).not.toMatch(/QuotaExceeded|stack|indexeddb/i);
    expect(
      (container.querySelector('[data-testid="persistence-failure-backup-link"]') as HTMLAnchorElement)
        .getAttribute('href'),
    ).toBe('/firmendaten#datensicherung');
    expect(listeners).toContain('fail');

    await act(async () => {
      root.unmount();
    });
    container.remove();
    unsubscribe();
  });

  it('later successful persist clears failure state and banner', async () => {
    const failingSetItem = vi.fn(() => {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: failingSetItem,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });
    expect(persistAll().success).toBe(false);
    expect(getPersistenceHealthSnapshot().hasFailure).toBe(true);

    vi.unstubAllGlobals();
    expect(persistAll().success).toBe(true);
    expect(getPersistenceHealthSnapshot().hasFailure).toBe(false);

    // Explicit notify already happened; banner should be hidden
    notifyPersistenceHealthChanged({ healthy: true, hasFailure: false });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
            <PersistenceFailureBanner />
          </AppProvider>
        </MemoryRouter>,
      );
    });
    expect(container.querySelector('[data-testid="persistence-failure-banner"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
