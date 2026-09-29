/**
 * SYNC-AUTOMATIK-01A-FIX4 — Öffnen eines Tabs darf die fachliche Revision nicht
 * über Demo-Vorgänge aus der Cloud erhöhen.
 *
 * Befund im echten OfficeTakt (Playwright + Edge, nur Feldpfade protokolliert):
 * Der Cloud-Workspace trägt die drei Demo-Vorgänge `v-001…v-003` als aktive
 * Zeilen. Beim Öffnen von Tab B
 *   1. übernahm der Bootstrap-Merge sie in die Speicher (17 → 20 Vorgänge,
 *      businessRevision +1),
 *   2. entfernte das Bootstrap-Ende sie wieder (`stripDefinitelyMockDataFromState`,
 *      20 → 17, businessRevision +1).
 * Endstand identisch, Revision +2 — Tab A war gesperrt. Zusätzlich brachte jeder
 * vollständige Abgleich (90 s) die Demo-Vorgänge erneut zurück.
 *
 * Getestet über den echten Anmelde-Start in getrennten Modulinstanzen mit
 * gemeinsamem `localStorage`; die Cloud antwortet nach Serververtrag.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_VORGAENGE } from '../../data/mockData';
import { createTestVorgang } from '../../test/fixtures';
import { createMultiTabCloudHarness } from '../../test/multiTabCloudHarness';
import { stripVorgangForCloud } from '../vorgang/vorgangCloudService';
import type { Vorgang } from '../../types/models';

const harness = createMultiTabCloudHarness({ userId: 'tabs-fix4-user', workspaceId: 'tabs-fix4-ws' });
const DEMO_IDS = ['v-001', 'v-002', 'v-003'];

/** Ein realistischer, beauftragter Vorgang in Ausführung. */
function realVorgang(): Vorgang {
  const positions = [
    { id: 'op-1', description: 'Fliesen', plannedQuantity: 10, unit: 'm²', unitPrice: 45, category: 'arbeit' as const },
    { id: 'op-2', description: 'Material', plannedQuantity: 5, unit: 'Stk', unitPrice: 20, category: 'material' as const },
  ];
  return createTestVorgang({
    id: 'v-real-fix4',
    title: 'Beispiel Badrenovierung',
    status: 'in_bearbeitung',
    customerId: 'c-fix4',
    orderPositions: positions.map((position) => ({ ...position, executedQuantity: position.plannedQuantity / 2 })),
    contractConfirmation: {
      id: 'snap-fix4',
      confirmedAt: '2026-09-02T12:00:00.000Z',
      customer: 'Beispiel Kunde',
      auftraggeber: 'Beispiel Kunde',
      baustelle: 'Beispielstraße 1',
      title: 'Beispiel Badrenovierung',
      positions: positions.map((position) => ({ ...position, billable: true })),
      negotiation: { conducted: false, notes: [], generalHints: [], priceProposals: [], positionProposals: [], drafts: [] },
      immutable: true,
    } as never,
    executionStartedAt: '2026-09-03T08:00:00.000Z',
    orderNumber: 'AU-2026-0002',
    orderDate: '2026-09-02',
    taxStatus: 'standard_19',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    contractTotals: { subtotal: 550, taxRate: 19, tax: 104.5, total: 654.5 } as never,
  });
}

function storedVorgangIds(): string[] {
  const stored = JSON.parse(localStorage.getItem(harness.storageKey)!) as { vorgaenge?: Array<{ id: string }> };
  return (stored.vorgaenge ?? []).map((vorgang) => vorgang.id);
}

