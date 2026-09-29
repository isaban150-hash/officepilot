/**
 * SYNC-AUTOMATIK-01A-FIX3 — technischer Schreibvorgang ≠ fachliche Revision.
 *
 * Browserbefund nach FIX2: Beim blossen Öffnen von Tab B wurde der Bestand
 * technisch neu geschrieben (neues `savedAt`, neues `writeGeneration`), der
 * separate Schlüssel `officetakt-state-generation:…` blieb unverändert — und
 * Tab A blockierte trotzdem seinen nächsten Save.
 *
 * Ursache im Code: Bis FIX2 trug `writeGeneration` die Rolle der fachlichen
 * Generation und war zugleich das, was der Schutz verglich. Der separate
 * Schlüssel stammt aus einem frühen 01A-Stand und wird von keinem Code mehr
 * gelesen oder geschrieben. Jetzt: `businessRevision` (fachlich, allein
 * massgeblich) und `writeGeneration` (technisch, zählt jeden Schreibvorgang).
 *
 * Die Tabs laufen durch den echten Anmelde-Start (Cloud-Bootstrap), zwei
 * getrennte Modulinstanzen, gemeinsamer `localStorage`.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPersistedState } from '../../types/models';
import { createMultiTabCloudHarness } from '../../test/multiTabCloudHarness';

const harness = createMultiTabCloudHarness({ userId: 'tabs-fix3-user', workspaceId: 'tabs-fix3-ws' });
const LEGACY_SEPARATE_KEY = `officetakt-state-generation:${harness.storageKey}`;

/** Ein anderer Tab schreibt technisch neu: neuer Zeitstempel, neuer Schreibzähler, gleicher Inhalt. */
function technicalRewriteByOtherTab(): void {
  const stored = JSON.parse(localStorage.getItem(harness.storageKey)!) as AppPersistedState & {
    businessRevision: number;
    writeGeneration: number;
  };
  const { businessRevision, writeGeneration, ...rest } = stored;
  localStorage.setItem(
    harness.storageKey,
    JSON.stringify({ businessRevision, writeGeneration: writeGeneration + 50, ...rest, savedAt: '2026-09-26T18:00:00.000Z' }),
  );
}

