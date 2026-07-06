import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { buildInvoicePrintModel } from '../services/invoicePrintModel';
import { buildLegalNotices } from '../services/invoiceTaxService';
import type { CompanySetup, InvoiceDraft } from '../types/models';
import { createTestVorgang, testSetup } from './fixtures';

const companyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster Handwerk GmbH',
  legalForm: 'GmbH',
  street: 'Werkstraße 12',
  zip: '80331',
  city: 'München',
  phone: '+49 89 123456',
  email: 'rechnung@muster-handwerk.de',
  website: 'www.muster-handwerk.de',
  taxNumber: '143/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse München',
  iban: 'DE89 3704 0044 0532 0130 00',
  bic: 'COBADEFFXXX',
  invoiceFooterNotes: 'Vielen Dank für Ihr Vertrauen.',
};

function createDraftBase(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  const vorgang = createTestVorgang();

  return {
    id: 'draft-test',
    vorgangId: vorgang.id,
    vorgangTitle: vorgang.title,
    customer: vorgang.customer,
    baustelle: vorgang.baustelle,
    type: 'rechnung',
    abschlagNumber: undefined,
    taxStatus: 'standard_19',
    materialSource: 'betrieb',
    positions: [
      {
        id: 'draft-pos-op-test-1',
        orderPositionId: 'op-test-1',
        description: 'Fliesenarbeiten Bad',
        plannedQuantity: 10,
        billedQuantity: 0,
        openQuantity: 10,
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 65,
        category: 'arbeit',
        billable: true,
      },
    ],
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-31',
    paymentDueDate: '2026-06-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    skontoText: '',
    customerBilling: {
      name: 'Bauherr Müller',
      contactPerson: 'Frau Müller',
      street: 'Gartenweg 5',
      zip: '80333',
      city: 'München',
      email: 'mueller@example.de',
      phone: '089 998877',
    },
    companySnapshot: companyProfile,
    legalNotices: buildLegalNotices('standard_19'),
    previousAbschlagDeductions: [],
    invoiceNumberPreview: 'ENTWURF',
    introText: 'Sehr geehrte Damen und Herren, hiermit stellen wir Ihnen folgende Leistungen in Rechnung:',
    closingText: 'Mit freundlichen Grüßen\nIhr Muster Handwerk Team',
    ...overrides,
  };
}

export function createNormalPrintSetup(): { draft: InvoiceDraft; setup: CompanySetup } {
  return {
    draft: createDraftBase(),
    setup: { ...testSetup, taxStatus: 'standard_19' },
  };
}

export function createKleinunternehmerPrintSetup(): {
  draft: InvoiceDraft;
  setup: CompanySetup;
} {
  const draft = createDraftBase({
    taxStatus: 'kleinunternehmer_19',
    legalNotices: buildLegalNotices('kleinunternehmer_19'),
  });
  return { draft, setup: { ...testSetup, taxStatus: 'kleinunternehmer_19' } };
}

export function createReverseChargePrintSetup(): { draft: InvoiceDraft; setup: CompanySetup } {
  const draft = createDraftBase({
    taxStatus: 'reverse_charge_13b',
    legalNotices: buildLegalNotices('reverse_charge_13b'),
  });
  return { draft, setup: { ...testSetup, taxStatus: 'reverse_charge_13b' } };
}

export function createSchlussPrintSetup(): { draft: InvoiceDraft; setup: CompanySetup } {
  const draft = createDraftBase({
    type: 'schluss',
    abschlagNumber: undefined,
    positions: [
      {
        id: 'draft-pos-op-test-1',
        orderPositionId: 'op-test-1',
        description: 'Fliesenarbeiten Bad',
        plannedQuantity: 10,
        billedQuantity: 4,
        openQuantity: 6,
        quantity: 10,
        unit: 'Stunden',
        unitPrice: 65,
        category: 'arbeit',
        billable: true,
      },
    ],
    previousAbschlagDeductions: [
      {
        invoiceId: 'inv-1',
        invoiceNumber: '2026-0001',
        abschlagNumber: 1,
        date: '2026-04-01',
        subtotal: 260,
        amount: 309.4,
      },
      {
        invoiceId: 'inv-2',
        invoiceNumber: '2026-0002',
        abschlagNumber: 2,
        date: '2026-05-01',
        subtotal: 130,
        amount: 154.7,
      },
      {
        invoiceId: 'inv-3',
        invoiceNumber: '2026-0003',
        abschlagNumber: 3,
        date: '2026-05-15',
        subtotal: 65,
        amount: 77.35,
      },
    ],
  });

  return { draft, setup: { ...testSetup, taxStatus: 'standard_19' } };
}

export function createEmptyPositionsPrintSetup(): { draft: InvoiceDraft; setup: CompanySetup } {
  const draft = createDraftBase({
    positions: [
      {
        id: 'draft-pos-op-test-1',
        orderPositionId: 'op-test-1',
        description: 'Fliesenarbeiten Bad',
        plannedQuantity: 10,
        billedQuantity: 0,
        openQuantity: 10,
        quantity: 0,
        unit: 'Stunden',
        unitPrice: 65,
        category: 'arbeit',
        billable: true,
      },
    ],
  });
  return { draft, setup: testSetup };
}

export function buildPrintModelFromDraft(draft: InvoiceDraft, setup: CompanySetup) {
  return buildInvoicePrintModel(draft, setup);
}
