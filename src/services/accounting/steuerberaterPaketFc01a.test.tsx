/**
 * FINANZ-CORE-01A — Steuerberater-Paket (BUH-05, BUH-10, BUH-14 Summenzeile).
 *
 *  P5a  der PDF-Lader nennt den konkreten Prüfgrund; die Oberfläche übersetzt ihn
 *  P5b  ein gescheitertes Paket nennt Beleg, Grund und Abhilfe statt nur „nicht erstellt"
 *  P5c  Rechnungen, an denen das Paket scheitern würde, stehen vor dem Klick da (mit Weg zur Rechnung)
 *  P5d  die Vorprüfung findet genau die Rechnungen des Monats, deren PDF nicht entsteht
 *  P5e  das Exportergebnis erreicht das Panel vollständig (Datei oder Beleg und Grund)
 *  P10a Ausgangsrechnung trägt Leistungszeitraum und Skontoabzug (zum Monatsende)
 *  P10b buchungen.csv: zwei neue Spalten am Ende, Summenzeile so breit wie der Kopf
 *  P10c eine Barzahlung ohne unterschriebenen Nachweis ist ein fehlender Nachweis
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { AccountingExportPanel, buildAccountingExportFeedback } from '../../components/accounting/AccountingExportPanel';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { t, type TranslationKey } from '../../i18n';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { buildInvoiceReachPath } from '../invoiceNavigation';
import { buildMonatsmappeModel, type MonatsmappeInput } from '../steuerberater/monatsmappeModelService';
import { hydrateVorgangStore } from '../vorgangService';
import { buildBookingCsv, buildBookingExport } from './accountingBookingExportService';
import { buildAccountingExportPackage } from './accountingExportPackageService';
import {
  describeAccountingExportFailure,
  findAccountingExportPdfProblems,
  pdfLoadFailureDetail,
} from './accountingExportPdfCheck';
import { buildPeriodFingerprint, buildPeriodManifest } from './accountingPeriodFingerprint';
import type { AccountingExportReadiness } from './accountingExportGateService';
import type { AccountingAssignment } from '../../types/accounting';
import type { EmployeePayment } from '../../types/employee';
import type { VorgangInvoice } from '../../types/models';

const translate = (key: TranslationKey): string => t(key);

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-p',
    number: '2026-0910',
    type: 'rechnung',
    positions: [{ id: 'l1', orderPositionId: 'op-1', description: 'Arbeit', quantity: 1, unit: 'Stück', unitPrice: 100, lineTotal: 100 }],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    date: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z',
    issueDate: '2026-09-01',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-31',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-09-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    skontoText: '',
    currencyCode: 'EUR',
    customerSnapshot: { name: 'Kunde A', contactPerson: '', street: 'Weg 1', zip: '10115', city: 'Berlin', email: '', phone: '' },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', street: 'Werkstraße 2', zip: '54321', city: 'Betriebsstadt', taxNumber: '11/222/33333' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    payments: [],
    ...overrides,
  } as unknown as VorgangInvoice;
}

function eingabe(overrides: Partial<MonatsmappeInput> = {}): MonatsmappeInput {
  return { monthKey: '2026-09', invoices: [], expenses: [], documents: [], inboxItems: [], fileRefs: [], ...overrides };
}

function kontierung(sourceId: string): AccountingAssignment {
  return {
    id: `acc-${sourceId}`,
    sourceType: 'invoice',
    sourceId,
    chartOfAccounts: 'SKR03',
    accountNumber: '8400',
    accountLabel: 'Erlöse',
    taxTreatment: 'standard_19',
    bookingText: 'Test',
    status: 'confirmed',
    origin: 'manual',
    createdAt: 'x',
    updatedAt: 'x',
  } as AccountingAssignment;
}

const BEREIT = { monthKey: '2026-09', packageAllowed: true, packageBlockers: [], datevAllowed: false, datevBlockers: [], state: {} } as unknown as AccountingExportReadiness;

function panel(props: Partial<Parameters<typeof AccountingExportPanel>[0]>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AccountingExportPanel readiness={BEREIT} onCreatePackage={async () => null} translate={translate} {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetTestStores();
});

/* ================================================================== */
/* BUH-05                                                              */
/* ================================================================== */

