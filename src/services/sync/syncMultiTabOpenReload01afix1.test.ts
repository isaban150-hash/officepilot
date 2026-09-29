/**
 * SYNC-AUTOMATIK-01A-FIX1 — Befund B: Öffnen oder Neuladen eines zweiten Tabs
 * macht den ersten nicht zum veralteten.
 *
 * Browserbefund: Schon das blosse Öffnen von Tab B (oder das Neuladen von Tab
 * A) liess den jeweils anderen Tab melden „In einem anderen Tab wurde
 * inzwischen gespeichert" — ohne jede Benutzeränderung.
 *
 * Zwei Tabs werden hier echt nachgestellt: zwei vollständig getrennte
 * Modulinstanzen (`vi.resetModules`) mit eigenen Speichern, aber demselben
 * `localStorage` — genau wie zwei Browser-Tabs.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPersistedState, Customer } from '../../types/models';

const WORKSPACE = 'ws-tabs-01afix1';
const USER = 'user-tabs-01afix1';

type Tab = Awaited<ReturnType<typeof openTab>>;

/** Ein neuer Tab: frische Module, eigener Arbeitsspeicher, gemeinsamer localStorage. */
async function openTab() {
  vi.resetModules();
  const persistence = await import('../persistenceService');
  const bootstrap = await import('../storage/storageBootstrapService');
  const scope = await import('../storage/storageScopeService');
  const customers = await import('../customerService');
  const customerStore = await import('../customerStoreService');
  const syncClient = await import('./syncClientService');
  const pullPersist = await import('./syncPullPersistService');
  const health = await import('../persistenceHealthService');

  syncClient.hydrateSyncClient({ ...syncClient.createSyncClient(), workspaceId: WORKSPACE });
  const loaded = bootstrap.bootstrapBusinessState({ userId: USER, workspaceId: WORKSPACE });
  expect(loaded.loadFailed).not.toBe(true);
  // Was ein Tab beim Start ohnehin tut: einmal speichern (Nacharbeiten, Bootstrap).
  persistence.persistAll();

  return {
    persistence,
    scope,
    customers,
    customerStore,
    pullPersist,
    health,
    save(name: string) {
      return customers.createCustomer({ name, street: 'Beispielweg 1', zip: '20000', city: 'Beispielstadt' });
    },
    /** Neuladen: derselbe Tab liest den Bestand neu ein. */
    reload() {
      bootstrap.bootstrapBusinessState({ userId: USER, workspaceId: WORKSPACE });
      persistence.persistAll();
    },
  };
}

function stored(tab: Tab): AppPersistedState & { businessRevision?: number } {
  return JSON.parse(localStorage.getItem(tab.scope.getActiveStorageKey())!) as AppPersistedState & {
    businessRevision?: number;
  };
}

function storedNames(tab: Tab): string[] {
  return (stored(tab).customers ?? []).map((customer) => customer.name);
}

