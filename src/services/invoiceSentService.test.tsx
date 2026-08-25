import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { InvoiceSentPanel } from '../components/invoice/InvoiceSentPanel';
import { createTestVorgang } from '../test/fixtures';
import {
  calculatePaymentSummary,
  isInvoiceOverdue,
  isSentDateAfterPaymentDue,
} from './invoicePaymentService';
import { generateApprovedInvoicePdf } from './invoicePdfService';
import {
  markInvoiceAsSent,
  updateInvoiceSentDetails,
} from './invoiceSentService';
import { isExpectingPayment } from './brain/financeIntelligenceService';
import { hydrateVorgangStore, getVorgangInvoice } from './vorgangService';
import type { VorgangInvoice } from '../types/models';
import * as persistenceService from './persistenceService';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster GmbH',
  street: 'Hauptstraße 1',
  zip: '80331',
  city: 'München',
  iban: 'DE00 0000 0000 0000 0000 00',
};

function createPreparedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-sent-1',
    number: '2026-0500',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Leistung',
        quantity: 2,
        unit: 'Stunden',
        unitPrice: 50,
        lineTotal: 100,
      },
    ],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-31',
    paymentDueDate: '2026-06-10',
    paymentTermsText: '14 Tage',
    skontoText: '',
    customerSnapshot: {
      name: 'Kunde Test',
      contactPerson: '',
      street: 'Weg 1',
      zip: '80333',
      city: 'München',
      email: '',
      phone: '',
    },
    companySnapshot,
    legalNotices: [],
    previousAbschlagDeductions: [],
    introText: '',
    closingText: '',
    baustelle: 'Weg 1',
    vorgangTitle: 'Test',
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

beforeEach(() => {  hydrateVorgangStore([createTestVorgang({ invoices: [createPreparedInvoice()] })]);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('INVOICE-PILOT-MARK-SENT-01 — service', () => {
  it('vorbereitet → versendet mit Datum und Versandweg', () => {
    const result = markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-05',
      sentVia: 'email',
      sentNote: 'per Outlook',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.status).toBe('versendet');
    expect(result.invoice.sentAt).toBe('2026-06-05');
    expect(result.invoice.sentVia).toBe('email');
    expect(result.invoice.sentNote).toBe('per Outlook');
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('versendet');
  });

  it('Entwurf und fehlende Angaben werden abgelehnt; kein erneutes Markieren', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [createPreparedInvoice({ status: 'entwurf', number: 'ENTWURF' })],
      }),
    ]);
    expect(
      markInvoiceAsSent('v-test-1', 'inv-sent-1', {
        sentAt: '2026-06-05',
        sentVia: 'post',
      }).ok,
    ).toBe(false);

    hydrateVorgangStore([createTestVorgang({ invoices: [createPreparedInvoice()] })]);
    expect(
      markInvoiceAsSent('v-test-1', 'inv-sent-1', {
        sentAt: '',
        sentVia: 'email',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_date' });
    expect(
      markInvoiceAsSent('v-test-1', 'inv-sent-1', {
        sentAt: '2026-06-05',
        sentVia: 'fax' as never,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_via' });

    const first = markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-05',
      sentVia: 'portal',
    });
    expect(first.ok).toBe(true);
    expect(
      markInvoiceAsSent('v-test-1', 'inv-sent-1', {
        sentAt: '2026-06-06',
        sentVia: 'email',
      }),
    ).toMatchObject({ ok: false, reason: 'already_sent' });
  });

  it('Versandangaben können korrigiert werden ohne zweiten Versandstatuswechsel', () => {
    markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-05',
      sentVia: 'email',
    });
    const corrected = updateInvoiceSentDetails('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-04',
      sentVia: 'post',
      sentNote: 'Einschreiben',
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.invoice.status).toBe('versendet');
    expect(corrected.invoice.sentAt).toBe('2026-06-04');
    expect(corrected.invoice.sentVia).toBe('post');
    expect(corrected.invoice.sentNote).toBe('Einschreiben');
  });

  it('PDF-Download verändert den Versandstatus nicht', async () => {
    const invoice = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    const before = invoice.status;
    const pdf = await generateApprovedInvoicePdf(invoice);
    expect(pdf.ok).toBe(true);
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe(before);
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.sentAt).toBeUndefined();
  });

  it('vorbereitete Rechnung ist nicht überfällig/mahnfähig; versendete nutzt Fälligkeitslogik', () => {
    const prepared = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    expect(isExpectingPayment(prepared)).toBe(false);
    expect(isInvoiceOverdue(prepared, '2026-06-20')).toBe(false);
    expect(calculatePaymentSummary(prepared, '2026-06-20').status).toBe('offen');

    markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-01',
      sentVia: 'email',
    });
    const sent = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    expect(isExpectingPayment(sent)).toBe(true);
    expect(isInvoiceOverdue(sent, '2026-06-20')).toBe(true);
    expect(calculatePaymentSummary(sent, '2026-06-20').status).toBe('ueberfaellig');
  });

  it('alte Rechnungen ohne Versandfelder bleiben kompatibel', () => {
    const legacy = createPreparedInvoice({
      status: 'versendet',
      // no sentAt / sentVia
    });
    delete legacy.sentAt;
    delete legacy.sentVia;
    delete legacy.sentNote;
    hydrateVorgangStore([createTestVorgang({ invoices: [legacy] })]);

    expect(isExpectingPayment(legacy)).toBe(true);
    expect(isInvoiceOverdue(legacy, '2026-06-20')).toBe(true);
    const corrected = updateInvoiceSentDetails('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-02',
      sentVia: 'persoenlich',
    });
    expect(corrected.ok).toBe(true);
  });

  it('verspätetes Versanddatum erzeugt Hinweis ohne Neuberechnung der Fälligkeit', () => {
    const invoice = createPreparedInvoice({
      paymentDueDate: '2026-06-01',
    });
    hydrateVorgangStore([createTestVorgang({ invoices: [invoice] })]);

    const result = markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-20',
      sentVia: 'post',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.paymentDueDate).toBe('2026-06-01');
    expect(result.invoice.sentAt).toBe('2026-06-20');
    expect(isSentDateAfterPaymentDue(result.invoice.sentAt, result.invoice.paymentDueDate)).toBe(
      true,
    );
  });
});

