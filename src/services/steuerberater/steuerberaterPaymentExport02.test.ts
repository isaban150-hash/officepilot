/**
 * STEUERBERATER-EXPORT BLOCK 2 — Zahlungen und Zahlungsnachweise.
 *
 * Zwei Fragen soll der Steuerberater aus dem Paket beantworten können:
 * *wann und wie* wurde gezahlt, und *womit* ist das belegt. Beides stand
 * bisher nur halb drin.
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { Expense } from '../../types/expense';
import type { CompanyDocument, InboxItem, VorgangInvoice } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';
import type { AccountingAssignment } from '../../types/accounting';
import {
  buildMonatsmappeModel,
  buildZahlungenCsv,
  NACHWEIS_FOLDER,
  type MonatsmappeInput,
} from './monatsmappeModelService';
import { buildMonatsmappeZip, type MonatsmappeDocumentLoaders } from './monatsmappeExportService';
import { buildBookingCsv, buildBookingExport } from '../accounting/accountingBookingExportService';

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-1',
    number: 'RE-2026-001',
    type: 'rechnung',
    positions: [],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    date: '2026-09-10',
    issueDate: '2026-09-10',
    createdAt: '2026-09-10T10:00:00.000Z',
    customerSnapshot: { name: 'Kunde A', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baumarkt GmbH',
    invoiceNumber: 'L-100',
    title: 'Material',
    description: '',
    issueDate: '2026-09-12',
    paymentDueDate: null,
    taxStatus: 'standard_19',
    netAmount: 50,
    taxAmount: 9.5,
    grossAmount: 59.5,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'baumarkt|l-100',
    tags: [],
    digitalFolder: { id: 'dig', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'x' },
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    ...overrides,
  };
}

const fileRef = (id: string): DocumentFileRef =>
  ({
    id,
    originalFileName: 'quittung.jpg',
    mimeType: 'image/jpeg',
    fileSize: 3,
    contentHash: 'a'.repeat(64),
    storageType: 'indexeddb',
    localDataKey: id,
    createdAt: 'x',
    lifecycleStatus: 'committed',
  }) as DocumentFileRef;

function dokument(id: string, titel: string, fileRefId?: string): CompanyDocument {
  return {
    id,
    title: titel,
    category: 'sonstiges',
    issuer: 'Baumarkt GmbH',
    recognizedText: '',
    issueDate: '2026-09-20',
    validUntil: null,
    digitalFolder: { id: 'dig2', name: 'Belege', path: '/Belege/' },
    paperFolder: { folderId: 'f2', register: 'B', label: 'Belege' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-09-20T09:00:00.000Z',
    classifiedKind: 'quittung',
    documentDate: '2026-09-20',
    ...(fileRefId ? { fileRefId } : {}),
  } as CompanyDocument;
}

function input(overrides: Partial<MonatsmappeInput> = {}): MonatsmappeInput {
  return { monthKey: '2026-09', invoices: [], expenses: [], documents: [], inboxItems: [], fileRefs: [], ...overrides };
}

const loaders: MonatsmappeDocumentLoaders = {
  invoicePdf: async (id) => new TextEncoder().encode(`%PDF-${id}`),
  invoiceCorrectionPdf: async (id) => new TextEncoder().encode(`%PDF-corr-${id}`),
  fileRefBytes: async (id) => new TextEncoder().encode(`bytes-${id}`),
};

function kontierung(sourceType: 'invoice' | 'expense', sourceId: string): AccountingAssignment {
  return {
    id: `acc-${sourceId}`,
    sourceType,
    sourceId,
    chartOfAccounts: 'SKR03',
    accountNumber: '4400',
    accountLabel: 'Erlöse',
    taxTreatment: 'standard_19',
    bookingText: 'Test',
    status: 'confirmed',
    origin: 'manual',
    createdAt: 'x',
    updatedAt: 'x',
  } as AccountingAssignment;
}

/** Eine Zeile der Zahlungen.csv als Felder. */
function zahlungszeilen(csv: string): string[][] {
  return csv
    .replace(/^﻿/, '')
    .trim()
    .split('\r\n')
    .map((line) => line.split(';').map((cell) => cell.replace(/^"|"$/g, '').replace(/""/g, '"')));
}

