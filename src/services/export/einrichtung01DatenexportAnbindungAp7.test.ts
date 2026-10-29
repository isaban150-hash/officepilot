/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.24) — die echte Anbindung des Exports.
 *
 *   D-09.3  Download nach dem Muster aus AP0: Link beim Klick im Dokument, Freigabe der Adresse frühestens nach 60 s
 *   D-05.7  offene bzw. unbestätigte Finanzzustände werden je Quelle einmal benannt (FINANZ-CORE-01A-Regeln, keine neue)
 *   Ordner  gespeicherte erzeugte PDFs unter pdf/…, Originale nach Bereich unter dateien/…
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDataExportFinanceGaps, createDefaultDataExportDeps, dataExportDocumentFolder } from './dataExportDeps';
import type { AppPersistedState, CompanyDocument } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function doc(extra: Partial<CompanyDocument>): CompanyDocument {
  return { id: 'd', title: 'Dokument', category: 'sonstiges', linkedVorgang: null, createdAt: '', ...extra } as CompanyDocument;
}

describe('EINRICHTUNG-01 AP7 — Anbindung des Exports', { timeout: 30_000 }, () => {
  it('D-09.3: der Download hängt den Link beim Klick ein und gibt die Adresse erst nach 60 s frei', () => {
    vi.useFakeTimers();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:export'), revokeObjectURL });
    let imDokument = false;
    let name = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      imDokument = document.body.contains(this);
      name = this.download;
    });
    createDefaultDataExportDeps({ userEmail: '' }).download(new Blob(['zip']), 'OfficeTakt_Export_Betrieb_2026-10-25_09-00.zip');
    expect(imDokument).toBe(true);
    expect(name).toBe('OfficeTakt_Export_Betrieb_2026-10-25_09-00.zip');
    expect(document.body.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(59_999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export');
  });

  it('D-05.7: offene Ausgabe und unbestätigte Rechnungszahlung — je Quelle einmal, mit erstem Monat', () => {
    const state = {
      version: 6,
      savedAt: '',
      setup: {},
      inboxItems: [],
      vorgaenge: [],
      tasks: [],
      documents: [],
      expenses: [{ id: 'x1', status: 'gebucht', issueDate: '2026-08-15', payments: [], positions: [], allocations: [], grossAmount: 10, netAmount: 10, taxAmount: 0 }],
      employeePayments: [],
      accountingAssignments: [],
      invoiceEntries: [
        {
          vorgangId: null,
          invoice: {
            id: 'r1', number: 'RE-1', type: 'rechnung', status: 'versendet', date: '2026-09-01', issueDate: '2026-09-01', createdAt: '', taxStatus: 'regelbesteuert', amount: 50, positions: [],
            payments: [{ id: 'z1', date: '2026-09-10', amount: 50, createdAt: '', cloudBestaetigt: false }],
          },
        },
      ],
    } as unknown as AppPersistedState;
    const outbox = [
      { id: 'o1', entityType: 'expense', entityId: 'x1', operation: 'update', version: 2, queuedAt: '2026-10-01T00:00:00.000Z', retryCount: 0, status: 'pending', sequence: 1 },
    ] as SyncOutboxEntry[];
    const gaps = collectDataExportFinanceGaps(state, outbox, true, new Set());
    const ausgabe = gaps.filter((gap) => gap.reference === 'x1');
    expect(ausgabe).toHaveLength(1);
    expect(ausgabe[0]).toMatchObject({ kind: 'finance_unconfirmed', area: 'Ausgaben' });
    expect(ausgabe[0].description).toContain('wartet auf den Abgleich');
    expect(ausgabe[0].description).toContain('wirkt ab 2026-08');
    const zahlung = gaps.filter((gap) => gap.reference === 'r1');
    expect(zahlung).toHaveLength(1);
    expect(zahlung[0].description).toContain('Zahlung z1');
    expect(zahlung[0].description).toContain('wirkt ab 2026-09');
    // Ohne Cloud zählt nur der lokale Vermerk: die Zahlung gilt dann nicht als offen.
    expect(collectDataExportFinanceGaps(state, [], false, new Set()).filter((gap) => gap.reference === 'r1')).toHaveLength(0);
  });

  it('Ordner: Angebote, Briefe, Quittungen unter pdf/; Rechnungs-, Ausgaben- und Mitarbeiterbelege unter dateien/', () => {
    const state = {
      expenses: [{ id: 'x1', archiveDocumentId: 'd-beleg', payments: [{ id: 'p1', proofDocumentId: 'd-zahlbeleg' }] }],
      employeePayments: [{ id: 'ep1', proofDocumentId: 'd-lohnbeleg' }],
    } as unknown as AppPersistedState;
    expect(dataExportDocumentFolder(doc({ id: 'offer-archive-1', classifiedKind: 'angebot', linkedOfferId: 'o1' }), state)).toBe('pdf/angebote');
    expect(dataExportDocumentFolder(doc({ id: 'brief-1', category: 'geschaeftsschreiben', linkedLetterId: 'l1' }), state)).toBe('pdf/briefe');
    expect(dataExportDocumentFolder(doc({ id: 'emp-receipt-ep1', category: 'personal' }), state)).toBe('pdf/quittungen');
    expect(dataExportDocumentFolder(doc({ id: 'inv-1', category: 'ausgangsrechnung', linkedInvoiceId: 'r1' }), state)).toBe('dateien/rechnungen');
    expect(dataExportDocumentFolder(doc({ id: 'd-beleg' }), state)).toBe('dateien/ausgaben');
    expect(dataExportDocumentFolder(doc({ id: 'd-zahlbeleg' }), state)).toBe('dateien/ausgaben');
    expect(dataExportDocumentFolder(doc({ id: 'd-lohnbeleg' }), state)).toBe('dateien/mitarbeiterzahlungen');
    expect(dataExportDocumentFolder(doc({ id: 'd-sonst' }), state)).toBe('dateien/dokumente');
  });
});