// Jeder Tab lädt den vollständigen Modulgraphen neu — unter Last dauert das.
describe('SYNC-AUTOMATIK-01A-FIX3 — nur die fachliche Revision sperrt einen Tab', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    localStorage.clear();
    harness.reset();
    // Vorgeschichte: Betrieb eingerichtet, ein Kunde angelegt und synchronisiert.
    const setupTab = await harness.openTab();
    expect(setupTab.save('Beispiel Bestandskunde GmbH').success).toBe(true);
    await setupTab.syncUi.runSyncFromUi();
  }, 60_000);

  afterEach(() => {
    harness.clear();
    vi.resetModules();
  });

  it('TEST A (Browserbefund): Tab B öffnet → technischer Write, fachliche Revision gleich, separater Schlüssel unverändert → Tab A speichert', async () => {
    // Der Altschlüssel aus dem frühen 01A-Stand, wie im Browser vorgefunden.
    localStorage.setItem(LEGACY_SEPARATE_KEY, '17');
    const tabA = await harness.openTab();
    const before = harness.header();
    expect(before.businessRevision).toBeDefined();

    const tabB = await harness.openTab();
    const after = harness.header();

    // Genau das Bild aus dem Browser: technisch neu geschrieben …
    expect(after.writeGeneration).toBeGreaterThan(before.writeGeneration!);
    expect(after.savedAt).not.toBe(before.savedAt);
    // … separater Schlüssel unverändert, fachliche Revision unverändert …
    expect(localStorage.getItem(LEGACY_SEPARATE_KEY)).toBe('17');
    expect(after.businessRevision).toBe(before.businessRevision);
    // … und Tab B hat beim Öffnen keine fachliche Änderung am Workspace-Bestand festgestellt.
    const change = tabB.persistence.getLastBusinessRevisionChange();
    expect(change === null || change.storageKey !== harness.storageKey).toBe(true);

    // Tab A bleibt schreibfähig.
    expect(tabA.save('Beispiel nach Öffnen von B GmbH').success).toBe(true);
    expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(false);
    expect(harness.storedCustomerNames()).toContain('Beispiel nach Öffnen von B GmbH');
  });

  it('TEST B: Tab B lädt neu ohne Änderung → fachliche Revision bleibt, Tab A speichert', async () => {
    const tabA = await harness.openTab();
    const before = harness.header();
    await harness.openTab();
    await harness.openTab();
    expect(harness.header().businessRevision).toBe(before.businessRevision);
    expect(tabA.save('Beispiel nach Reload von B GmbH').success).toBe(true);
  });

  it('TEST C: mehrere rein technische Writes in Tab B → fachliche Revision bleibt, Tab A schreibfähig', async () => {
    const tabA = await harness.openTab();
    const tabB = await harness.openTab();
    const before = harness.header();

    expect(tabB.persistence.persistSyncOutboxNow()).toBe(true);
    expect(tabB.persistence.persistAll().success).toBe(true);
    tabB.persistence.applyPersistedStateFromSync(tabB.persistence.buildPersistedStateSnapshot());
    expect(tabB.persistence.persistAll().success).toBe(true);

    const after = harness.header();
    expect(after.businessRevision).toBe(before.businessRevision);
    expect(after.writeGeneration).toBe(before.writeGeneration! + 4);
    expect(tabA.save('Beispiel nach technischen Writes GmbH').success).toBe(true);
  });

  it('TEST D: echter fachlicher Save in Tab B → N+1, Tab A wird blockiert, nichts überschrieben', async () => {
    const tabA = await harness.openTab();
    const tabB = await harness.openTab();
    const n = harness.header().businessRevision!;

    expect(tabB.save('Beispiel aus Tab B GmbH').success).toBe(true);
    expect(harness.header().businessRevision).toBe(n + 1);
    expect(tabB.persistence.getLastBusinessRevisionChange()).toMatchObject({
      storageKey: harness.storageKey,
      businessRevision: n + 1,
      source: 'save',
      areas: ['customers'],
    });

    const result = tabA.save('Beispiel veralteter Tab A GmbH');
    expect(result.success).toBe(false);
    expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(true);
    expect(harness.storedCustomerNames()).toContain('Beispiel aus Tab B GmbH');
    expect(harness.storedCustomerNames()).not.toContain('Beispiel veralteter Tab A GmbH');
  });

  it('TEST E: Tab B übernimmt echten neuen Cloud-Inhalt → fachliche Revision steigt, Tab A blockiert', async () => {
    const tabA = await harness.openTab();
    const tabB = await harness.openTab();
    const n = harness.header().businessRevision!;
    for (const [id, row] of harness.cloud.customers) {
      const inner = row.payload.payload as Record<string, unknown>;
      harness.cloud.customers.set(id, {
        ...row,
        payload: { ...row.payload, payload: { ...inner, name: 'Beispiel Umbenannt GmbH' } },
        row_version: row.row_version + 1,
      });
    }
    await tabB.syncUi.runSyncFromUi();
    expect(harness.header().businessRevision).toBe(n + 1);
    expect(tabB.persistence.getLastBusinessRevisionChange()).toMatchObject({ source: 'sync_apply', areas: ['customers'] });
    expect(tabA.save('Beispiel veraltet GmbH').success).toBe(false);
    expect(harness.storedCustomerNames()).toContain('Beispiel Umbenannt GmbH');
  });

  it('TEST F: nur Sync-Metadaten ändern sich → Tab A wird nicht blockiert', async () => {
    const tabA = await harness.openTab();
    const tabB = await harness.openTab();
    const before = harness.header();
    for (const [id, row] of harness.cloud.customers) {
      harness.cloud.customers.set(id, { ...row, row_version: row.row_version + 1, updated_at: '2026-09-26T13:00:00.000Z' });
    }
    await tabB.syncUi.runSyncFromUi();
    expect(harness.header().businessRevision).toBe(before.businessRevision);
    expect(tabA.save('Beispiel nach Metadaten GmbH').success).toBe(true);
  });

  it('TEST G: nur savedAt/writeGeneration ändern sich → Tab A wird nicht blockiert', async () => {
    const tabA = await harness.openTab();
    technicalRewriteByOtherTab();
    const stop = tabA.persistence.watchOtherTabWrites();
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: harness.storageKey }));
      expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(false);
    } finally {
      stop();
    }
    expect(tabA.save('Beispiel nach technischem Write GmbH').success).toBe(true);
    expect(harness.storedCustomerNames()).toContain('Beispiel nach technischem Write GmbH');
  });
});
