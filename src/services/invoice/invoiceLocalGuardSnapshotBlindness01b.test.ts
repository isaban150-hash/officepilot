/**
 * INVOICE-LOCAL-GUARD-SNAPSHOT-BLINDNESS-01B — die lokalen Wächter müssen die
 * Rechnungen wieder sehen.
 *
 * Seit dem First-Class-Rechnungsspeicher trägt `buildPersistedStateSnapshot()`
 * die Rechnungen **absichtlich** nicht mehr an den Vorgängen; sie liegen im
 * Rechnungsspeicher. Fünf sicherheitsrelevante Prüfungen lasen trotzdem
 * weiterhin die Persistenzsicht und bekamen deshalb ausnahmslos eine leere
 * Liste — die Regeln selbst waren fehlerfrei und wurden nie fündig.
 *
 * Deshalb der entscheidende Unterschied zu den bestehenden Coordinator-Tests:
 * **Hier wird `buildPersistedStateSnapshot` nicht ersetzt.** Der Bestand
 * entsteht über `hydrateVorgangStore`, also über denselben Weg wie in der
 * Anwendung, und die Persistenzsicht bleibt so leer, wie sie im Betrieb ist.
 * Genau diese strukturelle Lücke liess den Fehler bisher unentdeckt.
 *
 * Synthetische Daten, kein Netz, keine Cloud.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  checkResumeIntents,
  findLocalFinalInvoiceConflict,
  proveLocalInvoice,
} from './invoiceFinalizationCoordinator';
import { classifyVorgangInvoicesAndIntents } from './invoiceFinalizationPreflightService';
import { buildActualPreparedResponseProjection } from './invoicePreparedResponseProjection';
import { buildInvoicePayloadV1 } from './workspaceInvoiceFinalizeRequestValidator';
import type { InvoiceFinalizeIntentInspectionEntry } from './invoiceFinalizeIntentService';
import { buildInvoiceContentFingerprintFromInvoice } from '../invoiceService';
import { mergeCloudInvoicesIntoVorgaenge } from './invoiceCloudPullMergeService';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { getVorgangById, getVorgangStoreSnapshot, hydrateVorgangStore } from '../vorgangService';
import { buildStorageKey, setActiveStorageScope } from '../storage/storageScopeService';
import { createAbschlagInvoice, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { InvoiceDraftIdentity } from '../../types/invoiceDraftDurability';
import type { VorgangInvoice } from '../../types/models';

const WORKSPACE = 'ws-guard';
const VORGANG = 'v-guard';

const IDENTITY: InvoiceDraftIdentity = {
  sourceScopeKey: buildStorageKey({ type: 'workspace', workspaceId: WORKSPACE }),
  workspaceId: WORKSPACE,
  vorgangId: VORGANG,
  invoiceType: 'schluss',
  draftId: 'draft-guard-1',
};

function schlussInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return createAbschlagInvoice('op-test-1', 4, {
    id: 'inv-schluss-1',
    number: 'RE-2026-0001',
    type: 'schluss',
    abschlagNumber: undefined,
    ...overrides,
  });
}

/** Bestand über den Produktionsweg: die Vorgänge geben ihre Rechnungen ab. */
function seed(invoices: VorgangInvoice[]): void {
  hydrateVorgangStore([createTestVorgang({ id: VORGANG, invoices })]);
}

/**
 * Der Stand, den das Produkt tatsächlich sieht.
 *
 * Beim Aufnehmen normalisiert der Speicher die Rechnung. Fingerprint und
 * Antwortprojektion müssen deshalb aus dem **gespeicherten** Datensatz
 * stammen, nicht aus der Vorlage — sonst prüfte der Test einen Stand, den es
 * nirgends gibt.
 */
function storedInvoice(id: string): VorgangInvoice {
  const found = (getVorgangById(VORGANG)?.invoices ?? []).find((entry) => entry.id === id);
  if (!found) throw new Error(`Rechnung ${id} nicht im Speicher`);
  return found;
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
});

describe('01B — Ausgangslage: die Persistenzsicht ist leer', () => {
  /*
   * Der Anker des ganzen Blocks. Bleibt diese Erwartung stehen, ist bewiesen,
   * dass die übrigen Tests wirklich aus dem Rechnungsspeicher lesen und nicht
   * heimlich doch aus dem Snapshot.
   */
  it('G0: buildPersistedStateSnapshot trägt keine Rechnungen am Vorgang', () => {
    seed([schlussInvoice()]);

    const snapshot = buildPersistedStateSnapshot();
    const vorgang = (snapshot.vorgaenge ?? []).find((entry) => entry.id === VORGANG);

    expect(vorgang).toBeDefined();
    expect(vorgang?.invoices ?? []).toHaveLength(0);
    // Dieselbe Rechnung ist in der Laufzeitsicht sehr wohl vorhanden.
    expect(
      getVorgangStoreSnapshot().find((entry) => entry.id === VORGANG)?.invoices ?? [],
    ).toHaveLength(1);
  });
});

