import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { createTestVorgang, testSetup } from '../test/fixtures';
import {
  archiveOutgoingInvoice,
  buildOutgoingInvoiceDocumentInput,
  isFinalizedInvoice,
} from './invoiceArchiveService';
import {
  getAllDocuments,
  getDocumentByLinkedInvoiceId,
  hydrateDocumentStore,
  searchDocuments,
} from './documentService';
import { finalizeInvoiceDraft, buildAbschlagDraft } from './invoiceService';
import { hydrateVorgangStore, getVorgangById } from './vorgangService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import type { VorgangInvoice } from '../types/models';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster GmbH',
  street: 'Hauptstraße 1',
  zip: '80331',
  city: 'München',
  iban: 'DE00 0000 0000 0000 0000 00',
};

function createFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-archive-1',
    number: '2026-0099',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-test-1',
        description: 'Testleistung',
        quantity: 5,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: 325,
      },
    ],
    subtotal: 325,
    taxStatus: 'standard_19',
    amount: 386.75,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-31',
    paymentDueDate: '2026-06-15',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    skontoText: '',
    customerSnapshot: {
      name: 'Test Kunde',
      contactPerson: 'Frau Test',
      street: 'Kundenweg 2',
      zip: '80333',
      city: 'München',
      email: '',
      phone: '',
    },
    companySnapshot,
    legalNotices: [],
    previousAbschlagDeductions: [],
    introText: 'Einleitung',
    closingText: 'Schluss',
    baustelle: 'Teststraße 1',
    vorgangTitle: 'Testvorgang',
    ...overrides,
  };
}

describe('buildOutgoingInvoiceDocumentInput', () => {
  it('creates ausgangsrechnung document metadata', () => {
    const vorgang = createTestVorgang();
    const invoice = createFinalizedInvoice();

    const input = buildOutgoingInvoiceDocumentInput(invoice, vorgang, 'Muster GmbH');

    expect(input.category).toBe('ausgangsrechnung');
    expect(input.linkedInvoiceId).toBe(invoice.id);
    expect(input.linkedVorgang?.vorgangId).toBe(vorgang.id);
    expect(input.recognizedText).toContain(invoice.number);
    expect(input.recognizedText).toContain('Test Kunde');
    expect(input.tags).toContain('Ausgangsrechnung');
  });
});

describe('archiveOutgoingInvoice', () => {
  beforeEach(() => {
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore(companySnapshot);
  });

  it('creates archive document and links invoice', () => {
    const invoice = createFinalizedInvoice();
    const vorgang = createTestVorgang({ invoices: [invoice] });
    hydrateVorgangStore([vorgang]);

    const result = archiveOutgoingInvoice(vorgang.id, invoice, 'Muster GmbH');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(true);
    expect(result.invoice.archiveDocumentId).toBe(result.document.id);
    expect(getDocumentByLinkedInvoiceId(invoice.id)?.id).toBe(result.document.id);
    expect(getVorgangById(vorgang.id)?.invoices.find((item) => item.id === invoice.id)?.archiveDocumentId).toBe(
      result.document.id,
    );
  });

  it('does not create duplicate archive documents', () => {
    const vorgang = createTestVorgang({ invoices: [createFinalizedInvoice()] });
    hydrateVorgangStore([vorgang]);
    const invoice = vorgang.invoices[0];

    const first = archiveOutgoingInvoice(vorgang.id, invoice, 'Muster GmbH');
    const updated = getVorgangById(vorgang.id)!.invoices.find((item) => item.id === invoice.id)!;
    const second = archiveOutgoingInvoice(vorgang.id, updated, 'Muster GmbH');

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    expect(getAllDocuments()).toHaveLength(1);
  });

  it('is searchable by invoice number and customer', () => {
    const invoice = createFinalizedInvoice();
    const vorgang = createTestVorgang({ invoices: [invoice] });
    hydrateVorgangStore([vorgang]);
    archiveOutgoingInvoice(vorgang.id, invoice, 'Muster GmbH');

    expect(searchDocuments('2026-0099', 'ausgangsrechnung')).toHaveLength(1);
    expect(searchDocuments('Test Kunde', 'all')).toHaveLength(1);
    expect(searchDocuments('Testvorgang', 'all')).toHaveLength(1);
  });
});

describe('finalizeInvoiceDraft archive integration', () => {
  beforeEach(() => {
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore(companySnapshot);
    const vorgang = createTestVorgang();
    hydrateVorgangStore([vorgang]);
  });

  it('archives outgoing invoice on finalize', () => {
    const draft = buildAbschlagDraft('v-test-1', testSetup);
    expect(draft).not.toBeNull();

    draft!.positions[0].quantity = 4;
    const result = finalizeInvoiceDraft('v-test-1', draft!, testSetup);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.archiveDocumentId).toBeTruthy();
    expect(getDocumentByLinkedInvoiceId(result.invoice.id)?.category).toBe('ausgangsrechnung');
  });
});

describe('isFinalizedInvoice', () => {
  it('returns true for vorbereitet and versendet', () => {
    expect(isFinalizedInvoice(createFinalizedInvoice({ status: 'vorbereitet' }))).toBe(true);
    expect(isFinalizedInvoice(createFinalizedInvoice({ status: 'versendet' }))).toBe(true);
    expect(isFinalizedInvoice(createFinalizedInvoice({ status: 'entwurf' }))).toBe(false);
  });
});