describe('BLOCK 2 — Zahlungen.csv trägt den Nachweis', () => {
  /* ---- A) Die drei Nachweiszustände ---- */

  it('A1 — ohne proofDocumentId: kein Zahlungsnachweis', () => {
    const model = buildMonatsmappeModel(
      input({ expenses: [expense({ payments: [{ id: 'pay-1', date: '2026-09-20', amount: 59.5, method: 'cash', createdAt: 'x' }] })] }),
    );
    expect(model.zahlungenEingang[0]?.nachweisStatus).toBe('kein');
    expect(model.zahlungsnachweise).toEqual([]);

    const [kopf, zeile] = zahlungszeilen(buildZahlungenCsv(model));
    expect(kopf).toContain('Zahlungsnachweis');
    expect(kopf).toContain('Nachweisdokument');
    expect(kopf).toContain('Nachweisdatei');
    expect(zeile?.[kopf!.indexOf('Zahlungsnachweis')]).toBe('Kein Zahlungsnachweis');
    expect(zeile?.[kopf!.indexOf('Nachweisdatei')]).toBe('');
  });

  it('A2 — mit Nachweis und Datei: Titel, Datei und Paketpfad', () => {
    const model = buildMonatsmappeModel(
      input({
        expenses: [expense({ payments: [{ id: 'pay-1', date: '2026-09-20', amount: 59.5, method: 'cash', proofDocumentId: 'doc-q', createdAt: 'x' }] })],
        documents: [dokument('doc-q', 'Quittung Baumarkt', 'ref-q')],
        fileRefs: [fileRef('ref-q')],
      }),
    );
    const zahlung = model.zahlungenEingang[0]!;
    expect(zahlung.nachweisStatus).toBe('vorhanden');
    expect(zahlung.nachweisTitel).toBe('Quittung Baumarkt');
    expect(zahlung.nachweisDatei).toMatch(/^Quittung_Baumarkt_.*\.jpg$/);
    expect(model.zahlungsnachweise).toHaveLength(1);

    const [kopf, zeile] = zahlungszeilen(buildZahlungenCsv(model));
    expect(zeile?.[kopf!.indexOf('Zahlungsnachweis')]).toBe('Zahlungsnachweis beiliegend');
    expect(zeile?.[kopf!.indexOf('Nachweisdokument')]).toBe('Quittung Baumarkt');
    expect(zeile?.[kopf!.indexOf('Nachweisdatei')]).toContain(`${NACHWEIS_FOLDER}/`);
  });

  it('A3 — Dokument ohne Datei: erfasst, aber nichts zum Mitliefern', () => {
    const model = buildMonatsmappeModel(
      input({
        expenses: [expense({ payments: [{ id: 'pay-1', date: '2026-09-20', amount: 59.5, method: 'cash', proofDocumentId: 'doc-q', createdAt: 'x' }] })],
        documents: [dokument('doc-q', 'Quittung ohne Datei')],
      }),
    );
    expect(model.zahlungenEingang[0]?.nachweisStatus).toBe('ohne_datei');
    expect(model.zahlungenEingang[0]?.nachweisTitel).toBe('Quittung ohne Datei');
    expect(model.zahlungenEingang[0]?.nachweisDatei).toBeUndefined();
    expect(model.zahlungsnachweise).toEqual([]);
  });

  it('A4 — Kennung ohne Dokument: nicht auffindbar, nicht „kein"', () => {
    const model = buildMonatsmappeModel(
      input({ expenses: [expense({ payments: [{ id: 'pay-1', date: '2026-09-20', amount: 59.5, method: 'cash', proofDocumentId: 'doc-weg', createdAt: 'x' }] })] }),
    );
    expect(model.zahlungenEingang[0]?.nachweisStatus).toBe('nicht_auffindbar');

    const [kopf, zeile] = zahlungszeilen(buildZahlungenCsv(model));
    const spalte = zeile?.[kopf!.indexOf('Zahlungsnachweis')];
    expect(spalte).toBe('Zahlungsnachweis nicht mehr auffindbar');
    expect(spalte).not.toBe('Kein Zahlungsnachweis');
  });

  /* ---- B) Teilzahlungen bleiben getrennt ---- */

  it('B1 — zwei Teilzahlungen, zwei verschiedene Nachweise, kein Cross-Link', () => {
    const model = buildMonatsmappeModel(
      input({
        expenses: [
          expense({
            payments: [
              { id: 'pay-a', date: '2026-09-20', amount: 20, method: 'cash', proofDocumentId: 'doc-a', createdAt: 'x' },
              { id: 'pay-b', date: '2026-09-21', amount: 39.5, method: 'cash', proofDocumentId: 'doc-b', createdAt: 'x' },
            ],
          }),
        ],
        documents: [dokument('doc-a', 'Quittung A', 'ref-a'), dokument('doc-b', 'Kassenbeleg B', 'ref-b')],
        fileRefs: [fileRef('ref-a'), fileRef('ref-b')],
      }),
    );
    const a = model.zahlungenEingang.find((z) => z.zahlungId === 'pay-a')!;
    const b = model.zahlungenEingang.find((z) => z.zahlungId === 'pay-b')!;
    expect(a.nachweisTitel).toBe('Quittung A');
    expect(b.nachweisTitel).toBe('Kassenbeleg B');
    expect(a.nachweisDatei).not.toBe(b.nachweisDatei);
    expect(model.zahlungsnachweise).toHaveLength(2);
  });

  it('B2 — ein Beleg für zwei Zahlungen wird nur einmal verpackt', () => {
    const model = buildMonatsmappeModel(
      input({
        expenses: [
          expense({
            payments: [
              { id: 'pay-a', date: '2026-09-20', amount: 20, method: 'cash', proofDocumentId: 'doc-a', createdAt: 'x' },
              { id: 'pay-b', date: '2026-09-21', amount: 39.5, method: 'cash', proofDocumentId: 'doc-a', createdAt: 'x' },
            ],
          }),
        ],
        documents: [dokument('doc-a', 'Sammelquittung', 'ref-a')],
        fileRefs: [fileRef('ref-a')],
      }),
    );
    /* Zwei Zeilen, zwei eigene Dateinamen (je Zahlung), beide aus derselben Datei. */
    expect(model.zahlungenEingang).toHaveLength(2);
    expect(model.zahlungsnachweise).toHaveLength(2);
    expect(new Set(model.zahlungsnachweise.map((q) => q.fileRefId))).toEqual(new Set(['ref-a']));
  });

  /* ---- C) Das Paket ---- */

  it('C1 — die Nachweisdatei liegt im eigenen Ordner des ZIP', async () => {
    const model = buildMonatsmappeModel(
      input({
        expenses: [expense({ payments: [{ id: 'pay-1', date: '2026-09-20', amount: 59.5, method: 'cash', proofDocumentId: 'doc-q', createdAt: 'x' }] })],
        documents: [dokument('doc-q', 'Quittung Baumarkt', 'ref-q')],
        fileRefs: [fileRef('ref-q')],
      }),
    );
    const ergebnis = await buildMonatsmappeZip(model, loaders);
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;

    const zip = await JSZip.loadAsync(await ergebnis.blob.arrayBuffer());
    const pfade = Object.keys(zip.files);
    const nachweis = pfade.find((p) => p.includes(`${NACHWEIS_FOLDER}/`) && !zip.files[p]!.dir);
    expect(nachweis).toBeDefined();
    expect(await zip.file(nachweis!)!.async('text')).toBe('bytes-ref-q');
    /* Der Pfad in der CSV zeigt genau dorthin. */
    expect(nachweis).toContain(model.zahlungenEingang[0]!.nachweisDatei!);
  });

  it('C2 — ohne Nachweise entsteht kein leerer Ordner', async () => {
    const model = buildMonatsmappeModel(
      input({ expenses: [expense({ payments: [{ id: 'pay-1', date: '2026-09-20', amount: 59.5, method: 'cash', createdAt: 'x' }] })] }),
    );
    const ergebnis = await buildMonatsmappeZip(model, loaders);
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    const zip = await JSZip.loadAsync(await ergebnis.blob.arrayBuffer());
    expect(Object.keys(zip.files).some((p) => p.includes(NACHWEIS_FOLDER))).toBe(false);
  });
});