describe('BUH-05 — ein gescheitertes Paket nennt Beleg und Grund', () => {
  it('P5a: der Lader nennt den Prüfgrund, die Oberfläche übersetzt ihn', () => {
    const detail = pdfLoadFailureDetail({
      reason: 'validation_failed',
      validation: { blockingErrors: [{ messageKey: 'invoice.validation.servicePeriodUnconfirmed' }] },
    });
    expect(detail).toBe('pdf_validation_failed:invoice.validation.servicePeriodUnconfirmed');
    expect(describeAccountingExportFailure(detail)).toBe('invoice.validation.servicePeriodUnconfirmed');
    expect(pdfLoadFailureDetail({ reason: 'encode_failed' })).toBe('pdf_encode_failed');
    expect(describeAccountingExportFailure('pdf_encode_failed')).toBe('accountingExport.failure.pdf');
    expect(describeAccountingExportFailure('blob_unavailable')).toBe('accountingExport.failure.file');
    expect(describeAccountingExportFailure('etwas_anderes')).toBe('accountingExport.failure.unknown');
  });

  it('P5b: Beleg, Grund und Abhilfe statt nur „nicht erstellt"', () => {
    const html = panel({
      lastResult: {
        fileName: null,
        failure: {
          outcome: 'document_load_failed',
          failed: [{ fileName: '2026-0910_abc.pdf', detail: 'pdf_validation_failed:invoice.validation.servicePeriodUnconfirmed' }],
        },
      },
    });
    expect(html).toContain('data-testid="accounting-export-failed"');
    expect(html).toContain('data-testid="accounting-export-failed-documents"');
    expect(html).toContain('2026-0910_abc.pdf');
    expect(html).toContain(t('invoice.validation.servicePeriodUnconfirmed' as TranslationKey));
    expect(html).toContain(t('accountingExport.failure.remedy' as TranslationKey));

    const gesperrt = panel({ lastResult: { fileName: null, failure: { outcome: 'blocked' } } });
    expect(gesperrt).toContain('data-testid="accounting-export-failed-blocked"');
    expect(gesperrt).toContain(t('accountingExport.failure.blocked' as TranslationKey));
  });

  it('P5c: Rechnungen, an denen das Paket scheitern würde, stehen vor dem Klick da', () => {
    const html = panel({
      pdfProblems: [{ invoiceId: 'inv-x', invoiceNumber: '2026-0911', vorgangId: 'v-1', messageKey: 'invoice.validation.servicePeriodUnconfirmed' as TranslationKey }],
    });
    expect(html).toContain('data-testid="accounting-export-pdf-problems"');
    expect(html).toContain('2026-0911');
    expect(html).toContain(`href="${buildInvoiceReachPath('v-1', 'inv-x')}"`);
    expect(html).toContain(t('invoice.validation.servicePeriodUnconfirmed' as TranslationKey));
    // Ohne Befund kein Hinweis.
    expect(panel({ pdfProblems: [] })).not.toContain('accounting-export-pdf-problems');
  });

  it('P5d: die Vorprüfung findet genau die Rechnungen des Monats, deren PDF nicht entsteht', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-p5',
        invoices: [
          rechnung({ id: 'inv-ok', number: '2026-0912' }),
          rechnung({ id: 'inv-alt', number: '2026-0913', servicePeriodConfirmed: false }),
          rechnung({ id: 'inv-okt', number: '2026-1001', date: '2026-10-02', issueDate: '2026-10-02', servicePeriodConfirmed: false }),
        ],
      }),
    ]);
    const probleme = findAccountingExportPdfProblems('2026-09');
    expect(probleme.map((p) => [p.invoiceId, p.messageKey])).toEqual([['inv-alt', 'invoice.validation.servicePeriodUnconfirmed']]);
    expect(probleme[0]?.vorgangId).toBe('v-p5');
  });
});

describe('BUH-05 — Ergebnis an das Panel', () => {
  it('P5e: das Exportergebnis erreicht das Panel vollständig', () => {
    expect(buildAccountingExportFeedback('2026-09', { outcome: 'exported', fileName: 'Paket.zip', documentCount: 1, manifest: {} })).toEqual({
      monthKey: '2026-09',
      fileName: 'Paket.zip',
    });
    const failed = [{ id: 'inv-1', fileName: 'a.pdf', detail: 'pdf_encode_failed' }];
    expect(buildAccountingExportFeedback('2026-09', { outcome: 'document_load_failed', failed })).toEqual({
      monthKey: '2026-09',
      fileName: null,
      failure: { outcome: 'document_load_failed', failed },
    });
    expect(buildAccountingExportFeedback('2026-09', { outcome: 'forbidden' }).failure).toEqual({ outcome: 'forbidden' });
  });
});

/* ================================================================== */
/* BUH-10                                                              */
/* ================================================================== */

