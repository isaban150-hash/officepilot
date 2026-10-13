/**
 * FINANZ-CORE-01A Fortsetzung — die Client-Seite des Serverpakets.
 *
 *  C1  Steuer-ID und Rechnungsdatum: beim Ausstellen blockiert, beim Nachdruck eines
 *      festgeschriebenen Belegs nicht (Aufbewahrung)
 *  C2  jede neue Serverablehnung der Freigabe ist benannt und „nicht geschrieben" —
 *      unbenannt sperrte sie den Entwurf (RE-01-Muster)
 *  C3  die Meldung nennt den Grund statt „passt nicht mehr zum Auftrag"
 *  C4  die Steuerhinweise folgen dem Steuerstatus, eigene Zusätze bleiben
 *      (Storno gegen laufenden/unklaren Versand: Codes in C2; die Dialogtexte erzwingt
 *      der Typ `Record<CancelInvoiceFailureReason, …>` zur Übersetzungszeit)
 *  C6  kein Versandvermerk nach Storno, kein Versanddatum in der Zukunft
 *  C7  die Korrekturnummer steht im Druckmodell und im Archivdokument
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import { validateFinalizedInvoiceForPdf, validateInvoiceDraftForApproval } from '../invoiceValidationService';
import { classifyInvoiceCloudErrorForTests } from './workspaceInvoiceCloudService';
import { mapCloudErrorForTests } from './invoicePreparedFinalizeService';
import { serverRejectionMessageKey } from './invoiceApprovalUx';
import { buildLegalNotices, normalizeLegalNoticesForTaxStatus } from '../invoiceTaxService';
import { markInvoiceAsSent } from '../invoiceSentService';
import { buildInvoiceCorrectionModel } from './invoiceCorrectionModel';
import { buildInvoiceCorrectionDocumentFromCloudRow, projectInvoiceCorrectionDocument } from './invoiceCorrectionArchive';
import { getBusinessDay } from '../businessDateService';
import { getVorgangInvoice, hydrateVorgangStore } from '../vorgangService';
import type { CompanyProfile, InvoiceDraft, Vorgang, VorgangInvoice } from '../../types/models';
import type { WorkspaceDocumentRow } from '../document/workspaceDocumentCloudService';

const COMPANY = {
  companyName: 'Muster Bau GmbH',
  street: 'Werkstraße 1',
  zip: '33602',
  city: 'Bielefeld',
  taxNumber: '133/8150/8159',
} as CompanyProfile;

function draft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return {
    id: 'draft-1',
    vorgangId: '',
    vorgangTitle: 'Freie Rechnung',
    customer: 'Kunde GmbH',
    baustelle: '',
    type: 'rechnung',
    positions: [
      { id: 'p1', description: 'Montage', quantity: 1, unit: 'Stück', unitPrice: 100, billable: true },
    ],
    issueDate: '2026-10-01',
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-30',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-10-15',
    paymentTermsText: '',
    skontoText: '',
    introText: '',
    closingText: '',
    customerBilling: { name: 'Kunde GmbH', street: 'Weg 1', zip: '33602', city: 'Bielefeld' },
    companySnapshot: COMPANY,
    taxStatus: 'standard_19',
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as InvoiceDraft;
}

function finalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-1',
    number: '2026-0007',
    type: 'rechnung',
    positions: [{ id: 'l1', description: 'Montage', quantity: 1, unit: 'Stück', unitPrice: 100, lineTotal: 100 }],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'vorbereitet',
    date: '2026-10-01',
    issueDate: '2026-10-01',
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-30',
    servicePeriodConfirmed: true,
    createdAt: '2026-10-01T10:00:00.000Z',
    paymentDueDate: '2026-10-15',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: { name: 'Kunde GmbH', street: 'Weg 1', zip: '33602', city: 'Bielefeld' },
    companySnapshot: COMPANY,
    ...overrides,
  } as VorgangInvoice;
}

/** Lokaler Betrieb ohne Cloud: die Rollenregel greift nicht, geprüft wird nur der Beleg. */
const LOKAL = { userId: null, cloudConfigured: false } as const;

function codes(result: { blockingErrors: { code: string }[] }): string[] {
  return result.blockingErrors.map((issue) => issue.code);
}

beforeEach(() => resetTestStores());