describe('01B — F1 bis F3: lokaler Wächter gegen die zweite Schlussrechnung', () => {
  it('F1: eine wirksame Schlussrechnung wird als Konflikt erkannt', () => {
    seed([schlussInvoice({ id: 'inv-wirksam' })]);

    const conflict = findLocalFinalInvoiceConflict(VORGANG, 'schluss', 'inv-neu');

    expect(conflict).not.toBeNull();
    expect(conflict?.id).toBe('inv-wirksam');
  });

  it('F2: eine ausschliesslich stornierte Schlussrechnung blockiert nicht', () => {
    seed([
      schlussInvoice({
        id: 'inv-storniert',
        cancelledAt: '2026-09-09T10:00:00.000Z',
        paymentStatus: 'storniert',
      }),
    ]);

    /*
     * Die Absicherung gegen ein richtiges Ergebnis aus dem falschen Grund:
     * Es muss nachweislich eine Rechnung ausgewertet worden sein. Ohne diese
     * Zeile wäre der Test auch bei völliger Blindheit grün — genau so ist der
     * Fehler bisher unentdeckt geblieben.
     */
    expect(
      getVorgangStoreSnapshot().find((entry) => entry.id === VORGANG)?.invoices ?? [],
    ).toHaveLength(1);

    expect(findLocalFinalInvoiceConflict(VORGANG, 'schluss', 'inv-neu')).toBeNull();
  });

  it('F3: neben einer stornierten wird die wirksame Schlussrechnung gefunden', () => {
    seed([
      schlussInvoice({
        id: 'inv-storniert',
        cancelledAt: '2026-09-09T10:00:00.000Z',
        paymentStatus: 'storniert',
      }),
      schlussInvoice({ id: 'inv-wirksam', number: 'RE-2026-0002' }),
    ]);

    const conflict = findLocalFinalInvoiceConflict(VORGANG, 'schluss', 'inv-neu');

    expect(conflict?.id).toBe('inv-wirksam');
  });

  it('F6a: ohne Rechnungen entsteht kein Konflikt', () => {
    seed([]);

    expect(findLocalFinalInvoiceConflict(VORGANG, 'schluss', 'inv-neu')).toBeNull();
  });
});

describe('01B — F4 und F6: lokaler Nachweis einer bereits angelegten Rechnung', () => {
  /** Die Anfrage, wie der Prepared-Schritt sie erzeugt hätte. */
  function requestFor(invoice: VorgangInvoice) {
    const payload = buildInvoicePayloadV1(invoice);
    const projection = payload ? buildActualPreparedResponseProjection(payload) : null;
    expect(projection).not.toBeNull();
    return {
      invoice: { type: invoice.type },
      expectedResponseProjectionRawJson: projection,
    } as never;
  }

  it('F4: die vorhandene Rechnung wird lokal bewiesen — ohne Cloud', () => {
    seed([schlussInvoice({ id: 'inv-angelegt' })]);
    const invoice = storedInvoice('inv-angelegt');

    const result = proveLocalInvoice({
      identity: IDENTITY,
      clientInvoiceId: 'inv-angelegt',
      contentFingerprint: buildInvoiceContentFingerprintFromInvoice(invoice),
      request: requestFor(invoice),
    });

    expect(result.kind).toBe('proven');
    expect(result.kind === 'proven' ? result.invoice.id : null).toBe('inv-angelegt');
  });

  it('F4b: gleicher Geschäftsinhalt unter fremder Kennung bleibt ein Verdacht', () => {
    seed([schlussInvoice({ id: 'inv-fremd' })]);
    const invoice = storedInvoice('inv-fremd');

    const result = proveLocalInvoice({
      identity: IDENTITY,
      clientInvoiceId: 'inv-eigen',
      contentFingerprint: buildInvoiceContentFingerprintFromInvoice(invoice),
      request: requestFor(invoice),
    });

    expect(result.kind).toBe('blocked');
    expect(result.kind === 'blocked' ? result.reason : null).toBe('possible_existing_invoice');
  });

  it('F6b: ohne Rechnungen gibt es keinen falschen Treffer', () => {
    const invoice = schlussInvoice({ id: 'inv-angelegt' });
    seed([]);

    const result = proveLocalInvoice({
      identity: IDENTITY,
      clientInvoiceId: 'inv-angelegt',
      contentFingerprint: buildInvoiceContentFingerprintFromInvoice(invoice),
      request: requestFor(invoice),
    });

    expect(result.kind).toBe('none');
  });

  it('F6c: ein fehlender Vorgang bleibt unterscheidbar von „keine Rechnung"', () => {
    const invoice = schlussInvoice({ id: 'inv-angelegt' });
    hydrateVorgangStore([]);

    const result = proveLocalInvoice({
      identity: IDENTITY,
      clientInvoiceId: 'inv-angelegt',
      contentFingerprint: buildInvoiceContentFingerprintFromInvoice(invoice),
      request: requestFor(invoice),
    });

    expect(result.kind).toBe('blocked');
    expect(result.kind === 'blocked' ? result.reason : null).toBe('vorgang_missing');
  });
});

