import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateCommunicationHistory } from './services/communicationHistoryService';
import {
  documentDunningDelivery,
  resetDunningDocumentations,
} from './services/dunningDocumentationService';
import { processOfficePilotQuestion } from './services/brain/brainOrchestrator';
import {
  analyzeGlobalFinance,
  analyzeInboxFinance,
  analyzeInvoiceFinance,
  analyzeVorgangFinance,
  countDatevRelevantInboxItems,
  getDocumentedDunningLevel,
  isDatevRelevantKind,
} from './services/brain/financeIntelligenceService';
import {
  isFinanceQuestion,
  tryResolveFinanceQuestion,
} from './services/brain/financeKnowledgeResolver';
import {
  recordInvoiceContext,
  recordVorgangContext,
  resetCompanySessionForTests,
} from './services/brain/companySessionService';
import { FINANCE_INTELLIGENCE_I18N_KEYS } from './types/financeIntelligence';
import { de, t, tr } from './i18n';
import {
  createMaterialInboxItem,
  createOrderPosition,
  createTestVorgang,
} from './test/fixtures';
import type { VorgangInvoice } from './types/models';

const testProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

function createFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-fin-1',
    number: 'RE-2026-100',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      {
        id: 'line-fin-1',
        orderPositionId: 'op-fin-1',
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
    status: 'versendet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    customerSnapshot: { name: 'Müller GmbH', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments: [],
    ...overrides,
  };
}