describe('FINANZ-CORE-01A Fortsetzung — Client-Seite des Serverpakets', () => {
  it('C1 Steuer-ID und künftiges Datum blockieren das Ausstellen, nicht den Nachdruck', () => {
    expect(codes(validateInvoiceDraftForApproval(draft(), COMPANY, undefined))).not.toContain('company_tax_id');

    const ohneSteuer = { ...COMPANY, taxNumber: '', vatId: '' } as CompanyProfile;
    expect(codes(validateInvoiceDraftForApproval(draft({ companySnapshot: ohneSteuer }), ohneSteuer, undefined))).toContain(
      'company_tax_id',
    );
    const nurUstId = { ...COMPANY, taxNumber: '', vatId: 'DE123456789' } as CompanyProfile;
    expect(codes(validateInvoiceDraftForApproval(draft({ companySnapshot: nurUstId }), nurUstId, undefined))).not.toContain(
      'company_tax_id',
    );

    const morgen = new Date(`${getBusinessDay()}T12:00:00.000Z`);
    morgen.setUTCDate(morgen.getUTCDate() + 2);
    const zukunft = morgen.toISOString().slice(0, 10);
    expect(codes(validateInvoiceDraftForApproval(draft({ issueDate: zukunft }), COMPANY, undefined))).toContain(
      'issue_date_future',
    );

    // Ein festgeschriebener Altbeleg ohne Steuer-ID bleibt druckbar.
    const alt = finalizedInvoice({ companySnapshot: ohneSteuer, issueDate: zukunft, date: zukunft });
    const pdf = codes(validateFinalizedInvoiceForPdf(alt));
    expect(pdf).not.toContain('company_tax_id');
    expect(pdf).not.toContain('issue_date_future');
  });

  it('C2 die neuen Serverablehnungen sind benannt und nachweislich nicht geschrieben', () => {
    const faelle: [string, string][] = [
      ['invoice_company_tax_id_missing', 'company_incomplete'],
      ['invoice_company_incomplete', 'company_incomplete'],
      ['invoice_issue_date_in_future', 'date_invalid'],
      ['invoice_issue_date_invalid', 'date_invalid'],
      ['invoice_service_period_invalid', 'date_invalid'],
      ['invoice_abschlag_number_taken: 2', 'abschlag_number_taken'],
      ['invoice_legal_notice_missing', 'tax_status_mismatch'],
      ['invoice_deductions_exceed_total: 150000 > 100000', 'totals_mismatch'],
      ['invoice_positions_missing', 'position_mismatch'],
      ['invoice_customer_address_incomplete', 'customer_mismatch'],
    ];
    for (const [message, code] of faelle) {
      const fehler = classifyInvoiceCloudErrorForTests({ message, code: 'P0001' });
      expect(fehler.code, message).toBe(code);
      const ux = mapCloudErrorForTests(fehler.code, message);
      expect(ux, message).toEqual({ reason: 'server_integrity_rejected', cloudState: 'not_committed' });
    }
    expect(classifyInvoiceCloudErrorForTests({ message: 'invoice_cancel_delivery_in_progress' }).code).toBe(
      'cancel_delivery_in_progress',
    );
    expect(classifyInvoiceCloudErrorForTests({ message: 'invoice_cancel_delivery_uncertain' }).code).toBe(
      'cancel_delivery_uncertain',
    );
  });

  it('C3 die Meldung nennt den Grund; unbekannt bleibt der neutrale Satz', () => {
    expect(serverRejectionMessageKey('invoice_company_tax_id_missing')).toBe('invoice.approve.companyTaxIdMissing');
    expect(serverRejectionMessageKey('invoice_issue_date_in_future')).toBe('invoice.approve.issueDateFuture');
    expect(serverRejectionMessageKey('invoice_abschlag_number_taken: 3')).toBe('invoice.approve.abschlagNumberTaken');
    expect(serverRejectionMessageKey('invoice_deductions_mismatch')).toBe('invoice.approve.deductionsMismatch');
    expect(serverRejectionMessageKey('invoice_totals_mismatch: netto')).toBe('invoice.approve.serverRejected');
    expect(serverRejectionMessageKey(undefined)).toBe('invoice.approve.serverRejected');
  });

  it('C4 Steuerhinweise passend zum Steuerstatus; eigene Zusätze bleiben, passende Listen unverändert', () => {
    const p19 = buildLegalNotices('kleinunternehmer_19')[0];
    const p13b = buildLegalNotices('reverse_charge_13b')[0];
    const unklar = buildLegalNotices('unclear')[0];

    // Statuswechsel 19 % -> Kleinunternehmer ohne neue Hinweise: der Pflichthinweis kommt.
    expect(normalizeLegalNoticesForTaxStatus('kleinunternehmer_19', [])).toEqual([p19]);
    // Kleinunternehmer -> 19 %: der fremde Hinweis fällt, der eigene Zusatz bleibt.
    expect(normalizeLegalNoticesForTaxStatus('standard_19', [p19, 'Zahlbar ohne Abzug.'])).toEqual(['Zahlbar ohne Abzug.']);
    // Der Platzhalter „Steuerstatus ergänzen" verschwindet nach der Entscheidung.
    expect(normalizeLegalNoticesForTaxStatus('reverse_charge_13b', [unklar])).toEqual([p13b]);
    // Steuerfrei mit eigenem Hinweis aus dem Profil.
    const profil = { taxFreeNotice: 'Steuerfrei nach § 4 Nr. 11 UStG.' };
    expect(normalizeLegalNoticesForTaxStatus('tax_free', [], profil)).toEqual(['Steuerfrei nach § 4 Nr. 11 UStG.']);
    // Passt schon: dieselbe Liste in derselben Reihenfolge.
    expect(normalizeLegalNoticesForTaxStatus('kleinunternehmer_19', ['Danke.', p19])).toEqual(['Danke.', p19]);
  });

  it('C6 kein Versandvermerk nach Storno und kein Versanddatum in der Zukunft', () => {
    hydrateVorgangStore([
      {
        ...createTestVorgang({
          id: 'v-c6',
          status: 'beauftragt',
          orderPositions: [createOrderPosition({ id: 'op-1', unit: 'Stück', plannedQuantity: 5, unitPrice: 100 })],
        }),
        invoices: [
          finalizedInvoice({ id: 'inv-storniert', cancelledAt: '2026-10-05T09:00:00.000Z', cancelReason: 'Fehler', cancellationKind: 'internal' }),
          finalizedInvoice({ id: 'inv-offen', number: '2026-0008' }),
        ],
      } as Vorgang,
    ]);
    expect(markInvoiceAsSent('v-c6', 'inv-storniert', { sentAt: '2026-10-06', sentVia: 'email' }, LOKAL)).toEqual({
      ok: false,
      reason: 'cancelled',
    });
    expect(getVorgangInvoice('v-c6', 'inv-storniert')?.status).toBe('vorbereitet');

    const spaeter = new Date(`${getBusinessDay()}T12:00:00.000Z`);
    spaeter.setUTCDate(spaeter.getUTCDate() + 3);
    expect(
      markInvoiceAsSent('v-c6', 'inv-offen', { sentAt: spaeter.toISOString().slice(0, 10), sentVia: 'post' }, LOKAL),
    ).toEqual({ ok: false, reason: 'invalid_date' });
  });

  it('C7 die Korrekturnummer steht im Druckmodell und im Archivdokument — auf beiden Wegen gleich', () => {
    const storniert = finalizedInvoice({
      status: 'versendet',
      cancelledAt: '2026-10-08T09:00:00.000Z',
      cancelReason: 'Falsche Menge',
      cancellationKind: 'correction',
      correctionDocumentId: 'corr-inv-1',
      correctionNumber: '2026-0009',
    });
    const modell = buildInvoiceCorrectionModel(storniert, {
      cancelledAt: storniert.cancelledAt!,
      cancelReason: storniert.cancelReason!,
    });
    expect(modell.correction?.correctionNumber).toBe('2026-0009');

    const lokal = projectInvoiceCorrectionDocument(storniert, null)!;
    expect(lokal.title).toBe('Rechnungskorrektur 2026-0009 zu Rechnung 2026-0007');
    expect(lokal.tags).toContain('2026-0009');

    const row = {
      workspaceId: 'ws',
      clientDocumentId: 'corr-inv-1',
      linkedInvoiceId: 'inv-1',
      linkedVorgangId: null,
      documentKind: 'generated_invoice_correction',
      payload: {
        documentType: 'rechnungskorrektur',
        originalClientInvoiceId: 'inv-1',
        originalInvoiceNumber: '2026-0007',
        originalIssueDate: '2026-10-01',
        cancelledAt: '2026-10-08T09:00:00.000Z',
        correctionIssueDate: '2026-10-08',
        cancelReason: 'Falsche Menge',
        correctionNumber: '2026-0009',
        companySnapshot: { companyName: 'Muster Bau GmbH' },
        customerSnapshot: { name: 'Kunde GmbH' },
        originalInvoiceSnapshot: { amount: 119 },
      },
      createdAt: '2026-10-08T09:00:00.000Z',
      updatedAt: '2026-10-08T09:00:00.000Z',
      rowVersion: 1,
    } as unknown as WorkspaceDocumentRow;
    const ausCloud = buildInvoiceCorrectionDocumentFromCloudRow(row)!;
    expect(ausCloud.title).toBe(lokal.title);

    // Altbestand ohne Nummer behält den bisherigen Titel.
    const alt = projectInvoiceCorrectionDocument({ ...storniert, correctionNumber: undefined }, null)!;
    expect(alt.title).toBe('Rechnungskorrektur zu Rechnung 2026-0007');
  });
});