describe('01B — F5: ein Intent auf eine vorhandene Rechnung ist aufgelöst', () => {
  function intentEntry(
    clientInvoiceId: string,
    contentFingerprint: string,
  ): InvoiceFinalizeIntentInspectionEntry {
    return {
      storageKey: `${IDENTITY.sourceScopeKey}:invoice-finalize-intents`,
      mapKey: clientInvoiceId,
      intent: {
        workspaceId: WORKSPACE,
        vorgangId: VORGANG,
        clientInvoiceId,
        contentFingerprint,
        createdAt: '2026-09-08T10:00:00.000Z',
      },
      unknownFields: [],
    };
  }

  it('F5a: die Preflight-Klassifikation löst den Intent auf', () => {
    seed([schlussInvoice({ id: 'inv-alt', number: 'RE-2026-0001' })]);
    const older = storedInvoice('inv-alt');

    const result = classifyVorgangInvoicesAndIntents({
      identity: IDENTITY,
      entries: [intentEntry('inv-alt', buildInvoiceContentFingerprintFromInvoice(older))],
      latest: buildPersistedStateSnapshot(),
      contentFingerprint: 'fp-der-neuen-rechnung',
    });

    expect(result.ok).toBe(true);
  });

  it('F5b: der Resume-Intentcheck löst denselben Intent auf', () => {
    seed([schlussInvoice({ id: 'inv-alt', number: 'RE-2026-0001' })]);
    const older = storedInvoice('inv-alt');

    localStorage.setItem(
      `${IDENTITY.sourceScopeKey}:invoice-finalize-intents`,
      // Der Speicher ist nach Vorgang geschlüsselt — genau wie im Betrieb.
      JSON.stringify({
        [VORGANG]: {
          workspaceId: WORKSPACE,
          vorgangId: VORGANG,
          clientInvoiceId: 'inv-alt',
          contentFingerprint: buildInvoiceContentFingerprintFromInvoice(older),
          createdAt: '2026-09-08T10:00:00.000Z',
        },
      }),
    );

    const result = checkResumeIntents({
      identity: IDENTITY,
      clientInvoiceId: 'inv-neu',
      contentFingerprint: 'fp-der-neuen-rechnung',
    });

    expect(result.ok).toBe(true);
  });
});

describe('01B — F7: der Preflight-Merge sieht die lokale Rechnungsseite', () => {
  /*
   * Der Merge selbst wird nicht angefasst. Geprüft wird ausschliesslich seine
   * **Eingabe**: Mit der Laufzeitprojektion greifen die vorhandenen
   * Same-ID-Regeln von `applyFinalizedInvoiceToVorgang`, mit der
   * Persistenzsicht laufen sie ins Leere.
   */
  const cloudRow = {
    clientInvoiceId: 'inv-versendet',
    vorgangId: VORGANG,
    workspaceId: WORKSPACE,
  };

  function localSentInvoice(): VorgangInvoice {
    return schlussInvoice({
      id: 'inv-versendet',
      status: 'versendet',
      sentAt: '2026-09-09T08:00:00.000Z',
    });
  }

  it('F7: der stärkere lokale Versandstand überlebt die Merge-Eingabe', () => {
    const invoice = localSentInvoice();
    seed([invoice]);

    const merge = mergeCloudInvoicesIntoVorgaenge(
      getVorgangStoreSnapshot(),
      [{ ...cloudRow, invoice: { ...invoice, status: 'vorbereitet', sentAt: undefined } } as never],
      { workspaceId: WORKSPACE, reconcileIntents: false } as never,
    );

    const merged = merge.vorgaenge
      .find((entry) => entry.id === VORGANG)
      ?.invoices?.find((entry) => entry.id === 'inv-versendet');

    expect(merged?.status).toBe('versendet');
    expect(merged?.sentAt).toBe('2026-09-09T08:00:00.000Z');
  });

  it('F7b: Gegenbeweis — mit der Persistenzsicht ginge derselbe Stand verloren', () => {
    const invoice = localSentInvoice();
    seed([invoice]);

    const merge = mergeCloudInvoicesIntoVorgaenge(
      buildPersistedStateSnapshot().vorgaenge ?? [],
      [{ ...cloudRow, invoice: { ...invoice, status: 'vorbereitet', sentAt: undefined } } as never],
      { workspaceId: WORKSPACE, reconcileIntents: false } as never,
    );

    const merged = merge.vorgaenge
      .find((entry) => entry.id === VORGANG)
      ?.invoices?.find((entry) => entry.id === 'inv-versendet');

    expect(merged?.status).toBe('vorbereitet');
    expect(merged?.sentAt).toBeUndefined();
  });
});
