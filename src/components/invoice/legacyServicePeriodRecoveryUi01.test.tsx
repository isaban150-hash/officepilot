/**
 * LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B — Oberfläche.
 *
 * Zwei Dinge werden hier festgehalten:
 *
 *   1. Das Recovery-Panel erscheint genau dann, wenn eine finalisierte Rechnung
 *      einen gültigen gespeicherten Leistungszeitraum trägt, aber keine
 *      Bestätigung — und niemals mit Eingabefeldern.
 *   2. „Drucken" umging bisher die Validierung finalisierter Rechnungen und gab
 *      einen Beleg aus, den der PDF-Pfad zu Recht verweigerte. Beide Wege
 *      müssen denselben zentralen Validator respektieren.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { buildInvoicePrintModelFromInvoice } from '../../services/invoicePrintModel';
import * as invoicePrintService from '../../services/invoicePrintService';
import type { TranslationKey } from '../../i18n';
import type { VorgangInvoice } from '../../types/models';
import { InvoicePrintActions } from './InvoicePrintActions';
import { InvoiceServicePeriodConfirmPanel } from './InvoiceServicePeriodConfirmPanel';

function translate(key: TranslationKey): string {
  return key;
}

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Beispiel Betrieb GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Beispielstadt',
  iban: 'DE00 0000 0000 0000 0000 00',
};

function legacyInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-ui-sp-1',
    number: '2026-0011',
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
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-05',
    paymentDueDate: '2026-06-15',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    skontoText: '',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
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
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

function panelMarkup(invoice: VorgangInvoice, cloudConfirmed: boolean | null = null): string {
  return renderToStaticMarkup(
    createElement(InvoiceServicePeriodConfirmPanel, {
      vorgangId: 'v-test-1',
      invoice,
      cloudConfirmed,
      translate,
      onUpdated: () => {},
      onCloudStateChange: () => {},
    }),
  );
}

describe('SP-RECOVERY-UI — Sichtbarkeit des Recovery-Panels', () => {
  it('R3: eine Legacy-Rechnung mit gültigem Zeitraum zeigt das Panel', () => {
    const markup = panelMarkup(legacyInvoice());
    expect(markup).toContain('invoice-service-period-recovery');
    expect(markup).toContain('invoice.confirmServicePeriod');
    // Der gespeicherte Zeitraum wird angezeigt, nicht der Fachbegriff.
    expect(markup).not.toContain('servicePeriodConfirmed');
  });

  it('R18: eine bestätigte Rechnung zeigt kein Recovery-Panel', () => {
    expect(panelMarkup(legacyInvoice({ servicePeriodConfirmed: true }), true)).toBe('');
  });

  it('R10/R11/R12: ohne gültigen gespeicherten Zeitraum erscheint kein Bestätigungsknopf', () => {
    for (const broken of [
      { servicePeriodFrom: undefined },
      { servicePeriodTo: undefined },
      { servicePeriodFrom: '01.09.2026' },
      { servicePeriodFrom: '2026-02-30' },
      { servicePeriodFrom: '2026-09-05', servicePeriodTo: '2026-09-01' },
    ]) {
      expect(panelMarkup(legacyInvoice(broken)), JSON.stringify(broken)).toBe('');
    }
  });

  it('R13: eine nicht finalisierte Rechnung zeigt kein Panel', () => {
    expect(panelMarkup(legacyInvoice({ status: 'entwurf' }))).toBe('');
  });

  it('R39: das Panel enthält keine Eingabefelder für den Zeitraum', () => {
    const markup = panelMarkup(legacyInvoice());
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('type="date"');
  });
});

describe('SP-RECOVERY-UI — Sicherungshinweis', () => {
  it('R24: lokal bestätigt und Cloud bestätigt zeigt nichts', () => {
    expect(panelMarkup(legacyInvoice({ servicePeriodConfirmed: true }), true)).toBe('');
  });

  it('R25/R26: lokal bestätigt, Cloud nachweislich nicht — Sicherungshinweis', () => {
    const markup = panelMarkup(legacyInvoice({ servicePeriodConfirmed: true }), false);
    expect(markup).toContain('invoice-service-period-pending');
    expect(markup).toContain('invoice.servicePeriodCloudPending');
    expect(markup).toContain('invoice.servicePeriodSecureNow');
  });

  it('R27: bei unbekanntem Cloud-Zustand wird nichts behauptet', () => {
    expect(panelMarkup(legacyInvoice({ servicePeriodConfirmed: true }), null)).toBe('');
  });

  it('E3: eine in der Cloud fehlende Rechnung bekommt keinen aussichtslosen Knopf', () => {
    /*
     * 01B2 — `missing` bildet die Detailseite auf `null` ab. Es darf kein
     * „Jetzt sichern" erscheinen: Die Confirm-RPC kann eine nicht vorhandene
     * Cloud-Zeile nicht ergänzen, der Knopf könnte nie gelingen.
     */
    const markup = panelMarkup(legacyInvoice({ servicePeriodConfirmed: true }), null);
    expect(markup).not.toContain('invoice-secure-service-period');
    expect(markup).not.toContain('invoice.servicePeriodSecureNow');
    expect(markup).toBe('');
  });
});

describe('SP-RECOVERY-UI — Print/PDF-Parität', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function render(invoice: VorgangInvoice): void {
    const model = buildInvoicePrintModelFromInvoice(invoice);
    act(() => {
      root.render(
        createElement(InvoicePrintActions, { invoice, model, translate }),
      );
    });
  }

  it('R2: vor dem Recovery gibt „Drucken" den Beleg nicht aus', () => {
    const printSpy = vi.spyOn(invoicePrintService, 'printInvoice').mockImplementation(() => {});
    render(legacyInvoice());

    const button = container.querySelector<HTMLButtonElement>('[data-testid="invoice-print"]')!;
    expect(button).not.toBeNull();
    act(() => button.click());

    expect(printSpy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="invoice-pdf-error"]')).not.toBeNull();
  });

  it('R8: nach dem Recovery druckt derselbe Knopf', () => {
    const printSpy = vi.spyOn(invoicePrintService, 'printInvoice').mockImplementation(() => {});
    render(legacyInvoice({ servicePeriodConfirmed: true }));

    const button = container.querySelector<HTMLButtonElement>('[data-testid="invoice-print"]')!;
    act(() => button.click());

    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="invoice-pdf-error"]')).toBeNull();
  });

  it('R45: auch andere Blocker des zentralen Validators hält der Druck ein', () => {
    const printSpy = vi.spyOn(invoicePrintService, 'printInvoice').mockImplementation(() => {});
    // Eine Entwurfsnummer blockiert den PDF-Pfad unabhängig vom Leistungszeitraum.
    render(legacyInvoice({ servicePeriodConfirmed: true, number: 'ENTWURF' }));

    const button = container.querySelector<HTMLButtonElement>('[data-testid="invoice-print"]')!;
    act(() => button.click());

    expect(printSpy).not.toHaveBeenCalled();
  });
});
