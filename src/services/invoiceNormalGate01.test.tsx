import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { t } from '../i18n';
import { RechnungPage } from '../pages/RechnungPage';
import { createTestVorgang, testSetup } from '../test/fixtures';
import { createNormalPrintSetup, createReverseChargePrintSetup } from '../test/invoicePrintFixtures';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { getDocumentByLinkedInvoiceId, hydrateDocumentStore } from './documentService';
import {
  buildRechnungDraft,
  calculateInvoiceTotals,
  finalizeInvoiceDraft,
  validateInvoiceDraftForApproval,
} from './invoiceService';
import { buildInvoicePrintModel, buildInvoicePrintModelFromInvoice } from './invoicePrintModel';
import { lineTotalMoney, roundMoney, taxCentsFromNet, toCents, fromCents } from './invoiceMoney';
import { getInvoiceNumberSequenceSnapshot, resetInvoiceNumberSequence } from './invoiceNumberService';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import type { InvoiceDraft } from '../types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' as const };

const companyOk = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Gate GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.de',
};

function withBillableDraft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  const { draft } = createNormalPrintSetup();
  return {
    ...draft,
    companySnapshot: { ...companyOk, ...draft.companySnapshot, ...overrides.companySnapshot },
    customerBilling: {
      name: 'Kunde AG',
      contactPerson: '',
      street: 'Weg 2',
      zip: '80333',
      city: 'München',
      email: '',
      phone: '',
      ...overrides.customerBilling,
    },
    positions: draft.positions.map((p) => ({ ...p, quantity: 2, unitPrice: 10.005 })),
    ...overrides,
  };
}

describe('invoiceMoney', () => {
  it('rundet Cent-Grenzfälle und USt konsistent', () => {
    expect(roundMoney(10.005)).toBe(10.01);
    expect(roundMoney(10.004)).toBe(10);
    expect(lineTotalMoney(3, 19.99)).toBe(59.97);
    const netCents = toCents(100.005);
    expect(fromCents(taxCentsFromNet(netCents, 19))).toBe(19);
  });
});

describe('INVOICE-NORMAL-GATE-01 validation', () => {
  beforeEach(() => {
    resetInvoiceNumberSequence();
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore(companyOk);
    hydrateVorgangStore([createTestVorgang()]);
  });

  it('blockiert fehlenden Kunden, Anschrift, Firma, Positionen, Menge 0, Preis, Datum', () => {
    const draft = withBillableDraft({
      customerBilling: {
        name: '',
        contactPerson: '',
        street: '',
        zip: '',
        city: '',
        email: '',
        phone: '',
      },
      companySnapshot: { ...companyOk, companyName: '', street: '', zip: '', city: '' },
      positions: withBillableDraft().positions.map((p) => ({ ...p, quantity: 0 })),
      issueDate: 'invalid',
    });
    const result = validateInvoiceDraftForApproval(draft, companyOk, createTestVorgang());
    const codes = result.blockingErrors.map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining([
      'customer_name',
      'customer_address',
      'company_name',
      'company_address',
      'no_positions',
      'issue_date',
    ]));
  });

  it('warnt bei fehlender IBAN ohne Freigabe zu blockieren', () => {
    const draft = withBillableDraft({
      companySnapshot: { ...companyOk, iban: '' },
    });
    const result = validateInvoiceDraftForApproval(draft, companyOk, createTestVorgang());
    expect(result.blockingErrors).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === 'company_iban')).toBe(true);
  });

  it('§13b ohne Bestätigung blockiert, mit Bestätigung erlaubt 0 USt', () => {
    const { draft, setup } = createReverseChargePrintSetup();
    const ready = withBillableDraft({
      ...draft,
      taxStatus: 'reverse_charge_13b',
      legalNotices: draft.legalNotices,
      positions: draft.positions.map((p) => ({ ...p, quantity: 1, unitPrice: 100 })),
    });
    const blocked = validateInvoiceDraftForApproval(ready, companyOk, createTestVorgang(), {
      reverseCharge13bConfirmed: false,
    });
    expect(blocked.blockingErrors.some((e) => e.code === 'reverse_charge_unconfirmed')).toBe(true);

    const ok = validateInvoiceDraftForApproval(ready, companyOk, createTestVorgang(), {
      reverseCharge13bConfirmed: true,
    });
    expect(ok.blockingErrors).toHaveLength(0);
    const totals = calculateInvoiceTotals(ready, setup);
    expect(totals.tax).toBe(0);
    expect(totals.taxRate).toBe(0);
  });
});

