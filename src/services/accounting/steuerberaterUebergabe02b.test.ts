/**
 * STEUERBERATER & BUCHFUEHRUNGSINTELLIGENZ 02B — Übergabe korrekt und vollständig.
 *
 *   S  Storno: gleicher Monat → Original (+) und Storno (−), netto 0, keine
 *      ID-Kollision, stabil bei Wiederholung; Storno im Folgemonat lässt den
 *      korrekt abgeschlossenen Vormonat gültig und erscheint im Stornomonat.
 *   P  Paket (echter 06C-Weg über Stores, Abschluss und Runner): buchungen.csv,
 *      zahlungen.csv, Zahlungsstand und offene Posten zum Monatsende, fehlende
 *      Nachweise, unklare Fälle, Manifest und Prüfbericht konsistent.
 *   U  Übergabestatus: nicht abgeschlossen, seit Abschluss geändert, unklare
 *      Fälle, Nachweise fehlen, Bankabgleich nicht verfügbar, bereit — und
 *      Übersicht und Gate widersprechen sich nie.
 *
 * Neutrale Beispieldaten, kein Netzwerk, kein Download.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { setExpenseStoreForTests } from '../expenseStore';
import { hydrateInboxStore, processUpload } from '../inboxService';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { setAccountingStoreForTests } from './accountingStore';
import { setAccountingPeriodStoreForTests } from './accountingPeriodStore';
import {
  buildAccountingPeriodState,
  closeAccountingPeriod,
  getAccountingPeriodState,
} from './accountingPeriodService';
import { buildPeriodFingerprint, buildPeriodManifest } from './accountingPeriodFingerprint';
import { buildBookingExport } from './accountingBookingExportService';
import { buildAccountingExport } from './accountingExportRunner';
import { evaluateAccountingExportReadiness } from './accountingExportGateService';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { collectMonatsmappeInput } from '../steuerberater/monatsmappeInputService';
import { getSteuerberaterMonthOverview } from '../steuerberaterOverviewService';
import type { MonatsmappeDocumentLoaders } from '../steuerberater/monatsmappeExportService';
import type { AccountingAssignment } from '../../types/accounting';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';

const SEP = '2026-09';
const AUG = '2026-08';

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
    paymentDueDate: '2026-09-30',
    createdAt: '2026-09-10T10:00:00.000Z',
    customerSnapshot: { name: 'Kunde A', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-real-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Lieferant GmbH',
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
    dedupeKey: 'lieferant gmbh|l-100',
    tags: [],
    digitalFolder: { id: 'dig', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'x' },
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    ...overrides,
  } as Expense;
}

function kontierung(sourceType: 'invoice' | 'expense', sourceId: string): AccountingAssignment {
  return {
    id: `k-${sourceId}`,
    sourceType,
    sourceId,
    chartOfAccounts: 'SKR03',
    accountNumber: sourceType === 'invoice' ? '8400' : '4930',
    accountLabel: sourceType === 'invoice' ? 'Erlöse 19 %' : 'Bürobedarf',
    taxTreatment: 'standard_19',
    bookingText: `Beleg ${sourceId}`,
    status: 'confirmed',
    origin: 'manual',
    confirmedAt: '2026-09-15T10:00:00.000Z',
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T10:00:00.000Z',
  } as AccountingAssignment;
}

const loaders: MonatsmappeDocumentLoaders = {
  invoicePdf: async () => new Uint8Array([37, 80, 68, 70, 45]),
  invoiceCorrectionPdf: async () => new Uint8Array([37, 80, 68, 70, 45]),
  fileRefBytes: async () => new Uint8Array([1, 2, 3]),
};

const model = (monthKey: string) => buildMonatsmappeModel(collectMonatsmappeInput(monthKey));

async function paket(monthKey: string) {
  const { result, blob } = await buildAccountingExport({ monthKey, userId: undefined, skipGate: true, loaders });
  expect(result.outcome, JSON.stringify(result)).toBe('exported');
  const zip = await JSZip.loadAsync(blob!);
  const root = Object.keys(zip.files)[0].split('/')[0];
  const read = (path: string) => zip.file(`${root}/${path}`)!.async('string');
  return {
    paths: Object.keys(zip.files),
    buchungen: await read('01_Buchungsdaten/buchungen.csv'),
    zahlungen: await read('01_Buchungsdaten/zahlungen.csv'),
    offenePosten: await read('01_Buchungsdaten/offene_posten_monatsende.csv'),
    pruefbericht: await read('00_Abschluss/pruefbericht.txt'),
    manifest: JSON.parse(await read('00_Abschluss/manifest.json')) as Record<string, any>,
  };
}

const rows = (csv: string) => csv.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1);

beforeEach(() => {
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  setExpenseStoreForTests([]);
  hydrateInvoiceStore([]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-00000002b001',
      settings: { chartOfAccounts: 'SKR03' },
      version: 1,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  });
});

/* ================================================================== */
describe('S — Storno: Identität und Periodenwahrheit', () => {
  it('S1: Storno im selben Monat — Original und Stornozeile, netto 0, keine ID-Kollision', () => {
    hydrateInvoiceStore([
      { invoice: invoice({ cancelledAt: '2026-09-15T08:00:00.000Z', cancelReason: 'Doppelt', cancellationKind: 'internal' }), vorgangId: null },
    ]);
    const m = model(SEP);
    expect(m.ausgangsrechnungen.map((b) => [b.id, b.status])).toEqual([['inv-1', 'storniert']]);
    expect(m.stornos.map((b) => [b.id, b.belegart, b.brutto])).toEqual([['inv-1', 'rechnungsstorno', -119]]);

    const export1 = buildBookingExport(m, [kontierung('invoice', 'inv-1')], 'SKR03');
    expect(export1.rows.map((r) => [r.exportId, r.brutto])).toEqual([
      ['inv-1', 119],
      ['inv-1-Storno', -119],
    ]);
    expect(export1.totals.brutto).toBe(0);
    expect(export1.totals.belegCount).toBe(2);

    // Periodenmanifest: dieselbe Semantik — zwei Einträge, Summe 0.
    const manifest = buildPeriodManifest(m, [kontierung('invoice', 'inv-1')], 'SKR03');
    expect(manifest.entries.map((e) => [e.sourceId, e.belegart, e.brutto])).toEqual([
      ['inv-1', 'ausgangsrechnung', 119],
      ['inv-1', 'rechnungsstorno', -119],
    ]);
    expect(manifest.totalBrutto).toBe(0);

    // Stabil: Wiederholung ergibt dieselben Zeilen und denselben Fingerprint, keine Doppelzeilen.
    const export2 = buildBookingExport(model(SEP), [kontierung('invoice', 'inv-1')], 'SKR03');
    expect(export2.rows).toEqual(export1.rows);
    expect(buildPeriodFingerprint(buildPeriodManifest(model(SEP), [kontierung('invoice', 'inv-1')], 'SKR03'))).toBe(
      buildPeriodFingerprint(manifest),
    );
  });

  it('S2: Storno im Folgemonat — August bleibt gültig abgeschlossen, der Storno gehört in den September', () => {
    const august = invoice({ id: 'inv-aug', number: 'RE-2026-050', issueDate: '2026-08-20', date: '2026-08-20', paymentDueDate: '2026-09-30' });
    hydrateInvoiceStore([{ invoice: august, vorgangId: null }]);
    setAccountingStoreForTests([kontierung('invoice', 'inv-aug')]);
    expect(closeAccountingPeriod(AUG).success).toBe(true);
    expect(getAccountingPeriodState(AUG).readiness).toBe('closed');

    // Storno am 5. September
    hydrateInvoiceStore([
      { invoice: { ...august, cancelledAt: '2026-09-05T09:00:00.000Z', cancelReason: 'Falscher Betrag', cancellationKind: 'internal' }, vorgangId: null },
    ]);

    const augState = getAccountingPeriodState(AUG);
    expect(augState.isCurrentClosureValid).toBe(true);
    expect(augState.readiness).toBe('closed');
    expect(evaluateAccountingExportReadiness(AUG).packageAllowed).toBe(true);
    const augModel = model(AUG);
    expect(augModel.ausgangsrechnungen.map((b) => [b.id, b.status, b.brutto])).toEqual([['inv-aug', 'aktiv', 119]]);
    expect(augModel.stornos).toEqual([]);

    const sepModel = model(SEP);
    expect(sepModel.stornos.map((b) => [b.id, b.datum, b.brutto])).toEqual([['inv-aug', '2026-09-05', -119]]);
    const sepExport = buildBookingExport(sepModel, [kontierung('invoice', 'inv-aug')], 'SKR03');
    expect(sepExport.rows.map((r) => [r.exportId, r.belegdatum, r.brutto])).toEqual([['inv-aug-Storno', '2026-09-05', -119]]);
  });

  it('S2b: Ausgabe im Folgemonat storniert — im Vormonat aktiv, offen und offener Posten', () => {
    setExpenseStoreForTests([
      expense({ issueDate: '2026-08-12', status: 'storniert', paymentStatus: 'storniert', cancelledAt: '2026-09-04T09:00:00.000Z', cancelReason: 'Retoure' }),
    ]);
    const aug = model(AUG);
    expect(aug.eingangsbelege.map((b) => [b.status, b.zahlungsstatus, b.offenerBetrag])).toEqual([['aktiv', 'offen', 59.5]]);
    expect(aug.offenePostenMonatsende?.map((p) => [p.belegart, p.offen])).toEqual([['eingangsbeleg', 59.5]]);
    expect(model(SEP).stornos.map((b) => [b.belegart, b.brutto])).toEqual([['ausgabenstorno', -59.5]]);
  });

  it('S3: ein alter Abschluss (Version 1) wird weiter nach alter Semantik geprüft', () => {
    const august = invoice({ id: 'inv-aug', number: 'RE-2026-050', issueDate: '2026-08-20', date: '2026-08-20' });
    hydrateInvoiceStore([{ invoice: august, vorgangId: null }]);
    const assignments = [kontierung('invoice', 'inv-aug')];
    const v1 = buildPeriodManifest(model(AUG), assignments, 'SKR03', 1);
    expect(v1.fingerprintVersion).toBeUndefined();
    const closure = {
      id: 'c-v1', monthKey: AUG, revision: 1, closedAt: '2026-08-31T10:00:00.000Z',
      fingerprint: buildPeriodFingerprint(v1), manifest: v1,
      createdAt: '2026-08-31T10:00:00.000Z', updatedAt: '2026-08-31T10:00:00.000Z',
    };
    expect(buildAccountingPeriodState(model(AUG), assignments, 'SKR03', [closure]).isCurrentClosureValid).toBe(true);
  });
});

