import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAbschlagInvoice, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { applyStateToStores, buildPersistedStateSnapshot } from '../persistenceService';
import { hydrateVorgangStore, getVorgangById } from '../vorgangService';
import { listInvoicesForVorgang } from '../invoice/invoiceStore';
import {
  buildFinalStateAfterPull,
  buildInvoiceEntriesAfterPull,
  projectInvoiceEntriesOntoVorgaenge,
} from './supabaseSyncAdapter';
import { mergeCloudInvoicesIntoVorgaenge } from '../invoice/invoiceCloudPullMergeService';
import type { AppPersistedState, StoredInvoiceEntry, VorgangInvoice } from '../../types/models';

/**
 * INVOICE-CLOUD-PULL-STORE-01B — die Naht zwischen Cloud-Pull und
 * Rechnungsspeicher.
 *
 * Gemessener Fehler: Auf einem frisch angemeldeten Gerät lieferte
 * `pull_workspace_invoices` alle Cloud-Rechnungen, das Mapping nahm sie an, der
 * Merge hängte sie an die Vorgänge — und danach war keine einzige sichtbar. Der
 * Sync-Endzustand führte das leere `invoiceEntries` von vor dem Pull mit, und
 * `applyStateToStores` überschrieb damit den soeben gefüllten Speicher.
 *
 * Genau diese Naht war ungetestet: Merge und Speicher waren je für sich
 * geprüft, ihr Zusammentreffen nicht.
 */

function invoice(id: string, number: string): VorgangInvoice {
  return { ...createAbschlagInvoice(), id, number };
}

/** Der Sync bekommt seinen Eingangszustand aus dem Snapshot — dort sind die
 *  Rechnungen bereits von den Vorgängen abgestreift. */
function snapshotLike(state: Partial<AppPersistedState>): AppPersistedState {
  return buildPersistedStateSnapshot() && ({ ...buildPersistedStateSnapshot(), ...state });
}