// Jeder Tab lädt den vollständigen Modulgraphen neu — unter Last dauert das.
describe('SYNC-AUTOMATIK-01A-FIX1 — Öffnen/Neuladen sperrt keinen anderen Tab', { timeout: 60_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
  }, 60_000);

  afterEach(() => {
    vi.resetModules();
  });

  it('1–4: Tab B öffnet denselben Workspace ohne Änderung → Tab A speichert weiter', async () => {
    const tabA = await openTab();
    expect(tabA.save('Beispiel Vorher GmbH').success).toBe(true);
    const generation = stored(tabA).businessRevision;

    await openTab();
    expect(stored(tabA).businessRevision).toBe(generation);

    const result = tabA.save('Beispiel A nach Öffnen von B GmbH');
    expect(result.success).toBe(true);
    expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(false);
    expect(storedNames(tabA)).toContain('Beispiel A nach Öffnen von B GmbH');
  });

  it('5–6: Tab B lädt neu ohne Änderung → Tab A speichert weiter', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    tabB.reload();
    tabB.reload();
    expect(tabA.save('Beispiel A nach Reload von B GmbH').success).toBe(true);
    expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(false);
  });

  it('das storage-Ereignis eines bloss geöffneten Tabs meldet keinen veralteten Stand', async () => {
    const tabA = await openTab();
    const stop = tabA.persistence.watchOtherTabWrites();
    try {
      const tabB = await openTab();
      window.dispatchEvent(new StorageEvent('storage', { key: tabB.scope.getActiveStorageKey() }));
      expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(false);
      expect(tabA.health.getPersistenceHealthSnapshot().staleTab).not.toBe(true);
    } finally {
      stop();
    }
  });

  it('7–9: echter Save in Tab B → Tab A wird sicher blockiert, nichts überschrieben', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const stop = tabA.persistence.watchOtherTabWrites();
    try {
      expect(tabB.save('Beispiel aus Tab B GmbH').success).toBe(true);
      window.dispatchEvent(new StorageEvent('storage', { key: tabB.scope.getActiveStorageKey() }));
      // Sofort sichtbar, nicht erst beim nächsten Speicherversuch.
      expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(true);
      expect(tabA.health.getPersistenceHealthSnapshot()).toMatchObject({ hasFailure: true, staleTab: true });

      const result = tabA.save('Beispiel veralteter Tab A GmbH');
      expect(result.success).toBe(false);
      // Nicht still: die Ablehnung kommt beim Aufrufer an (Formular bleibt offen, Hinweis).
      if (!result.success) expect(result.errorKey).toBe('customer.persistFailed');
      expect(storedNames(tabA)).toContain('Beispiel aus Tab B GmbH');
      expect(storedNames(tabA)).not.toContain('Beispiel veralteter Tab A GmbH');
      expect(tabA.persistence.persistSyncOutboxNow()).toBe(false);
      expect(storedNames(tabA)).toContain('Beispiel aus Tab B GmbH');
    } finally {
      stop();
    }
  });

  it('10: reiner Bootstrap (gleicher Zustand angewendet) invalidiert keinen anderen Tab', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const generation = stored(tabA).businessRevision;
    tabB.persistence.applyPersistedStateFromSync(tabB.persistence.buildPersistedStateSnapshot());
    expect(stored(tabA).businessRevision).toBe(generation);
    expect(tabA.save('Beispiel nach Bootstrap GmbH').success).toBe(true);
  });

  it('11: reines Sync-Metadaten-Update (Serverversion, Sendeauftrag) invalidiert keinen Tab', async () => {
    const tabA = await openTab();
    expect(tabA.save('Beispiel Kunde GmbH').success).toBe(true);
    const tabB = await openTab();
    const generation = stored(tabA).businessRevision;

    // Tab B übernimmt ein Ergebnis, das nur Versionen und Auftragsstatus ändert.
    const snapshot = tabB.persistence.buildPersistedStateSnapshot();
    const candidate: AppPersistedState = {
      ...snapshot,
      customers: (snapshot.customers ?? []).map(
        (customer) =>
          ({
            ...customer,
            sync: { version: 7, updatedAt: '2026-09-26T11:00:00.000Z', deleted: false, deviceId: 'dev-b', workspaceId: WORKSPACE },
          }) as Customer,
      ),
      syncOutbox: (snapshot.syncOutbox ?? []).map((entry) => ({ ...entry, status: 'completed' as const })),
    };
    const applied = tabB.pullPersist.applySyncPullCandidateSafely({
      state: candidate,
      report: { ...({} as never), errors: [], errorCount: 0, conflicts: [], conflictCount: 0 },
    });
    expect(applied.persisted).toBe(true);
    expect(stored(tabA).businessRevision).toBe(generation);
    expect(tabB.persistence.persistSyncOutboxNow()).toBe(true);
    expect(stored(tabA).businessRevision).toBe(generation);

    expect(tabA.save('Beispiel A danach GmbH').success).toBe(true);
  });

  it('12: ein echter fachlicher Cloud-Stand in Tab B bleibt gegen Tab A geschützt', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const snapshot = tabB.persistence.buildPersistedStateSnapshot();
    const candidate: AppPersistedState = {
      ...snapshot,
      customers: [
        ...(snapshot.customers ?? []),
        { id: 'c-cloud-01afix1', name: 'Aus der Cloud GmbH', createdAt: '2026-09-26T11:00:00.000Z' } as Customer,
      ],
    };
    tabB.pullPersist.applySyncPullCandidateSafely({
      state: candidate,
      report: { ...({} as never), errors: [], errorCount: 0, conflicts: [], conflictCount: 0 },
    });
    expect(tabA.save('Beispiel veraltet GmbH').success).toBe(false);
    expect(storedNames(tabA)).toContain('Aus der Cloud GmbH');
  });

  it('Neuladen von Tab A selbst macht Tab B nicht veraltet', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    tabA.reload();
    expect(tabB.save('Beispiel B nach Reload von A GmbH').success).toBe(true);
    // Und umgekehrt: Tab A hat danach den echten Save von B nicht gesehen → blockiert.
    expect(tabA.save('Beispiel A veraltet GmbH').success).toBe(false);
  });
});