/* ================================================================== */
describe('P — Paketinhalt über den echten 06C-Weg', () => {
  it('P1: Zahlungsstand zum Monatsende — eine Zahlung im Folgemonat ändert den August nicht', async () => {
    const august = invoice({
      id: 'inv-aug', number: 'RE-2026-050', issueDate: '2026-08-20', date: '2026-08-20', paymentDueDate: '2026-09-30',
      payments: [{ id: 'pay-sep', date: '2026-09-10', amount: 119, method: 'bank', createdAt: '2026-09-10T10:00:00.000Z' }],
    });
    hydrateInvoiceStore([{ invoice: august, vorgangId: null }]);
    setAccountingStoreForTests([kontierung('invoice', 'inv-aug')]);
    expect(closeAccountingPeriod(AUG).success).toBe(true);

    const aug = await paket(AUG);
    const zeile = rows(aug.buchungen).find((r) => r.startsWith('Ausgangsrechnung;inv-aug;'))!;
    // Zum 31. August noch offen — die Septemberzahlung zählt hier nicht.
    expect(zeile).toMatch(/;Offen;119,00$/);
    expect(rows(aug.zahlungen)).toEqual([]);
    expect(rows(aug.offenePosten)).toEqual([
      'Forderung;inv-aug;RE-2026-050;2026-08-20;Kunde A;119,00;0,00;119,00;2026-09-30;Offen',
    ]);
    expect(aug.manifest.stichtag).toBe('2026-08-31');
    expect(aug.manifest.summen.offeneForderungenMonatsende).toBe(119);

    // September: die Zahlung gehört hierher (mit Zahlungsart).
    const sepModel = model(SEP);
    expect(sepModel.zahlungenAusgang.map((z) => [z.zahlungId, z.datum, z.betrag, z.zahlungsart])).toEqual([
      ['pay-sep', '2026-09-10', 119, 'bank'],
    ]);
    expect(sepModel.offenePostenMonatsende).toEqual([]);
  });

  it('P2: buchungen.csv, zahlungen.csv, Manifest und Prüfbericht sind konsistent; fehlende Nachweise und unklare Fälle sichtbar', async () => {
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: null }]);
    setExpenseStoreForTests([
      expense({ payments: [{ id: 'pay-exp', date: '2026-09-20', amount: 59.5, method: 'cash', createdAt: '2026-09-20T10:00:00.000Z' }] }),
    ]);
    const upload = processUpload({ kind: 'materialrechnung' });
    hydrateInboxStore([{ ...upload, receivedAt: '2026-09-14T09:00:00.000Z' }]);
    setAccountingStoreForTests([kontierung('invoice', 'inv-1'), kontierung('expense', 'exp-real-1')]);
    expect(closeAccountingPeriod(SEP).success).toBe(true);

    const sep = await paket(SEP);
    const buchungen = rows(sep.buchungen).filter((r) => !r.startsWith('Summe;'));
    expect(buchungen).toHaveLength(2);
    expect(buchungen.find((r) => r.startsWith('Eingangsbeleg;exp-real-1;'))).toMatch(/;Bezahlt;0,00$/);

    const zahlungen = rows(sep.zahlungen);
    expect(zahlungen).toEqual(['Eingangsbeleg;exp-real-1;L-100;pay-exp;2026-09-20;59,50;;Lieferant GmbH;Bar']);

    // Manifest und Dateien sagen dasselbe.
    expect(sep.manifest.counts.buchungen).toBe(buchungen.length);
    expect(sep.manifest.counts.zahlungenEingang).toBe(zahlungen.length);
    expect(sep.manifest.summen.zahlungenEingang).toBe(59.5);
    expect(sep.manifest.counts.offenePostenMonatsende).toBe(rows(sep.offenePosten).length);
    // Ausgabe ohne Originaldokument → fehlender Nachweis; nicht gebuchter Eingangsbeleg → unklar.
    expect(sep.manifest.fehlendeNachweise.map((e: { id: string }) => e.id)).toContain('exp-real-1');
    expect(sep.manifest.unklareFaelle.map((e: { id: string }) => e.id)).toContain(upload.id);
    expect(sep.manifest.uebergabestatus).toMatchObject({ vollstaendig: false, bankabgleich: 'nicht_verfuegbar' });
    expect(sep.pruefbericht).toContain('Originalbeleg fehlt');
    expect(sep.pruefbericht).toContain('Unklare Fälle (1)');
    expect(sep.pruefbericht).toContain('Paket vollständig: nein');
    expect(sep.pruefbericht).toContain('Bankabgleich: noch nicht verfügbar');
    expect(sep.pruefbericht).not.toMatch(/Bankabgleich:\s*(bestätigt|ja)/i);
  });
});