beforeEach(() => {
  resetTestStores();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Rechnungsbestand nach dem Cloud-Pull', () => {
  it('A: gezogene Rechnungen landen im Rechnungsspeicher, nicht an den Vorgängen', () => {
    const gezogen = invoice('inv-cloud-1', '2026-0010');
    const vorgaengeNachMerge = [
      createTestVorgang({ id: 'v-1', invoices: [gezogen] }),
      createTestVorgang({ id: 'v-2', invoices: [] }),
    ];

    const entries = buildInvoiceEntriesAfterPull(vorgaengeNachMerge, []);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.invoice.id).toBe('inv-cloud-1');
    expect(entries[0]!.vorgangId).toBe('v-1');
  });

  it('B: der Endzustand macht die Rechnung über den Speicher sichtbar', () => {
    /* Frisches Gerät: leerer Speicher, Vorgänge ohne Rechnungen. */
    hydrateVorgangStore([createTestVorgang({ id: 'v-1' })]);
    expect(listInvoicesForVorgang('v-1')).toHaveLength(0);

    const gezogen = invoice('inv-cloud-1', '2026-0010');
    const vorgaengeNachMerge = [createTestVorgang({ id: 'v-1', invoices: [gezogen] })];

    /* So baut der Sync seinen Endzustand — Rechnungen im Speicherfeld,
       Vorgänge abgestreift. */
    const finalState: AppPersistedState = {
      ...snapshotLike({}),
      vorgaenge: vorgaengeNachMerge.map((vorgang) => ({ ...vorgang, invoices: [] })),
      invoiceEntries: buildInvoiceEntriesAfterPull(vorgaengeNachMerge, []),
    };

    applyStateToStores(finalState);

    /* Der eigentliche Nachweis: über den First-Class-Store sichtbar. */
    expect(listInvoicesForVorgang('v-1').map((entry) => entry.number)).toEqual(['2026-0010']);
    expect(getVorgangById('v-1')?.invoices.map((entry) => entry.id)).toEqual(['inv-cloud-1']);
  });

  it('C: der persistierte Endzustand trägt die Rechnungen nicht doppelt', () => {
    const gezogen = invoice('inv-cloud-1', '2026-0010');
    const vorgaengeNachMerge = [createTestVorgang({ id: 'v-1', invoices: [gezogen] })];

    const finalState: AppPersistedState = {
      ...snapshotLike({}),
      vorgaenge: vorgaengeNachMerge.map((vorgang) => ({ ...vorgang, invoices: [] })),
      invoiceEntries: buildInvoiceEntriesAfterPull(vorgaengeNachMerge, []),
    };

    expect(finalState.invoiceEntries).toHaveLength(1);
    expect(finalState.vorgaenge.every((vorgang) => (vorgang.invoices ?? []).length === 0)).toBe(true);

    /* Nach dem Anwenden ist auch der neue Snapshot wieder frei von Dubletten. */
    applyStateToStores(finalState);
    const snapshot = buildPersistedStateSnapshot();
    expect(snapshot.invoiceEntries).toHaveLength(1);
    expect(snapshot.vorgaenge.every((vorgang) => (vorgang.invoices ?? []).length === 0)).toBe(true);
  });

  it('D: eine lokale, noch nicht synchronisierte Rechnung überlebt den Pull', () => {
    /*
     * Der Sync sieht sie nicht: Sein Eingangszustand trägt Rechnungen nur in
     * `invoiceEntries`, die Vorgänge im Merge haben keine. Würde der Endzustand
     * allein aus den gemergten Vorgängen abgeleitet, wäre dieser Beleg weg.
     */
    const lokal: StoredInvoiceEntry = {
      invoice: invoice('inv-lokal-1', '2026-0099'),
      vorgangId: 'v-2',
    };
    const gezogen = invoice('inv-cloud-1', '2026-0010');
    const vorgaengeNachMerge = [
      createTestVorgang({ id: 'v-1', invoices: [gezogen] }),
      createTestVorgang({ id: 'v-2', invoices: [] }),
    ];

    const entries = buildInvoiceEntriesAfterPull(vorgaengeNachMerge, [lokal]);

    expect(entries.map((entry) => entry.invoice.id).sort()).toEqual(['inv-cloud-1', 'inv-lokal-1']);
    expect(entries.find((entry) => entry.invoice.id === 'inv-lokal-1')?.vorgangId).toBe('v-2');
  });

  it('D2: ein Eintrag ohne Vorgangsbezug bleibt erhalten', () => {
    const verwaist: StoredInvoiceEntry = {
      invoice: invoice('inv-orphan-1', '2026-0098'),
      vorgangId: null,
    };

    const entries = buildInvoiceEntriesAfterPull(
      [createTestVorgang({ id: 'v-1', invoices: [] })],
      [verwaist],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]!.vorgangId).toBeNull();
  });

  it('E: der Pull ist die frischere Wahrheit für dieselbe Rechnung', () => {
    const alt: StoredInvoiceEntry = {
      invoice: { ...invoice('inv-cloud-1', '2026-0010'), status: 'vorbereitet' },
      vorgangId: 'v-1',
    };
    const gezogen = { ...invoice('inv-cloud-1', '2026-0010'), status: 'versendet' as const };

    const entries = buildInvoiceEntriesAfterPull(
      [createTestVorgang({ id: 'v-1', invoices: [gezogen] })],
      [alt],
    );

    /* Keine Dublette, und der gezogene Stand gewinnt. */
    expect(entries).toHaveLength(1);
    expect(entries[0]!.invoice.status).toBe('versendet');
  });

  /**
   * Der eigentliche Regressionsfall: nicht die Hilfsfunktion, sondern der
   * Endzustand, den der Sync tatsächlich weitergibt. Genau dort ging der
   * Bestand verloren — die Hilfsfunktion allein hätte den Fehler nie gezeigt.
   */
  it('G: der Sync-Endzustand trägt die gezogenen Rechnungen im Speicherfeld', () => {
    const gezogen = invoice('inv-cloud-1', '2026-0010');
    /* Eingangszustand eines frischen Geräts: leerer Speicher. */
    const vorher: AppPersistedState = { ...snapshotLike({}), invoiceEntries: [] };
    /* Was Merge und Dokumenten-Pull liefern: Vorgänge mit Rechnungen. */
    const nachMerge = [createTestVorgang({ id: 'v-1', invoices: [gezogen] })];

    const finalState = buildFinalStateAfterPull(vorher, nachMerge, []);

    /* Ohne den Fix bliebe hier die leere Liste aus `vorher` stehen. */
    expect(finalState.invoiceEntries?.map((entry) => entry.invoice.id)).toEqual(['inv-cloud-1']);
    expect(finalState.invoiceEntries?.[0]!.vorgangId).toBe('v-1');
    /* Und keine zweite Wahrheit an den Vorgängen. */
    expect(finalState.vorgaenge.every((entry) => (entry.invoices ?? []).length === 0)).toBe(true);

    /* Und danach über den normalen Weg sichtbar. */
    applyStateToStores(finalState);
    expect(listInvoicesForVorgang('v-1').map((entry) => entry.number)).toEqual(['2026-0010']);
  });

  /* ------------------------------------------------------------------ */
  /* Same-ID-Sicherheit: der lokale Stand geht in den Merge               */
  /* ------------------------------------------------------------------ */

  it('A1: eine nur lokal vorhandene Rechnung bleibt erhalten', () => {
    const nurLokal: StoredInvoiceEntry = {
      invoice: invoice('inv-lokal-1', '2026-0099'),
      vorgangId: 'v-1',
    };
    const vorgaenge = projectInvoiceEntriesOntoVorgaenge(
      [createTestVorgang({ id: 'v-1' })],
      [nurLokal],
    );

    /* Sie geht in den Merge ein … */
    expect(vorgaenge[0]!.invoices.map((entry) => entry.id)).toEqual(['inv-lokal-1']);
    /* … und übersteht ihn, auch wenn die Cloud sie nicht kennt. */
    expect(buildInvoiceEntriesAfterPull(vorgaenge, [nurLokal]).map((e) => e.invoice.id)).toEqual([
      'inv-lokal-1',
    ]);
  });

  it('A2: dieselbe Rechnung lokal und in der Cloud ergibt keine Dublette', () => {
    const gemeinsam = invoice('inv-1', '2026-0010');
    const lokal: StoredInvoiceEntry = { invoice: gemeinsam, vorgangId: 'v-1' };
    const vorgaenge = projectInvoiceEntriesOntoVorgaenge(
      [createTestVorgang({ id: 'v-1', invoices: [gemeinsam] })],
      [lokal],
    );

    expect(vorgaenge[0]!.invoices).toHaveLength(1);
    expect(buildInvoiceEntriesAfterPull(vorgaenge, [lokal])).toHaveLength(1);
  });

  it('A3: eine lokal als versendet markierte Rechnung fällt nicht auf den Cloud-Stand zurück', () => {
    /*
     * Der reale Fall: „Als versendet markieren" schreibt zuerst lokal, die
     * Cloud folgt. Trifft dazwischen ein Pull ein, kennt die Cloud den Versand
     * noch nicht.
     *
     * Geschützt wird das von `applyFinalizedInvoiceToVorgang` — aber nur, wenn
     * der lokale Stand im Merge sichtbar ist. Genau das stellt die Projektion
     * sicher; ohne sie sähe der Merge einen Neuzugang und der Versand wäre weg.
     */
    const lokalVersendet: VorgangInvoice = {
      ...invoice('inv-1', '2026-0010'),
      status: 'versendet',
      sentAt: '2026-09-08',
      sentVia: 'email',
    };
    const cloudStand: VorgangInvoice = {
      ...invoice('inv-1', '2026-0010'),
      status: 'vorbereitet',
    };

    const vorgaenge = projectInvoiceEntriesOntoVorgaenge(
      [createTestVorgang({ id: 'v-1' })],
      [{ invoice: lokalVersendet, vorgangId: 'v-1' }],
    );

    /* Der Merge bekommt beide Seiten zu sehen … */
    expect(vorgaenge[0]!.invoices[0]!.status).toBe('versendet');

    const gemergt = mergeCloudInvoicesIntoVorgaenge(vorgaenge, [
      {
        workspaceId: 'ws-1',
        cloudInvoiceId: 'row-1',
        clientInvoiceId: 'inv-1',
        vorgangId: 'v-1',
        invoice: cloudStand,
      } as never,
    ]);

    /* … und behält den lokalen Versandsatz. */
    const zusammengefuehrt = gemergt.vorgaenge[0]!.invoices[0]!;
    expect(zusammengefuehrt.status).toBe('versendet');
    expect(zusammengefuehrt.sentAt).toBe('2026-09-08');

    /* Und der Endzustand trägt genau diesen Stand weiter. */
    const entries = buildInvoiceEntriesAfterPull(gemergt.vorgaenge, [
      { invoice: lokalVersendet, vorgangId: 'v-1' },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.invoice.status).toBe('versendet');
    expect(entries[0]!.invoice.sentAt).toBe('2026-09-08');
  });

  it('A3b: ohne die Projektion ginge derselbe Versandsatz verloren', () => {
    /* Der Gegenbeweis — so sah der Sync-Pfad bis 01C aus. */
    const lokalVersendet: VorgangInvoice = {
      ...invoice('inv-1', '2026-0010'),
      status: 'versendet',
      sentAt: '2026-09-08',
      sentVia: 'email',
    };
    const cloudStand: VorgangInvoice = {
      ...invoice('inv-1', '2026-0010'),
      status: 'vorbereitet',
    };

    const ohneProjektion = mergeCloudInvoicesIntoVorgaenge(
      [createTestVorgang({ id: 'v-1' })],
      [
        {
          workspaceId: 'ws-1',
          cloudInvoiceId: 'row-1',
          clientInvoiceId: 'inv-1',
          vorgangId: 'v-1',
          invoice: cloudStand,
        } as never,
      ],
    );

    expect(ohneProjektion.vorgaenge[0]!.invoices[0]!.status).toBe('vorbereitet');
    expect(ohneProjektion.vorgaenge[0]!.invoices[0]!.sentAt).toBeUndefined();
    /* Genau dieser Stand hätte den lokalen Versand überschrieben. */
    expect(lokalVersendet.status).toBe('versendet');
  });

  it('F: ein bereits korrekt gefüllter Speicher bleibt korrekt', () => {
    const bestand: StoredInvoiceEntry[] = [
      { invoice: invoice('inv-a', '2026-0001'), vorgangId: 'v-1' },
      { invoice: invoice('inv-b', '2026-0002'), vorgangId: 'v-2' },
    ];

    /* Ein Pull ohne neue Rechnungen darf nichts wegnehmen. */
    const entries = buildInvoiceEntriesAfterPull(
      [createTestVorgang({ id: 'v-1' }), createTestVorgang({ id: 'v-2' })],
      bestand,
    );

    expect(entries.map((entry) => entry.invoice.id)).toEqual(['inv-a', 'inv-b']);
  });
});