describe('INVOICE-NORMAL-GATE-01 approval', () => {
  beforeEach(() => {
    resetInvoiceNumberSequence();
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore(companyOk);
    hydrateVorgangStore([createTestVorgang()]);
  });

  it('vergibt Nummer erst bei erfolgreicher Freigabe und erzeugt Archiv', () => {
    const beforeSeq = getInvoiceNumberSequenceSnapshot().lastIssuedNumber;
    const draft = withBillableDraft();
    expect(draft.invoiceNumberPreview).toBe('ENTWURF');

    const preview = buildInvoicePrintModel(draft, testSetup);
    expect(preview.invoiceNumber).toMatch(/ENTWURF/i);

    const failed = finalizeInvoiceDraft('missing', draft, testSetup);
    expect(failed.ok).toBe(false);
    expect(getInvoiceNumberSequenceSnapshot().lastIssuedNumber).toBe(beforeSeq);

    const result = finalizeInvoiceDraft('v-test-1', draft, testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.number).toMatch(/^\d{4}-\d{4}$/);
    expect(result.invoice.status).toBe('vorbereitet');
    expect(getDocumentByLinkedInvoiceId(result.invoice.id)?.category).toBe('ausgangsrechnung');

    const print = buildInvoicePrintModelFromInvoice(result.invoice);
    expect(print.summary.subtotalNet).toBe(result.invoice.subtotal);
    expect(print.summary.amountDue).toBe(result.invoice.amount);
    expect(print.summary.taxAmount).toBe(
      calculateInvoiceTotals(draft, testSetup).tax,
    );
  });

  it('Doppelklick-Pfad: zweite Freigabe erzeugt zweite Nummer nur bei neuem Aufruf', () => {
    const draft = withBillableDraft();
    const first = finalizeInvoiceDraft('v-test-1', draft, testSetup);
    const second = finalizeInvoiceDraft('v-test-1', draft, testSetup);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.invoice.id).not.toBe(second.invoice.id);
    expect(first.invoice.number).not.toBe(second.invoice.number);
    expect(getVorgangById('v-test-1')?.invoices).toHaveLength(2);
  });

  it('Vorschau = gespeicherte Totals = PrintModel', () => {
    const draft = withBillableDraft({
      positions: [
        {
          ...withBillableDraft().positions[0],
          quantity: 1.5,
          unitPrice: 33.333,
        },
      ],
    });
    const totals = calculateInvoiceTotals(draft, testSetup);
    const preview = buildInvoicePrintModel(draft, testSetup);
    expect(preview.summary.subtotalNet).toBe(totals.subtotal);
    expect(preview.summary.taxAmount).toBe(totals.tax);
    expect(preview.summary.amountDue).toBe(totals.total);

    const result = finalizeInvoiceDraft('v-test-1', draft, testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.subtotal).toBe(totals.subtotal);
    expect(result.invoice.amount).toBe(totals.total);
    const fromSaved = buildInvoicePrintModelFromInvoice(result.invoice);
    expect(fromSaved.summary.subtotalNet).toBe(totals.subtotal);
    expect(fromSaved.summary.taxAmount).toBe(totals.tax);
  });
});

describe('INVOICE-NORMAL-GATE-01 UI', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    resetInvoiceNumberSequence();
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore(companyOk);
    hydrateVorgangStore([createTestVorgang()]);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
  });

  it('zeigt Entwurf und keine Print-Aktion vor Freigabe; zurück ohne Datenverlust', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/vorgaenge/v-test-1/rechnung']}>
          <AppProvider initialSetup={setupComplete}>
            <Routes>
              <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );
    });

    expect(host.querySelector('[data-testid="invoice-approve"]')).toBeNull();
    expect(host.textContent).not.toMatch(/Drucken|PDF speichern/i);

    const qty = host.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(qty, '3');
      qty.dispatchEvent(new Event('input', { bubbles: true }));
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      (host.querySelector('[data-testid="invoice-continue-preview"]') as HTMLButtonElement).click();
    });

    expect(host.querySelector('[data-testid="invoice-document-number"]')?.textContent).toMatch(
      /Entwurf|Taslak|Чернова/i,
    );
    expect(host.querySelector('[data-testid="invoice-approve"]')).toBeTruthy();
    expect(host.textContent).not.toMatch(/Drucken|PDF speichern/i);

    await act(async () => {
      (host.querySelector('[data-testid="invoice-back-positions"]') as HTMLButtonElement).click();
    });
    const qtyAgain = host.querySelector('input[type="number"]') as HTMLInputElement;
    expect(qtyAgain.value).toBe('3');
  });

  it('DE/TR/BG Keys für Freigabe vorhanden', () => {
    for (const lang of ['de', 'tr', 'bg'] as const) {
      expect(t('invoice.approve', lang).length).toBeGreaterThan(0);
      expect(t('invoice.draftNumberLabel', lang).length).toBeGreaterThan(0);
      expect(t('invoice.reverseCharge.confirmLabel', lang).length).toBeGreaterThan(0);
      expect(t('invoice.validation.customerName', lang).length).toBeGreaterThan(0);
    }
  });
});

describe('buildRechnungDraft still works', () => {
  it('erzeugt Draft ohne Nummer-Reservierung', () => {
    hydrateVorgangStore([createTestVorgang()]);
    hydrateCompanyProfileStore(companyOk);
    const before = getInvoiceNumberSequenceSnapshot().lastIssuedNumber;
    const draft = buildRechnungDraft('v-test-1', testSetup);
    expect(draft?.invoiceNumberPreview).toBe('ENTWURF');
    expect(getInvoiceNumberSequenceSnapshot().lastIssuedNumber).toBe(before);
  });
});