describe('AI-FINANCE-01 intelligence service', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompanySessionForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    hydrateVorgangStore([]);
    hydrateCommunicationHistory([]);
    resetDunningDocumentations();
  });

  it('meldet vor Fälligkeit kein Zahlungsrisiko', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-not-due',
        title: 'Bad Müller',
        invoices: [createFinalizedInvoice({ id: 'inv-not-due', paymentDueDate: '2099-12-31' })],
      }),
    ]);

    const analysis = analyzeInvoiceFinance('v-fin-not-due', 'inv-not-due', '2026-07-01');
    expect(analysis?.risks.some((r) => r.id === 'payment_open')).toBe(false);
    expect(analysis?.steps.find((s) => s.id === 'zahlung')?.status).toBe('not_due');
  });

  it('erwartet bei Entwurf keinen Zahlungseingang', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-draft',
        title: 'Entwurf Test',
        invoices: [createFinalizedInvoice({ id: 'inv-draft', status: 'entwurf' })],
      }),
    ]);

    const analysis = analyzeInvoiceFinance('v-fin-draft', 'inv-draft');
    expect(analysis?.risks.some((r) => r.id === 'payment_open')).toBe(false);
    expect(analysis?.steps.find((s) => s.id === 'zahlung')?.status).toBe('not_applicable');
  });

  it('erkennt bezahlte Rechnung ohne Mahnung', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-paid',
        title: 'Heizung Schmidt',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-paid',
            paymentDueDate: '2020-01-01',
            payments: [{ id: 'pay-1', date: '2026-06-10', amount: 386.75, createdAt: '2026-06-10' }],
          }),
        ],
      }),
    ]);

    const analysis = analyzeInvoiceFinance('v-fin-paid', 'inv-paid', '2026-07-01');
    expect(analysis?.steps.find((s) => s.id === 'zahlung')?.status).toBe('completed');
    expect(analysis?.recommendations.some((r) => r.id === 'mahnung' || r.id === 'payment_reminder')).toBe(
      false,
    );
  });

  it('nennt bei Teilzahlung nur den Restbetrag', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-partial',
        title: 'Dach Klein',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-partial',
            paymentDueDate: '2099-12-31',
            payments: [{ id: 'pay-p', date: '2026-06-10', amount: 100, createdAt: '2026-06-10' }],
          }),
        ],
      }),
    ]);

    const analysis = analyzeInvoiceFinance('v-fin-partial', 'inv-partial', '2026-07-01');
    const partial = analysis?.risks.find((r) => r.id === 'partial_payment');
    expect(partial).toBeTruthy();
    expect(partial?.params?.amount).toMatch(/286,75/);
    const paymentRec = analysis?.recommendations.find((r) => r.id === 'record_payment');
    expect(paymentRec?.route).toBe('/vorgaenge/v-fin-partial/rechnungen/inv-partial');
  });

  it('verlinkt fällige Rechnung auf die Rechnungsdetailseite', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-due',
        title: 'Fällig Test',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-due',
            number: 'RE-DUE-1',
            paymentDueDate: '2026-07-01',
          }),
        ],
      }),
    ]);

    const analysis = analyzeInvoiceFinance('v-fin-due', 'inv-due', '2026-07-01');
    const due = analysis?.recommendations.find((r) => r.id === 'due_today');
    expect(due).toBeTruthy();
    expect(due?.route).toBe('/vorgaenge/v-fin-due/rechnungen/inv-due');
  });

  it('verlinkt überfällige Rechnung auf die Rechnungsdetailseite', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-overdue-link',
        title: 'Überfällig Link',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-overdue-link',
            number: 'RE-OD-1',
            paymentDueDate: '2026-06-01',
          }),
        ],
      }),
    ]);

    const analysis = analyzeInvoiceFinance(
      'v-fin-overdue-link',
      'inv-overdue-link',
      '2026-07-01',
    );
    expect(analysis?.risks.some((r) => r.id === 'invoice_overdue')).toBe(true);
    const paymentRec = analysis?.recommendations.find((r) => r.id === 'record_payment');
    expect(paymentRec?.route).toBe(
      '/vorgaenge/v-fin-overdue-link/rechnungen/inv-overdue-link',
    );
  });

  it('empfiehlt Zahlungserinnerung erst nach Fälligkeit und ohne dokumentierte Erinnerung', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-remind',
        title: 'Küche Braun',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-remind',
            number: 'RE-2026-300',
            paymentDueDate: '2026-06-28',
          }),
        ],
      }),
    ]);

    const analysis = analyzeInvoiceFinance('v-fin-remind', 'inv-remind', '2026-07-01');
    const reminder = analysis?.recommendations.find((r) => r.id === 'payment_reminder');
    expect(reminder).toBeTruthy();
    expect(reminder?.route).toBe('/vorgaenge/v-fin-remind/rechnungen/inv-remind');
    expect(analysis?.recommendations.some((r) => r.id === 'mahnung')).toBe(false);
  });

  it('empfiehlt Mahnung erst nach dokumentierter Zahlungserinnerung', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-mahn',
        title: 'Fassade Weber',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-mahn',
            number: 'RE-2026-500',
            paymentDueDate: '2020-01-01',
          }),
        ],
      }),
    ]);
    documentDunningDelivery('v-fin-mahn', 'inv-mahn', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-01',
      deliveryMethod: 'email',
    });

    expect(getDocumentedDunningLevel('v-fin-mahn', 'RE-2026-500')).toBe(1);
    const analysis = analyzeInvoiceFinance('v-fin-mahn', 'inv-mahn', '2026-07-01');
    const mahnung = analysis?.recommendations.find((r) => r.id === 'mahnung');
    expect(mahnung).toBeTruthy();
    expect(mahnung?.route).toBe('/vorgaenge/v-fin-mahn/rechnungen/inv-mahn');
    expect(analysis?.recommendations.some((r) => r.id === 'payment_reminder')).toBe(false);
  });

  it('verhindert doppelte Erinnerung bei vorhandener Zahlungserinnerung', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-remind-block',
        title: 'Block Test',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-remind-block',
            number: 'RE-BLOCK-1',
            paymentDueDate: '2026-06-20',
          }),
        ],
      }),
    ]);
    documentDunningDelivery('v-remind-block', 'inv-remind-block', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-25',
      deliveryMethod: 'email',
    });

    const analysis = analyzeInvoiceFinance('v-remind-block', 'inv-remind-block', '2026-07-01');
    expect(analysis?.recommendations.some((r) => r.id === 'payment_reminder')).toBe(false);
  });

  it('empfiehlt keine Mahnung bei stornierter Rechnung', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-storno',
        title: 'Storno Test',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-storno',
            paymentDueDate: '2020-01-01',
            paymentStatus: 'storniert',
            cancelledAt: '2026-05-01',
          }),
        ],
      }),
    ]);

    const analysis = analyzeInvoiceFinance('v-storno', 'inv-storno', '2026-07-01');
    expect(analysis?.recommendations.some((r) => r.id === 'mahnung' || r.id === 'payment_reminder')).toBe(false);
  });

  it('zeigt bei Ausgangsrechnung Kunden-Skonto statt Nutzen-Hinweis', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-out-skonto',
        title: 'Sanierung Grün',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-out-skonto',
            number: 'RE-2026-400',
            issueDate: '2026-07-01',
            skontoText: 'Bei Zahlung innerhalb von 14 Tagen gewähren wir 2 % Skonto.',
            paymentDueDate: '2026-08-01',
          }),
        ],
      }),
    ]);

    const analysis = analyzeInvoiceFinance('v-fin-out-skonto', 'inv-out-skonto', '2026-07-05');
    expect(analysis?.recommendations.some((r) => r.id === 'outgoing_skonto_customer')).toBe(true);
    expect(analysis?.recommendations.some((r) => r.id === 'use_skonto')).toBe(false);
  });

  it('zeigt bei Eingangsrechnung nutzbares Skonto mit Zahlbetrag', () => {
    const incoming = createMaterialInboxItem();
    incoming.id = 'inbox-in-skonto';
    incoming.classifiedKind = 'eingangsrechnung';
    incoming.recognizedData = {
      Skonto: '2 % Skonto bei Zahlung innerhalb von 14 Tagen',
      Rechnungsdatum: '2026-07-01',
      Betrag: '1.000,00 €',
    };
    hydrateInboxStore([incoming]);

    const analysis = analyzeInboxFinance(incoming.id, '2026-07-05');
    const skontoRec = analysis?.recommendations.find((r) => r.id === 'incoming_skonto_usable');
    expect(skontoRec).toBeTruthy();
    expect(skontoRec?.messageKey).toBe('financeIntelligence.skonto.incomingUsable');
    expect(skontoRec?.params?.amount).toMatch(/980,00/);
  });

  it('markiert unklaren Skonto-Fall als review_required', () => {
    const unclear = createMaterialInboxItem();
    unclear.id = 'inbox-skonto-unclear';
    unclear.title = 'Rechnung mit Skonto-Hinweis';
    unclear.recognizedData = { Skonto: 'Skonto nach Vereinbarung' };
    hydrateInboxStore([unclear]);

    const analysis = analyzeInboxFinance(unclear.id);
    expect(analysis?.recommendations.some((r) => r.id === 'skonto_review_required')).toBe(true);
  });

  it('prüft Überzahlung ohne Fehlerrisiko', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-overpaid',
        title: 'Überzahlung',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-overpaid',
            payments: [{ id: 'pay-over', date: '2026-06-10', amount: 500, createdAt: '2026-06-10' }],
          }),
        ],
      }),
    ]);

    const analysis = analyzeInvoiceFinance('v-overpaid', 'inv-overpaid');
    expect(analysis?.risks.some((r) => r.id === 'overpaid')).toBe(false);
    expect(analysis?.recommendations.some((r) => r.id === 'review_overpaid')).toBe(true);
  });

  it('erkennt Materialrechnung ohne Auftrag', () => {
    const material = createMaterialInboxItem();
    material.id = 'inbox-fin-mat';
    material.classifiedKind = 'eingangsrechnung';
    hydrateInboxStore([material]);

    const analysis = analyzeInboxFinance(material.id);
    expect(analysis?.risks.some((r) => r.id === 'material_without_vorgang')).toBe(true);
  });

  it('markiert DATEV-relevant ohne Export-Behauptung', () => {
    const tank = createMaterialInboxItem();
    tank.id = 'inbox-tank';
    tank.classifiedKind = 'tankbeleg';
    hydrateInboxStore([tank]);

    expect(isDatevRelevantKind('tankbeleg')).toBe(true);
    expect(countDatevRelevantInboxItems()).toBe(1);

    const analysis = analyzeGlobalFinance('2026-07-01');
    const datevRec = analysis.recommendations.find((r) => r.id === 'collect_datev_docs');
    if (datevRec) {
      expect(datevRec.messageKey).toBe('financeIntelligence.datev.markForAccounting');
    }
  });

  it('begrenzt Risiken und Empfehlungen zusammen auf maximal 5', () => {
    const overdueInvoices = Array.from({ length: 8 }, (_, index) =>
      createFinalizedInvoice({
        id: `inv-cap-${index}`,
        number: `RE-CAP-${index}`,
        paymentDueDate: '2020-01-01',
      }),
    );
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-cap',
        title: 'Cap Test',
        orderPositions: [createOrderPosition({ id: 'op-cap' })],
        invoices: overdueInvoices,
      }),
    ]);

    const analysis = analyzeVorgangFinance('v-fin-cap', '2026-07-01');
    expect((analysis?.risks.length ?? 0) + (analysis?.recommendations.length ?? 0)).toBeLessThanOrEqual(5);
  });
});