/* ================================================================== */
describe('U — ein gemeinsamer Übergabestatus', () => {
  const status = () => getSteuerberaterMonthOverview(new Date(2026, 8, 16), 'de-DE', SEP);

  function consistent() {
    const overview = status();
    const gate = evaluateAccountingExportReadiness(SEP);
    // Übersicht und Gate widersprechen sich nie.
    expect(overview.handover.packageAllowed).toBe(gate.packageAllowed);
    expect(overview.isComplete).toBe(overview.handover.packageComplete);
    if (overview.state === 'ready') expect(gate.packageAllowed).toBe(true);
    expect(overview.handover.bankReconciliation).toBe('not_available');
    return overview;
  }

  it('U1: nicht abgeschlossen → nicht bereit, Paket gesperrt', () => {
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: null }]);
    setAccountingStoreForTests([kontierung('invoice', 'inv-1')]);
    const overview = consistent();
    expect(overview.handover.state).toBe('not_closed');
    expect(overview.state).toBe('open');
  });

  it('U2: gültig abgeschlossen ohne Lücken → bereit (Bankabgleich trotzdem „nicht verfügbar“)', () => {
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: null }]);
    setAccountingStoreForTests([kontierung('invoice', 'inv-1')]);
    closeAccountingPeriod(SEP);
    const overview = consistent();
    expect(overview.handover).toMatchObject({ state: 'ready', packageAllowed: true, packageComplete: true });
    expect(overview.state).toBe('ready');
  });

  it('U3: seit Abschluss geändert → nicht bereit, Paket gesperrt', () => {
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: null }]);
    setAccountingStoreForTests([kontierung('invoice', 'inv-1')]);
    closeAccountingPeriod(SEP);
    hydrateInvoiceStore([{ invoice: invoice({ amount: 238, subtotal: 200 }), vorgangId: null }]);
    const overview = consistent();
    expect(overview.handover.state).toBe('changed_after_close');
    expect(overview.handover.packageAllowed).toBe(false);
    expect(overview.state).toBe('open');
  });

  it('U4: unklare Fälle → Paket erlaubt, aber nicht vollständig', () => {
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: null }]);
    setAccountingStoreForTests([kontierung('invoice', 'inv-1')]);
    closeAccountingPeriod(SEP);
    const upload = processUpload({ kind: 'materialrechnung' });
    hydrateInboxStore([{ ...upload, receivedAt: '2026-09-14T09:00:00.000Z' }]);
    const overview = consistent();
    expect(overview.handover).toMatchObject({ state: 'unclear_cases', packageAllowed: true, packageComplete: false });
  });

  it('U5: fehlende Nachweise → Abschluss möglich, Paket erlaubt, aber nie „vollständig“', () => {
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: null }]);
    setExpenseStoreForTests([expense()]);
    setAccountingStoreForTests([kontierung('invoice', 'inv-1'), kontierung('expense', 'exp-real-1')]);
    expect(closeAccountingPeriod(SEP).success).toBe(true); // blockiert den Abschluss nicht
    const overview = consistent();
    expect(overview.handover).toMatchObject({ state: 'missing_proofs', packageAllowed: true, packageComplete: false });
    expect(overview.state).toBe('open');
  });
});
