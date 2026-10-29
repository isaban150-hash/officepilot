/**
 * P1-KORREKTURBLOCK A-04 — offene Steueraufteilung im Steuerberaterpaket und im Übergabestatus.
 *
 * Abschliessbar ist ein Monat mit offener Aufteilung nur, wenn die Ausgabe inzwischen storniert ist (sonst sperrt
 * `tax_split_open`). Genau dieser Fall wird hier ganz durchgespielt: September erfasst (offen), im Oktober storniert,
 * September abgeschlossen und übergeben. Erwartet: keine Buchungszeile mit erfundenen Werten, der Fall als „unklar“
 * benannt, Übersicht und Paket einig. Synthetische Daten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { setExpenseStoreForTests } from '../expenseStore';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { setAccountingStoreForTests } from './accountingStore';
import { setAccountingPeriodStoreForTests } from './accountingPeriodStore';
import { closeAccountingPeriod, getAccountingPeriodState } from './accountingPeriodService';
import { abschluesseServerbestaetigt } from '../../test/accountingClosureTestUtils';
import { buildAccountingExport } from './accountingExportRunner';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { getSteuerberaterHandoverStatus } from '../steuerberaterOverviewService';
import type { MonatsmappeDocumentLoaders } from '../steuerberater/monatsmappeExportService';
import type { AccountingAssignment } from '../../types/accounting';
import type { Expense } from '../../types/expense';

const SEP = '2026-09';

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-a04-paket',
    status: 'gebucht',
    category: 'material',
    supplierName: 'A04 Paketlieferant',
    invoiceNumber: 'A04-P-1',
    title: 'A04 Paketbeleg',
    description: '',
    issueDate: '2026-09-12',
    paymentDueDate: null,
    taxStatus: 'standard_19',
    netAmount: 59.5,
    taxAmount: 0,
    grossAmount: 59.5,
    taxSplit: 'offen',
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'a04 paketlieferant|a04-p-1',
    tags: [],
    digitalFolder: { id: 'dig', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'x' },
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    ...overrides,
  } as Expense;
}

function kontierung(sourceId: string): AccountingAssignment {
  return {
    id: `k-${sourceId}`,
    sourceType: 'expense',
    sourceId,
    chartOfAccounts: 'SKR03',
    accountNumber: '3400',
    accountLabel: 'Wareneingang',
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

async function paket(monthKey: string) {
  resetSyncOutboxForTests(getSyncOutboxSnapshot().map((entry) => ({ ...entry, status: 'completed' as const })));
  abschluesseServerbestaetigt();
  const { result, blob } = await buildAccountingExport({ monthKey, userId: undefined, skipGate: true, loaders });
  expect(result.outcome, JSON.stringify(result)).toBe('exported');
  const zip = await JSZip.loadAsync(blob!);
  const root = Object.keys(zip.files)[0].split('/')[0];
  const read = (path: string) => zip.file(`${root}/${path}`)!.async('string');
  return {
    buchungen: await read('01_Buchungsdaten/buchungen.csv'),
    pruefbericht: await read('00_Abschluss/pruefbericht.txt'),
    manifest: JSON.parse(await read('00_Abschluss/manifest.json')) as Record<string, any>,
  };
}

const zeilen = (csv: string) => csv.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1);

beforeEach(() => {
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  setExpenseStoreForTests([]);
  hydrateInvoiceStore([]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-0000000a0400',
      settings: { chartOfAccounts: 'SKR03' },
      version: 1,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  });
});

describe('A-04 — offene Steueraufteilung im Steuerberaterpaket', () => {
  it('P1: nicht storniert — der Monat ist nicht abschliessbar (tax_split_open)', () => {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung('exp-a04-paket')]);
    const state = getAccountingPeriodState(SEP);
    expect(state.blockers.find((blocker) => blocker.code === 'tax_split_open')?.sourceIds).toEqual(['exp-a04-paket']);
    expect(closeAccountingPeriod(SEP).success).toBe(false);
    // Und die Übergabe nennt sie als unklaren Fall.
    expect(getSteuerberaterHandoverStatus(SEP).counts.unclearCases).toBe(1);
  });

  it('P2: im Folgemonat storniert — September abschliessbar; das Paket bucht nichts Erfundenes und nennt den Fall', async () => {
    setExpenseStoreForTests([
      ausgabe({ status: 'storniert', cancelledAt: '2026-10-02T10:00:00.000Z', cancelReason: 'A04 Test', paymentStatus: 'storniert' }),
    ]);
    setAccountingStoreForTests([kontierung('exp-a04-paket')]);
    expect(getAccountingPeriodState(SEP).blockers.map((blocker) => blocker.code)).not.toContain('tax_split_open');
    expect(closeAccountingPeriod(SEP).success).toBe(true);

    const sep = await paket(SEP);
    expect(zeilen(sep.buchungen).filter((zeile) => zeile.includes('exp-a04-paket'))).toEqual([]);
    expect(sep.manifest.unklareFaelle).toContainEqual({
      id: 'exp-a04-paket',
      titel: 'Steueraufteilung offen (Netto/Vorsteuer nicht belegt), nicht gebucht: A04-P-1',
    });
    expect(sep.manifest.uebergabestatus.vollstaendig).toBe(false);
    expect(sep.pruefbericht).toContain('Steueraufteilung offen (Netto/Vorsteuer nicht belegt), nicht gebucht: A04-P-1');

    // Übersicht und Paket sind sich einig: ein unklarer Fall, nicht „vollständig“.
    const status = getSteuerberaterHandoverStatus(SEP);
    expect(status.counts.unclearCases).toBe(1);
    expect(status.packageComplete).toBe(false);
  });
});