describe('AI-FINANCE-01 i18n DE/TR', () => {
  it('hat vollständige financeIntelligence-Keys in DE und TR ohne Fallback', () => {
    for (const key of FINANCE_INTELLIGENCE_I18N_KEYS) {
      const deValue = de[key as keyof typeof de];
      const trValue = tr[key as keyof typeof tr];
      const translated = t(key as keyof typeof de, 'tr');

      expect(deValue, `${key} fehlt in DE`).toBeTruthy();
      expect(trValue, `${key} fehlt in TR`).toBeTruthy();
      expect(trValue?.trim(), `${key} ist leer in TR`).not.toBe('');
      expect(trValue, `${key} nutzt deutschen Fallback`).not.toBe(deValue);
      expect(translated).toBe(trValue);
      expect(translated).not.toMatch(/^financeIntelligence\./);
    }
  });
});

describe('AI-FINANCE-01 resolver and orchestrator', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompanySessionForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-fin-orch',
        title: 'Bad Müller',
        invoices: [
          createFinalizedInvoice({
            id: 'inv-orch',
            paymentDueDate: '2020-01-01',
          }),
        ],
      }),
    ]);
  });

  it('erkennt Finanz-Fragen', () => {
    expect(isFinanceQuestion('Welche Rechnungen sind überfällig?')).toBe(true);
    expect(isFinanceQuestion('Was ist VOB?')).toBe(false);
  });

  it('erklärt Reverse Charge mit Unsicherheitshinweis', () => {
    recordInvoiceContext('v-fin-orch', 'inv-orch');
    const result = tryResolveFinanceQuestion('Was bedeutet Reverse Charge §13b?');
    expect(result?.assistantAnswer?.bullets).toContain('financeIntelligence.tax.reverseChargeExplain');
    expect(result?.uncertaintyNote).toBe('financeIntelligence.tax.noAdvice');
  });

  it('erklärt Kleinunternehmerregelung ohne Steuerentscheidung', () => {
    const result = tryResolveFinanceQuestion('Was bedeutet Kleinunternehmerregelung?');
    expect(result?.assistantAnswer?.bullets).toContain('financeIntelligence.tax.kleinunternehmerExplain');
    expect(result?.uncertaintyNote).toBe('financeIntelligence.tax.noAdvice');
  });

  it('liefert Finanzstand mit Schritten und Empfehlung', () => {
    recordVorgangContext('v-fin-orch');
    const result = tryResolveFinanceQuestion('Welche Rechnungen sind überfällig?');
    expect(result?.assistantAnswer?.summary).toMatch(/überfällig|Daten/);
    expect(result?.financeSummary?.scopeTitle).toBe('Bad Müller');
  });

  it('integriert Finanz-Antworten im Orchestrator', async () => {
    recordInvoiceContext('v-fin-orch', 'inv-orch');
    const result = await processOfficePilotQuestion('Ist diese Rechnung bezahlt?', { mode: 'rules' });
    expect(result.source).toBe('rules');
    expect(result.financeUsed).toContain('finance_intelligence');
    expect(result.assistantAnswer?.bullets.length).toBeGreaterThan(0);
  });
});