describe('INVOICE-PILOT-MARK-SENT-01 — UI', () => {
  it('kein Statuswechsel ohne Bestätigung; Anzeige und Korrektur funktionieren', async () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let current = getVorgangInvoice('v-test-1', 'inv-sent-1')!;

    const renderPanel = async () => {
      await act(async () => {
        root.render(
          createElement(
            MemoryRouter,
            null,
            createElement(
              AppProvider,
              { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
              createElement(InvoiceSentPanel, {
                vorgangId: 'v-test-1',
                invoice: current,
                translate: (key: string) => key,
                onUpdated: (next) => {
                  current = next;
                },
              }),
            ),
          ),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
    };

    await renderPanel();
    expect(container.querySelector('[data-testid="invoice-sent-mark"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="invoice-sent-confirm"]')).toBeNull();

    await act(async () => {
      (container.querySelector('[data-testid="invoice-sent-mark"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="invoice-sent-form"]')).not.toBeNull();
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('vorbereitet');

    await act(async () => {
      (
        container.querySelector('[data-testid="invoice-sent-continue"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="invoice-sent-confirm"]')).not.toBeNull();
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('vorbereitet');

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="invoice-sent-confirm-submit"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('versendet');
    expect(current.status).toBe('versendet');
    expect(current.sentVia).toBe('email');
    expect(current.sentAt).toBeTruthy();

    current = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    await renderPanel();
    expect(container.querySelector('[data-testid="invoice-sent-at"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="invoice-sent-correct"]')).not.toBeNull();

    await act(async () => {
      (
        container.querySelector('[data-testid="invoice-sent-correct"]') as HTMLButtonElement
      ).click();
    });
    const via = container.querySelector(
      '[data-testid="invoice-sent-via-input"]',
    ) as HTMLSelectElement;
    await act(async () => {
      via.value = 'post';
      via.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      (
        container.querySelector('[data-testid="invoice-sent-continue"]') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="invoice-sent-confirm-submit"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.sentVia).toBe('post');
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('versendet');
    expect(persistSpy).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});

/**
 * OFFICEPILOT-INVOICE-SENT-PERSIST-01C — Erfolg heißt dauerhaft geschrieben.
 *
 * Auf dem Realgerät bestätigte der Nutzer den Versand, und die Rechnung stand
 * danach weiterhin auf „vorbereitet“ — in der Detailansicht wie im
 * Rechnungsreiter. Ursache war kein Rechenfehler, sondern ein Vertragsbruch:
 * Die Mutation meldete Erfolg, ohne zu prüfen, ob der Schreibvorgang die
 * Persistenz erreicht hat. Was nur im Arbeitsspeicher stand, war nach dem
 * nächsten Rehydrieren wieder weg.
 *
 * Ab hier gilt: Erfolg wird nur gemeldet, wenn beides gelang.
 */
describe('OFFICEPILOT-INVOICE-SENT-PERSIST-01C', () => {
  it('A: Erfolg ist im Store nachweisbar, nicht nur im Rückgabewert', () => {
    const result = markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-05',
      sentVia: 'email',
    });
    expect(result.ok).toBe(true);

    // Der Store ist die Wahrheit — nicht das zurückgegebene Objekt.
    const stored = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    expect(stored.status).toBe('versendet');
    expect(stored.sentAt).toBe('2026-06-05');
    expect(stored.sentVia).toBe('email');
  });

  it('B: bei Persistenzfehler kein Scheinerfolg und keine Teilmutation', () => {
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: false });

    const result = markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-05',
      sentVia: 'email',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('persist_failed');

    // Nichts darf zurückbleiben: der Versand hat nicht stattgefunden.
    const stored = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    expect(stored.status).toBe('vorbereitet');
    expect(stored.sentAt).toBeUndefined();
    expect(stored.sentVia).toBeUndefined();
  });

  it('C: nach erfolgreichem Versand übersteht der Status das Rehydrieren', () => {
    expect(
      markInvoiceAsSent('v-test-1', 'inv-sent-1', { sentAt: '2026-06-05', sentVia: 'email' }).ok,
    ).toBe(true);

    // Genau das, was mobiles Safari beim Wiederaufnehmen tut.
    const snapshot = persistenceService.buildPersistedStateSnapshot();
    hydrateVorgangStore(snapshot.vorgaenge);

    const stored = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    expect(stored.status).toBe('versendet');
    expect(stored.sentAt).toBe('2026-06-05');
    expect(stored.sentVia).toBe('email');
  });

  it('D: lokale Rechnungsfelder überleben die Versandmutation unverändert', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [
          createPreparedInvoice({
            archiveDocumentId: 'doc-archive-1',
            paymentStatus: 'teilbezahlt',
            payments: [
              { id: 'pay-1', date: '2026-06-02', amount: 50, method: 'ueberweisung' },
            ],
          }),
        ],
      }),
    ]);

    expect(
      markInvoiceAsSent('v-test-1', 'inv-sent-1', { sentAt: '2026-06-05', sentVia: 'email' }).ok,
    ).toBe(true);

    const stored = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    expect(stored.status).toBe('versendet');
    expect(stored.archiveDocumentId).toBe('doc-archive-1');
    expect(stored.paymentStatus).toBe('teilbezahlt');
    expect(stored.payments).toHaveLength(1);
    expect(stored.payments?.[0]?.amount).toBe(50);
    expect(stored.customerSnapshot?.name).toBe('Kunde Test');
    expect(stored.number).toBe('2026-0500');
    expect(stored.subtotal).toBe(100);
  });

  it('E: eine versendete Rechnung fällt nicht auf vorbereitet zurück', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [
          createPreparedInvoice({ status: 'versendet', sentAt: '2026-06-04', sentVia: 'post' }),
        ],
      }),
    ]);

    const result = markInvoiceAsSent('v-test-1', 'inv-sent-1', {
      sentAt: '2026-06-05',
      sentVia: 'email',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already_sent');

    const stored = getVorgangInvoice('v-test-1', 'inv-sent-1')!;
    expect(stored.status).toBe('versendet');
    expect(stored.sentVia).toBe('post');
  });

  it('F: bei Persistenzfehler meldet die Oberfläche den Fehler und nichts wird übernommen', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const updates: VorgangInvoice[] = [];
    const invoice = getVorgangInvoice('v-test-1', 'inv-sent-1')!;

    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(
            AppProvider,
            { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
            createElement(InvoiceSentPanel, {
              vorgangId: 'v-test-1',
              invoice,
              translate: (key: string) => key,
              onUpdated: (next) => {
                updates.push(next);
              },
            }),
          ),
        ),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      (container.querySelector('[data-testid="invoice-sent-mark"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (
        container.querySelector('[data-testid="invoice-sent-continue"]') as HTMLButtonElement
      ).click();
    });

    // Confirm-first: bis hierher ist nichts geschehen.
    expect(container.querySelector('[data-testid="invoice-sent-confirm"]')).not.toBeNull();
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('vorbereitet');

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: false });

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="invoice-sent-confirm-submit"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Kein Scheinerfolg nach oben, keine Statusänderung, aber eine Erklärung.
    expect(updates).toHaveLength(0);
    expect(getVorgangInvoice('v-test-1', 'inv-sent-1')?.status).toBe('vorbereitet');
    expect(container.querySelector('[data-testid="invoice-sent-error"]')).not.toBeNull();
    // Der Nutzer bleibt stehen und kann es erneut versuchen.
    expect(container.querySelector('[data-testid="invoice-sent-confirm"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