describe('BUH-10 — Skonto, Leistungszeitraum, Barzahlung ohne Nachweis', () => {
  const skontoRechnung = () =>
    rechnung({
      id: 'inv-sk',
      number: '2026-0920',
      skontoText: '2 % Skonto bei Zahlung innerhalb von 10 Tagen',
      payments: [{ id: 'pay-sk', date: '2026-09-05', amount: 116.62, method: 'bank', createdAt: 'x' }],
    } as Partial<VorgangInvoice>);

  it('P10a: Ausgangsrechnung trägt Leistungszeitraum und Skontoabzug', () => {
    const model = buildMonatsmappeModel(eingabe({ invoices: [{ invoice: skontoRechnung(), vorgangId: 'v-1' }] }));
    const beleg = model.ausgangsrechnungen[0]!;
    expect(beleg.leistungszeitraum).toBe('2026-08-01 bis 2026-08-31');
    expect(beleg.skontoAbzug).toBe(2.38);
    expect(beleg.offenerBetrag).toBe(0);
    // Eine Teilzahlung ohne Skonto ist kein Skontoabzug.
    const teil = buildMonatsmappeModel(
      eingabe({ invoices: [{ invoice: rechnung({ payments: [{ id: 'p', date: '2026-09-05', amount: 50, method: 'bank', createdAt: 'x' }] } as Partial<VorgangInvoice>), vorgangId: 'v-1' }] }),
    );
    expect(teil.ausgangsrechnungen[0]?.skontoAbzug).toBeUndefined();
    // Ein Tag als Zeitraum bleibt ein Tag.
    const tag = buildMonatsmappeModel(
      eingabe({ invoices: [{ invoice: rechnung({ servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-01' }), vorgangId: 'v-1' }] }),
    );
    expect(tag.ausgangsrechnungen[0]?.leistungszeitraum).toBe('2026-09-01');
  });

  it('P10b: buchungen.csv — Leistungszeitraum und Skonto am Ende, Summenzeile so breit wie der Kopf', () => {
    const model = buildMonatsmappeModel(eingabe({ invoices: [{ invoice: skontoRechnung(), vorgangId: 'v-1' }] }));
    const csv = buildBookingCsv(buildBookingExport(model, [kontierung('inv-sk')], 'SKR03'));
    const zeilen = csv.replace(/^﻿/, '').trim().split('\r\n').map((line) => line.split(';'));
    const [kopf, zeile, summe] = zeilen;
    expect(kopf!.slice(-2)).toEqual(['Leistungszeitraum', 'Skonto (Abzug)']);
    expect(zeile![kopf!.indexOf('Leistungszeitraum')]).toBe('2026-08-01 bis 2026-08-31');
    expect(zeile![kopf!.indexOf('Skonto (Abzug)')]).toBe('2,38');
    expect(summe!.length).toBe(kopf!.length);
    expect(summe![0]).toBe('Summe');
    expect(summe![kopf!.indexOf('Brutto')]).toBe('119,00');
    expect(summe![kopf!.indexOf('Skonto (Abzug)')]).toBe('2,38');

    // Ohne Skonto: die Summenzeile bleibt so breit wie der Kopf (bisher 19 statt 21 Zellen).
    const ohne = buildMonatsmappeModel(eingabe({ invoices: [{ invoice: rechnung({ id: 'inv-o' }), vorgangId: 'v-1' }] }));
    const ohneZeilen = buildBookingCsv(buildBookingExport(ohne, [kontierung('inv-o')], 'SKR03'))
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
      .map((line) => line.split(';'));
    expect(ohneZeilen.at(-1)!.length).toBe(ohneZeilen[0]!.length);
    expect(ohneZeilen.at(-1)![ohneZeilen[0]!.indexOf('Skonto (Abzug)')]).toBe('');
  });

  it('P10c: eine Barzahlung ohne unterschriebenen Nachweis ist ein fehlender Nachweis', async () => {
    const zahlung = {
      id: 'ep-1',
      receiptReference: 'MZ-2026-0007',
      paymentDate: '2026-09-12',
      employeeName: 'A. Beispiel',
      kind: 'wage',
      wageMonth: '2026-09',
      paymentMethod: 'cash',
      amount: 500,
      createdAt: 'x',
      updatedAt: 'x',
    } as unknown as EmployeePayment;
    const model = buildMonatsmappeModel(eingabe({ employeePayments: [zahlung] }));
    const manifest = buildPeriodManifest(model, [], 'SKR03');
    const paket = await buildAccountingExportPackage(
      {
        model,
        bookings: buildBookingExport(model, [], 'SKR03'),
        closure: { id: 'c1', monthKey: '2026-09', revision: 1, closedAt: 'x', fingerprint: buildPeriodFingerprint(manifest), manifest, createdAt: 'x', updatedAt: 'x' },
        currentFingerprint: buildPeriodFingerprint(manifest),
        workspaceId: 'ws',
        exportedAt: 'x',
      },
      { invoicePdf: async () => new Uint8Array(), invoiceCorrectionPdf: async () => new Uint8Array(), fileRefBytes: async () => new Uint8Array() },
    );
    expect(paket.ok).toBe(true);
    if (!paket.ok) return;
    const uebergabe = paket.manifest.uebergabestatus as { vollstaendig: boolean };
    expect(uebergabe.vollstaendig).toBe(false);
    const fehlend = paket.manifest.fehlendeNachweise as Array<{ id: string; titel: string }>;
    expect(fehlend.map((entry) => entry.id)).toContain('ep-1');
    expect(fehlend.find((entry) => entry.id === 'ep-1')?.titel).toContain('MZ-2026-0007');
  });
});