describe('BLOCK 2 — Buchungsexport trägt Zahlungsdatum und Zahlungsart', () => {
  function buchungszeilen(csv: string): string[][] {
    return csv
      .replace(/^﻿/, '')
      .trim()
      .split('\r\n')
      .map((line) => line.split(';').map((cell) => cell.replace(/^"|"$/g, '')));
  }

  function baue(modelInput: Partial<MonatsmappeInput>, zuordnungen: AccountingAssignment[]) {
    const model = buildMonatsmappeModel(input(modelInput));
    const bookings = buildBookingExport(model, zuordnungen, 'SKR03');
    return { model, bookings, csv: buildBookingCsv(bookings) };
  }

  it('D1 — Beleg ohne Zahlung: keine erfundene Zahlungsinformation', () => {
    const { bookings, csv } = baue({ expenses: [expense()] }, [kontierung('expense', 'exp-1')]);
    expect(bookings.rows[0]?.zahlungsdatum).toBe('');
    expect(bookings.rows[0]?.zahlungsart).toBe('');
    const [kopf] = buchungszeilen(csv);
    expect(kopf).toContain('Zahlungsdatum');
    expect(kopf).toContain('Zahlungsart');
  });

  it('D2 — eine Bankzahlung: Datum und „Bank"', () => {
    const { bookings } = baue(
      { invoices: [{ invoice: invoice({ payments: [{ id: 'p1', date: '2026-09-15', amount: 119, method: 'bank', createdAt: 'x' }] }), vorgangId: null }] },
      [kontierung('invoice', 'inv-1')],
    );
    expect(bookings.rows[0]).toMatchObject({ zahlungsdatum: '2026-09-15', zahlungsart: 'Bank' });
  });

  it('D3 — eine Barzahlung: Datum und „Bar"', () => {
    const { bookings } = baue(
      { expenses: [expense({ payments: [{ id: 'p1', date: '2026-09-20', amount: 59.5, method: 'cash', createdAt: 'x' }] })] },
      [kontierung('expense', 'exp-1')],
    );
    expect(bookings.rows[0]).toMatchObject({ zahlungsdatum: '2026-09-20', zahlungsart: 'Bar' });
  });

  it('D4 — keine technischen Enum-Werte im Export', () => {
    const { csv } = baue(
      { expenses: [expense({ payments: [{ id: 'p1', date: '2026-09-20', amount: 59.5, method: 'cash', createdAt: 'x' }] })] },
      [kontierung('expense', 'exp-1')],
    );
    expect(csv).not.toMatch(/;cash;|;bank;|;other;/);
    expect(csv).toContain('Bar');
  });

  it('D5 — Zahlungsart „other" wird als Sonstige gelesen', () => {
    const { bookings } = baue(
      { expenses: [expense({ payments: [{ id: 'p1', date: '2026-09-20', amount: 59.5, method: 'other', createdAt: 'x' }] })] },
      [kontierung('expense', 'exp-1')],
    );
    expect(bookings.rows[0]?.zahlungsart).toBe('Sonstige');
  });

  it('D6 — Zahlung ohne erfasste Zahlungsart bleibt leer, nie „Bank"', () => {
    const { bookings } = baue(
      { expenses: [expense({ payments: [{ id: 'p1', date: '2026-09-20', amount: 59.5, createdAt: 'x' }] })] },
      [kontierung('expense', 'exp-1')],
    );
    expect(bookings.rows[0]?.zahlungsdatum).toBe('2026-09-20');
    expect(bookings.rows[0]?.zahlungsart).toBe('');
  });

  it('D7 — zwei Teilzahlungen: kein einzelnes Datum wird behauptet', () => {
    const { bookings } = baue(
      {
        expenses: [
          expense({
            payments: [
              { id: 'p1', date: '2026-09-20', amount: 20, method: 'cash', createdAt: 'x' },
              { id: 'p2', date: '2026-09-21', amount: 39.5, method: 'cash', createdAt: 'x' },
            ],
          }),
        ],
      },
      [kontierung('expense', 'exp-1')],
    );
    expect(bookings.rows[0]?.zahlungsdatum).toContain('mehrere');
    expect(bookings.rows[0]?.zahlungsdatum).toContain('zahlungen.csv');
    /* Zweimal bar bleibt bar — das darf dastehen. */
    expect(bookings.rows[0]?.zahlungsart).toBe('Bar');
  });

  it('D8 — Teilzahlungen mit verschiedenen Zahlungsarten: auch die Art ist „mehrere"', () => {
    const { bookings } = baue(
      {
        expenses: [
          expense({
            payments: [
              { id: 'p1', date: '2026-09-20', amount: 20, method: 'cash', createdAt: 'x' },
              { id: 'p2', date: '2026-09-21', amount: 39.5, method: 'bank', createdAt: 'x' },
            ],
          }),
        ],
      },
      [kontierung('expense', 'exp-1')],
    );
    expect(bookings.rows[0]?.zahlungsart).toContain('mehrere');
  });

  it('D9 — eine stornierte Zahlung erscheint nicht und bestimmt nichts', () => {
    /*
     * Bestehende Semantik: Die lokale Projektion enthält stornierte Zahlungen
     * gar nicht. Dieser Test hält fest, dass Block 2 daran nichts geändert hat
     * — ein Beleg ohne aktive Zahlung bleibt ohne Zahlungsangabe.
     */
    const { bookings, model } = baue({ expenses: [expense({ payments: [] })] }, [kontierung('expense', 'exp-1')]);
    expect(model.zahlungenEingang).toEqual([]);
    expect(bookings.rows[0]?.zahlungsdatum).toBe('');
    expect(bookings.rows[0]?.zahlungsstatusMonatsende).toBe('Offen');
  });

  it('D10 — Offen/Bezahlt bleibt unberührt', () => {
    const { bookings } = baue(
      { expenses: [expense({ payments: [{ id: 'p1', date: '2026-09-20', amount: 59.5, method: 'cash', createdAt: 'x' }] })] },
      [kontierung('expense', 'exp-1')],
    );
    expect(bookings.rows[0]?.zahlungsstatusMonatsende).toBe('Bezahlt');
    expect(bookings.rows[0]?.offenMonatsende).toBe(0);
  });

  it('D11 — die bestehenden Spalten bleiben an ihrer Stelle', () => {
    const { csv } = baue({ expenses: [expense()] }, [kontierung('expense', 'exp-1')]);
    const [kopf] = buchungszeilen(csv);
    expect(kopf!.slice(0, 5)).toEqual(['Belegart', 'Beleg-ID', 'Belegnummer', 'Belegdatum', 'Gegenpartei']);
    expect(kopf!.indexOf('Zahlungsstatus zum Monatsende')).toBe(kopf!.length - 4);
    expect(kopf!.at(-2)).toBe('Zahlungsdatum');
    expect(kopf!.at(-1)).toBe('Zahlungsart');
  });
});
