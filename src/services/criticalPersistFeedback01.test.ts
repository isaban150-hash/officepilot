import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { createTestVorgang } from '../test/fixtures';
import {
  documentDunningDelivery,
  resetDunningDocumentations,
} from './dunningDocumentationService';
import {
  resetLastPersistFailureForTests,
  getLastPersistSuccess,
  persistAll,
} from './persistenceService';
import { getPersistenceHealthSnapshot } from './persistenceHealthService';
import { hydrateVorgangStore } from './vorgangService';
import type { VorgangInvoice } from '../types/models';

function createSentInvoice(): VorgangInvoice {
  return {
    id: 'inv-crit-1',
    number: 'RE-100',
    type: 'schluss',
    positions: [],
    subtotal: 250,
    taxStatus: 'standard_19',
    amount: 297.5,
    status: 'versendet',
    sentAt: '2026-01-02',
    sentVia: 'email',
    date: '2026-01-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    issueDate: '2026-01-01',
    paymentDueDate: '2026-01-20',
    customerSnapshot: {
      name: 'Kunde',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Muster GmbH',
    },
    legalNotices: [],
    previousAbschlagDeductions: [],
    paymentStatus: 'offen',
    payments: [],
  };
}

function failLocalStorageSetItem(): void {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  });
}

describe('critical flows persist failure', () => {
  beforeEach(() => {    resetDunningDocumentations();
    resetLastPersistFailureForTests();
    hydrateVorgangStore([createTestVorgang({ invoices: [createSentInvoice()] })]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('dunning documentation leaves failure health when persistAll fails', () => {
    expect(getLastPersistSuccess()).toBe(true);

    failLocalStorageSetItem();

    const result = documentDunningDelivery('v-test-1', 'inv-crit-1', {
      kind: 'payment_reminder',
      documentedAt: '2026-01-10',
      deliveryMethod: 'email',
    });
    expect(result.ok).toBe(true);
    expect(getLastPersistSuccess()).toBe(false);
    expect(getPersistenceHealthSnapshot().hasFailure).toBe(true);
    if (result.ok) {
      expect(result.documentation.kind).toBe('payment_reminder');
    }
  });

  it('successful persistAll after failure clears health for subsequent success feedback', () => {
    failLocalStorageSetItem();
    expect(persistAll().success).toBe(false);
    expect(getLastPersistSuccess()).toBe(false);

    vi.unstubAllGlobals();
    expect(persistAll().success).toBe(true);
    expect(getLastPersistSuccess()).toBe(true);
    expect(getPersistenceHealthSnapshot().hasFailure).toBe(false);
  });
});