// Jeder Tab lädt den vollständigen Modulgraphen neu — unter Last dauert das.
describe('SYNC-AUTOMATIK-01A-FIX4 — Demo-Vorgänge der Cloud erhöhen keine fachliche Revision', { timeout: 90_000 }, () => {
  beforeEach(async () => {
    localStorage.clear();
    harness.reset();
    // Wie im echten Workspace: die drei Demo-Vorgänge liegen als aktive Cloud-Zeilen vor.
    for (const demo of MOCK_VORGAENGE.filter((vorgang) => DEMO_IDS.includes(vorgang.id))) {
      harness.cloud.vorgaenge.set(demo.id, {
        payload: stripVorgangForCloud(demo) as unknown as Record<string, unknown>,
        row_version: 1,
        updated_at: '2026-08-01T10:00:00.000Z',
      });
    }
    // Vorgeschichte: ein Gerät legt einen echten Vorgang an und synchronisiert.
    const setupTab = await harness.openTab();
    setupTab.vorgaenge.hydrateVorgangStore([...setupTab.vorgaenge.getVorgangStoreSnapshot(), realVorgang()]);
    expect(setupTab.persistence.persistAll().success).toBe(true);
    await setupTab.syncUi.runSyncFromUi();
    expect(harness.cloud.vorgaenge.has('v-real-fix4')).toBe(true);
  }, 90_000);

  afterEach(() => {
    harness.clear();
    vi.resetModules();
  });

  it('A–E: Tab B öffnet (vollständiger Anmelde-Start, Demo-Zeilen in der Cloud) → Revision bleibt, Tab A speichert', async () => {
    const tabA = await harness.openTab();
    const before = harness.header();
    expect(storedVorgangIds()).toContain('v-real-fix4');
    expect(storedVorgangIds().some((id) => DEMO_IDS.includes(id))).toBe(false);

    const tabB = await harness.openTab();
    const after = harness.header();
    expect(after.writeGeneration).toBeGreaterThan(before.writeGeneration!); // technische Schreibvorgänge dürfen sein
    expect(after.businessRevision).toBe(before.businessRevision);
    const change = tabB.persistence.getLastBusinessRevisionChange();
    expect(change === null || change.storageKey !== harness.storageKey).toBe(true);

    expect(tabA.save('Beispiel nach Öffnen von B GmbH').success).toBe(true);
    expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(false);
  });

  it('F: Reload von Tab B mit unverändertem Cloud-Stand → Revision bleibt, Tab A speichert', async () => {
    const tabA = await harness.openTab();
    const before = harness.header();
    await harness.openTab();
    await harness.openTab();
    expect(harness.header().businessRevision).toBe(before.businessRevision);
    expect(tabA.save('Beispiel nach Reload von B GmbH').success).toBe(true);
  });

  it('G: mehrfacher Bootstrap und regelmässiger vollständiger Abgleich → keine Revision, keine Demo-Vorgänge', async () => {
    const tabA = await harness.openTab();
    const before = harness.header();
    await harness.openTab();
    // Der 90-s-Abgleich im Tab A: vollständiger Lauf wie `runSyncFromUi` des Planers.
    await tabA.syncUi.runSyncFromUi();
    await tabA.syncUi.runSyncFromUi();
    expect(harness.header().businessRevision).toBe(before.businessRevision);
    expect(storedVorgangIds().some((id) => DEMO_IDS.includes(id))).toBe(false);
    expect(tabA.vorgaenge.getVorgangStoreSnapshot().some((vorgang) => DEMO_IDS.includes(vorgang.id))).toBe(false);
    expect(tabA.save('Beispiel nach Abgleich GmbH').success).toBe(true);
  });

  it('H: echter geänderter Cloud-Vorgang → Revision +1 (Bereich vorgaenge), Tab A geschützt', async () => {
    const tabA = await harness.openTab();
    const tabB = await harness.openTab();
    const n = harness.header().businessRevision!;
    const row = harness.cloud.vorgaenge.get('v-real-fix4')!;
    harness.cloud.vorgaenge.set('v-real-fix4', {
      ...row,
      payload: { ...row.payload, title: 'Beispiel Badrenovierung – erweitert' },
      row_version: row.row_version + 1,
    });
    await tabB.syncUi.runSyncFromUi();
    expect(harness.header().businessRevision).toBe(n + 1);
    expect(tabB.persistence.getLastBusinessRevisionChange()).toMatchObject({ source: 'sync_apply', areas: ['vorgaenge'] });
    expect(tabA.save('Beispiel veraltet GmbH').success).toBe(false);
    expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(true);
  });

  it('I: echter lokaler Vorgangs-Save in Tab B → Revision +1, Tab A geschützt', async () => {
    const tabA = await harness.openTab();
    const tabB = await harness.openTab();
    const n = harness.header().businessRevision!;
    const committed = tabB.vorgaenge.commitVorgangMutation('v-real-fix4', (current) => ({ ...current, baustelle: 'Neue Baustelle 7' }));
    expect(committed.ok).toBe(true);
    expect(harness.header().businessRevision).toBe(n + 1);
    expect(tabB.persistence.getLastBusinessRevisionChange()).toMatchObject({ source: 'save', areas: ['vorgaenge'] });
    expect(tabA.save('Beispiel veraltet GmbH').success).toBe(false);
  });

  it('J: nur Sync-Metadaten eines Vorgangs ändern sich → keine fachliche Revision', async () => {
    const tabA = await harness.openTab();
    const tabB = await harness.openTab();
    const before = harness.header();
    const row = harness.cloud.vorgaenge.get('v-real-fix4')!;
    harness.cloud.vorgaenge.set('v-real-fix4', { ...row, row_version: row.row_version + 1, updated_at: '2026-09-26T13:00:00.000Z' });
    await tabB.syncUi.runSyncFromUi();
    expect(harness.header().businessRevision).toBe(before.businessRevision);
    expect(tabA.save('Beispiel nach Metadaten GmbH').success).toBe(true);
  });
});
