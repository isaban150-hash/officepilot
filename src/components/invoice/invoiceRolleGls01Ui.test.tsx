/**
 * GO-LIVE-SECURITY-01 — Client-Nacharbeit, Oberfläche: Versandvermerk und
 * Leistungszeitraum.
 *
 * Mitglieder sehen den Stand und einen Rollenhinweis statt der Aktion — auch
 * kein „Jetzt sichern" und kein „Lokalen Stand verwenden". Inhaber behalten
 * alles. Weist der Server eine Aktion wegen der Rolle ab, bleibt lokal kein
 * Erfolg stehen, und die Oberfläche sagt es.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alsInhaber, alsMitglied } from '../../test/workspaceRoleTestUtils';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { getVorgangInvoice, hydrateVorgangStore } from '../../services/vorgangService';
import * as sentService from '../../services/invoiceSentService';
import * as servicePeriodService from '../../services/invoice/invoiceServicePeriodConfirmService';
import type { InvoiceSentCloudState } from '../../services/invoiceSentService';
import type { TranslationKey } from '../../i18n';
import type { VorgangInvoice } from '../../types/models';
import { InvoiceSentPanel } from './InvoiceSentPanel';
import { InvoiceServicePeriodConfirmPanel } from './InvoiceServicePeriodConfirmPanel';

const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-gls01-ui';

function translate(key: TranslationKey): string {
  return key;
}

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0032',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-test-1',
        description: 'Beispielleistung',
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: 520,
      },
    ],
    subtotal: 520,
    taxStatus: 'standard_19',
    amount: 618.8,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-05',
    paymentDueDate: '2099-06-15',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Betrieb GmbH' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

const versendet = () => rechnung({ status: 'versendet', sentAt: '2026-06-02', sentVia: 'email' });

function sentMarkup(invoice: VorgangInvoice, cloudState: InvoiceSentCloudState | null = null, roleAligned = false) {
  return renderToStaticMarkup(
    createElement(InvoiceSentPanel, {
      vorgangId: VORGANG_ID,
      invoice,
      cloudState,
      translate,
      onUpdated: () => {},
      onCloudStateChange: () => {},
      roleAligned,
    }),
  );
}

function periodMarkup(invoice: VorgangInvoice, cloudConfirmed: boolean | null = null, roleAligned = false) {
  return renderToStaticMarkup(
    createElement(InvoiceServicePeriodConfirmPanel, {
      vorgangId: VORGANG_ID,
      invoice,
      cloudConfirmed,
      translate,
      onUpdated: () => {},
      onCloudStateChange: () => {},
      roleAligned,
    }),
  );
}

beforeEach(() => resetTestStores());
afterEach(() => vi.restoreAllMocks());

describe('GLS01 UI — Versandvermerk', () => {
  it('U1: ein Mitglied sieht den Stand und einen Rollenhinweis, aber keine Aktion', () => {
    alsMitglied();
    const vorbereitet = sentMarkup(rechnung());
    expect(vorbereitet).toContain('invoice-sent-role-hint');
    expect(vorbereitet).not.toContain('invoice-sent-mark');

    const gesendet = sentMarkup(versendet());
    expect(gesendet).toContain('invoice-sent-status');
    expect(gesendet).not.toContain('invoice-sent-correct');

    expect(sentMarkup(versendet(), { kind: 'pending' })).not.toContain('invoice-sent-secure-now');
    const konflikt = sentMarkup(versendet(), { kind: 'conflict', cloud: { sentAt: '2026-06-03', sentVia: 'post' } });
    expect(konflikt).not.toContain('invoice-sent-use-local');
    // Den Cloud-Stand übernehmen bleibt: Das ist Serverwahrheit, keine Aktion.
    expect(konflikt).toContain('invoice-sent-use-cloud');
  });

  it('U2: Inhaber behalten Vermerken, Korrigieren und Sichern', () => {
    alsInhaber();
    expect(sentMarkup(rechnung())).toContain('invoice-sent-mark');
    expect(sentMarkup(versendet())).toContain('invoice-sent-correct');
    expect(sentMarkup(versendet(), { kind: 'pending' })).toContain('invoice-sent-secure-now');
    expect(sentMarkup(rechnung())).not.toContain('invoice-sent-role-hint');
  });

  it('U3: der Hinweis nach einem Abgleich auf dem Mitgliedsgerät', () => {
    alsMitglied();
    expect(sentMarkup(rechnung(), null, true)).toContain('invoice.sent.roleAligned');
  });
});

describe('GLS01 UI — Leistungszeitraum', () => {
  it('U4: ein Mitglied sieht den Zeitraum und einen Rollenhinweis, keinen Bestätigungsknopf', () => {
    alsMitglied();
    const markup = periodMarkup(rechnung());
    expect(markup).toContain('invoice-service-period-value');
    expect(markup).toContain('invoice-service-period-role-hint');
    expect(markup).not.toContain('invoice-confirm-service-period');
    expect(periodMarkup(rechnung({ servicePeriodConfirmed: true }), false)).not.toContain(
      'invoice-secure-service-period',
    );
    expect(periodMarkup(rechnung(), null, true)).toContain('invoice.servicePeriodRoleAligned');
  });

  it('U5: Inhaber behalten Bestätigen und Sichern', () => {
    alsInhaber();
    expect(periodMarkup(rechnung())).toContain('invoice-confirm-service-period');
    expect(periodMarkup(rechnung({ servicePeriodConfirmed: true }), false)).toContain('invoice-secure-service-period');
  });
});

describe('GLS01 UI — Rollenabweisung des Servers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    alsInhaber();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const klick = async (testId: string) => {
    await act(async () => {
      container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click();
    });
  };
  const ruhe = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it('U6: Vermerk abgewiesen — lokal wieder „vorbereitet", die Oberfläche sagt warum', async () => {
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [rechnung()] })]);
    vi.spyOn(sentService, 'syncInvoiceSentToCloud').mockResolvedValue('forbidden');
    let zuletzt: VorgangInvoice | null = null;
    const render = (invoice: VorgangInvoice) =>
      root.render(
        createElement(InvoiceSentPanel, {
          vorgangId: VORGANG_ID,
          invoice,
          translate,
          onUpdated: (next: VorgangInvoice) => {
            zuletzt = next;
            render(next);
          },
          onCloudStateChange: () => {},
        }),
      );
    await act(async () => render(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!));

    await klick('invoice-sent-mark');
    await klick('invoice-sent-continue');
    await klick('invoice-sent-confirm-submit');
    await ruhe();

    expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!.status).toBe('vorbereitet');
    expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!.sentAt).toBeUndefined();
    expect(zuletzt!.status).toBe('vorbereitet');
    expect(container.querySelector('[data-testid="invoice-sent-forbidden"]')?.textContent).toBe(
      'invoice.sent.error.forbidden',
    );
  });

  it('U7: Bestätigung abgewiesen — zurückgenommen, PDF bleibt gesperrt, die Oberfläche sagt warum', async () => {
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [rechnung()] })]);
    vi.spyOn(servicePeriodService, 'syncInvoiceServicePeriodConfirmationToCloud').mockResolvedValue('forbidden');
    const render = (invoice: VorgangInvoice) =>
      root.render(
        createElement(InvoiceServicePeriodConfirmPanel, {
          vorgangId: VORGANG_ID,
          invoice,
          cloudConfirmed: null,
          translate,
          onUpdated: (next: VorgangInvoice) => render(next),
          onCloudStateChange: () => {},
        }),
      );
    await act(async () => render(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!));

    await klick('invoice-confirm-service-period');
    await ruhe();

    expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!.servicePeriodConfirmed).toBeUndefined();
    expect(container.querySelector('[data-testid="invoice-service-period-error"]')?.textContent).toBe(
      'invoice.servicePeriodConfirmForbidden',
    );
  });
});
