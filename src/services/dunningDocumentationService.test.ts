import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { createTestVorgang } from '../test/fixtures';
import {
  analyzeInvoiceFinance,
  getDocumentedDunningLevel,
} from './brain/financeIntelligenceService';
import { hydrateCommunicationHistory } from './communicationHistoryService';
import {
  documentDunningDelivery,
  getDunningDocumentationsForInvoice,
  resetDunningDocumentations,
} from './dunningDocumentationService';
import { recordPayment } from './invoicePaymentService';
import { hydrateVorgangStore, getVorgangInvoice } from './vorgangService';
import type { VorgangInvoice } from '../types/models';
import * as persistenceService from './persistenceService';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster GmbH',
};

function createSentInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-dunning-1',
    number: 'RE-DUN-1',
    type: 'schluss',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    sentAt: '2026-01-01',
    sentVia: 'email',
    date: '2026-01-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    issueDate: '2026-01-01',
    paymentDueDate: '2026-01-01',
    customerSnapshot: {
      name: 'Kunde',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot,
    legalNotices: [],
    previousAbschlagDeductions: [],
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

beforeEach(() => {  resetDunningDocumentations();
  hydrateVorgangStore([createTestVorgang({ invoices: [createSentInvoice()] })]);
  hydrateCommunicationHistory([]);
});

describe('INVOICE-PILOT-DUNNING-DOCUMENTED-01', () => {
  it('Draft-Erstellung und Kopieren erhöhen Mahnstufe nicht', () => {
    hydrateCommunicationHistory([
      {
        id: 'comm-1',
        timestamp: '2026-06-01T10:00:00.000Z',
        type: 'draft_created',
        intent: 'payment_reminder',
        contextRef: { type: 'invoice', id: 'inv-dunning-1', vorgangId: 'v-test-1' },
        status: 'complete',
        disclaimerShown: true,
      },
      {
        id: 'comm-2',
        timestamp: '2026-06-01T11:00:00.000Z',
        type: 'draft_copied',
        intent: 'payment_reminder',
        contextRef: { type: 'invoice', id: 'inv-dunning-1', vorgangId: 'v-test-1' },
        status: 'complete',
        disclaimerShown: true,
      },
    ]);

    expect(getDocumentedDunningLevel('v-test-1', 'RE-DUN-1')).toBe(0);
  });

  it('dokumentierte Zahlungserinnerung ergibt Level 1; Mahnung Level 2', () => {
    const reminder = documentDunningDelivery('v-test-1', 'inv-dunning-1', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-10',
      deliveryMethod: 'email',
    });
    expect(reminder.ok).toBe(true);
    expect(getDocumentedDunningLevel('v-test-1', 'RE-DUN-1')).toBe(1);

    const notice = documentDunningDelivery('v-test-1', 'inv-dunning-1', {
      kind: 'dunning_notice',
      documentedAt: '2026-06-20',
      deliveryMethod: 'post',
      note: 'per Einschreiben',
    });
    expect(notice.ok).toBe(true);
    expect(getDocumentedDunningLevel('v-test-1', 'RE-DUN-1')).toBe(2);
  });

  it('niedrigere Aktion reduziert vorhandenes Level nicht', () => {
    documentDunningDelivery('v-test-1', 'inv-dunning-1', {
      kind: 'dunning_notice',
      documentedAt: '2026-06-20',
      deliveryMethod: 'email',
    });
    documentDunningDelivery('v-test-1', 'inv-dunning-1', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-21',
      deliveryMethod: 'email',
    });
    expect(getDocumentedDunningLevel('v-test-1', 'RE-DUN-1')).toBe(2);
  });

  it('fehlende Bestätigung, Datum oder Versandweg wird abgelehnt', () => {
    expect(
      documentDunningDelivery('v-test-1', 'inv-dunning-1', {
        kind: 'payment_reminder',
        documentedAt: '',
        deliveryMethod: 'email',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_date' });

    expect(
      documentDunningDelivery('v-test-1', 'inv-dunning-1', {
        kind: 'payment_reminder',
        documentedAt: '2026-06-10',
        deliveryMethod: 'fax' as never,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_delivery' });
  });

  it('Entwurf, vorbereitete oder bezahlte Rechnung wird abgelehnt', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [createSentInvoice({ status: 'entwurf' })],
      }),
    ]);
    expect(
      documentDunningDelivery('v-test-1', 'inv-dunning-1', {
        kind: 'payment_reminder',
        documentedAt: '2026-06-10',
        deliveryMethod: 'email',
      }),
    ).toMatchObject({ ok: false, reason: 'draft_or_prepared' });

    hydrateVorgangStore([
      createTestVorgang({
        invoices: [createSentInvoice({ status: 'vorbereitet' })],
      }),
    ]);
    expect(
      documentDunningDelivery('v-test-1', 'inv-dunning-1', {
        kind: 'payment_reminder',
        documentedAt: '2026-06-10',
        deliveryMethod: 'email',
      }),
    ).toMatchObject({ ok: false, reason: 'draft_or_prepared' });

    hydrateVorgangStore([
      createTestVorgang({
        invoices: [createSentInvoice()],
      }),
    ]);
    recordPayment(
      'v-test-1',
      'inv-dunning-1',
      { date: '2026-06-10', amount: 1190 },
      {},
    );
    expect(
      documentDunningDelivery('v-test-1', 'inv-dunning-1', {
        kind: 'payment_reminder',
        documentedAt: '2026-06-10',
        deliveryMethod: 'email',
      }),
    ).toMatchObject({ ok: false, reason: 'not_open' });
  });

  it('Finance-Empfehlungen reagieren auf bestätigte Mahnstufe', () => {
    documentDunningDelivery('v-test-1', 'inv-dunning-1', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-01',
      deliveryMethod: 'email',
    });
    const analysis = analyzeInvoiceFinance('v-test-1', 'inv-dunning-1', '2026-07-01');
    expect(analysis?.recommendations.some((r) => r.id === 'mahnung')).toBe(true);
    expect(analysis?.recommendations.some((r) => r.id === 'payment_reminder')).toBe(false);
  });

  it('löst keinen echten Versand aus und persistiert lokal', () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const result = documentDunningDelivery('v-test-1', 'inv-dunning-1', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-10',
      deliveryMethod: 'portal',
    });
    expect(result.ok).toBe(true);
    expect(persistSpy).toHaveBeenCalled();
    expect(getDunningDocumentationsForInvoice('v-test-1', 'inv-dunning-1')).toHaveLength(1);
    expect(getVorgangInvoice('v-test-1', 'inv-dunning-1')?.status).toBe('versendet');
  });

  it('alte Kommunikationshistorie bleibt kompatibel ohne Level-Wirkung', () => {
    hydrateCommunicationHistory([
      {
        id: 'legacy',
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'draft_created',
        intent: 'payment_reminder',
        contextRef: { type: 'invoice', id: 'inv-dunning-1', vorgangId: 'v-test-1' },
        status: 'complete',
        userInputExcerpt: 'Zahlungserinnerung schicken',
        resultExcerpt: 'Mahnung – bitte zahlen',
        disclaimerShown: true,
      },
    ]);
    expect(getDocumentedDunningLevel('v-test-1', 'RE-DUN-1')).toBe(0);
    const analysis = analyzeInvoiceFinance('v-test-1', 'inv-dunning-1', '2026-07-01');
    expect(analysis?.recommendations.some((r) => r.id === 'payment_reminder')).toBe(true);
  });
});
