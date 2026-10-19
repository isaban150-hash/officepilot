/**
 * FINANZ-CORE-01A — Gesamtnacharbeit Paket 1 (INV-01/02): der sichtbare Klärungsweg an der Rechnung.
 *
 *  U1  ungeklärte Skontofrist: Hinweis mit „Fristende klären“ (nur mit Vorgang und Übernahme)
 *  U2  Dialog: Altbeleg ohne Kundenverknüpfung als NW klären → Rechnung ausgeglichen, Hinweis weg
 *  U3  Ausland: offener Hinweis, Fristauswahl und geprüftes Ende; ungeklärtes Zahlungsziel
 *  U4  Ohne Grund keine Klärung
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoicePaymentSummary } from './InvoicePaymentSummary';
import { resetTestStores } from '../../test/resetStores';
import { createTestVorgang } from '../../test/fixtures';
import { alsInhaber, alsMitglied } from '../../test/workspaceRoleTestUtils';
import * as supabaseModule from '../../lib/supabase';
import { getVorgangInvoice, hydrateVorgangStore } from '../../services/vorgangService';
import { hydrateInvoiceStore } from '../../services/invoice/invoiceStore';
import { getOpenAmount } from '../../services/invoicePaymentService';
import type { InvoicePayment, VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

const VORGANG_ID = 'v-test-1';

function translate(key: TranslationKey): string {
  return key;
}

function zahlung(id: string, amount: number, date: string): InvoicePayment {
  return { id, amount, date, createdAt: `${date}T10:00:00.000Z` };
}

function abschlag(overrides: Partial<VorgangInvoice> = {}, zip = '48431', countryCode?: string): VorgangInvoice {
  return {
    id: 'inv-ab-1', number: '2026-0101', type: 'abschlag', abschlagNumber: 1, calculationMode: 'fixed_amount',
    fixedAmountNet: 400, positions: [], subtotal: 400, taxStatus: 'standard_19', amount: 476, status: 'versendet',
    date: '2026-05-25', issueDate: '2026-05-25', createdAt: '2026-05-25T10:00:00.000Z',
    skontoText: 'Bei Zahlung innerhalb von 10 Tagen ab Rechnungsdatum gewähren wir 2 % Skonto.',
    customerSnapshot: {
      name: 'Muster GmbH', contactPerson: '', street: 'Weg 1', zip, city: 'Musterstadt', email: '', phone: '',
      ...(countryCode ? { countryCode } : {}),
    },
    payments: [zahlung('p1', 466.48, '2026-06-05')],
    ...overrides,
  };
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetTestStores();
  hydrateInvoiceStore([]);
  alsInhaber();
  vi.spyOn(supabaseModule, 'isSupabaseConfigured').mockReturnValue(false);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(invoice: VorgangInvoice, mitKlaerung: boolean, onInvoiceChange = vi.fn()) {
  act(() => {
    root.render(
      createElement(InvoicePaymentSummary, {
        invoice,
        translate,
        ...(mitKlaerung ? { vorgangId: VORGANG_ID, onInvoiceChange } : {}),
      }),
    );
  });
  return onInvoiceChange;
}

const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

describe('Klärungsweg an der Rechnung', () => {
  it('U1 Hinweis mit Klärungsknopf nur, wo die Rechnung übernommen werden kann', () => {
    render(abschlag(), false);
    expect(q('payment-summary-skonto-unclear')).not.toBeNull();
    expect(q('payment-summary-frist-clarify')).toBeNull();
    render(abschlag(), true);
    expect(q('payment-summary-frist-clarify')).not.toBeNull();
  });

  it('U2 Altbeleg ohne Kundenverknüpfung: NW geklärt, Rechnung ausgeglichen, Hinweis weg', async () => {
    const ab = abschlag();
    hydrateVorgangStore([createTestVorgang({ invoices: [ab] })]);
    const onChange = render(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!, true);
    act(() => (q('payment-summary-frist-clarify') as HTMLButtonElement).click());
    expect(q('invoice-frist-dialog')).not.toBeNull();
    expect(q('invoice-frist-current')!.textContent).toContain('Niedersachsen / Nordrhein-Westfalen');
    expect(q('invoice-frist-save-customer')).toBeNull();
    act(() => setValue(q('invoice-frist-region') as HTMLSelectElement, 'NW'));
    expect((q('invoice-frist-submit') as HTMLButtonElement).disabled).toBe(true);
    act(() => setValue(q('invoice-frist-reason') as HTMLTextAreaElement, 'Sitz laut Handelsregister'));
    expect((q('invoice-frist-submit') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      (q('invoice-frist-submit') as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const geklaert = onChange.mock.calls[0]![0] as VorgangInvoice;
    expect(geklaert.fristBasis).toMatchObject({ quelle: 'klaerung', lage: { laender: ['NW'] } });
    expect(getOpenAmount(geklaert)).toBe(0);
    render(geklaert, true, onChange);
    expect(q('payment-summary-skonto-unclear')).toBeNull();
    expect(q('payment-summary-frist-clarified')!.textContent).toContain('invoice.frist.clarifiedNote');
  });

  it('U3 Ausland: offener Hinweis, Fristauswahl, geprüftes Ende; Zahlungsziel ohne Skonto ebenso klärbar', () => {
    const china = abschlag({ date: '2026-02-06', issueDate: '2026-02-06', paymentDueDate: '2026-02-20', payments: [zahlung('p1', 466.48, '2026-02-20')] }, '200000', 'CN');
    render(china, true);
    expect(q('payment-summary-skonto-unclear')!.textContent).toBe('payment.skontoUnclearOpenNotice');
    act(() => (q('payment-summary-frist-clarify') as HTMLButtonElement).click());
    expect((q('invoice-frist-region') as HTMLSelectElement).value).toBe('AUSLAND');
    const optionen = [...(q('invoice-frist-deadline') as HTMLSelectElement).options].map((o) => o.value);
    expect(optionen).toEqual(['2026-02-16', '2026-02-20']);
    expect(q('invoice-frist-effective-end')).not.toBeNull();

    const ohneSkonto = abschlag({ date: '2026-02-06', issueDate: '2026-02-06', skontoText: '', paymentDueDate: '2026-02-20', payments: [] }, '200000', 'CN');
    render(ohneSkonto, true);
    expect(q('payment-summary-due-unclear')!.textContent).toBe('payment.dueUnclearOpenNotice');
    expect(q('payment-summary-frist-clarify')).not.toBeNull();
  });

  it('U5 Mitglied: Hinweis ja, Klärungsknopf nein (Rollenhinweis)', () => {
    alsMitglied();
    act(() => {
      root.render(createElement(InvoicePaymentSummary, { invoice: abschlag(), translate, vorgangId: VORGANG_ID, onInvoiceChange: vi.fn(), actor: { userId: 'u-2', cloudConfigured: true } }));
    });
    expect(q('payment-summary-skonto-unclear')).not.toBeNull();
    expect(q('payment-summary-frist-clarify')).toBeNull();
    expect(q('payment-summary-frist-role-hint')!.textContent).toBe('invoice.frist.roleHint');
  });

  it('U4 ohne Grund lässt sich nichts speichern', () => {
    render(abschlag(), true);
    act(() => (q('payment-summary-frist-clarify') as HTMLButtonElement).click());
    act(() => setValue(q('invoice-frist-region') as HTMLSelectElement, 'NW'));
    act(() => setValue(q('invoice-frist-reason') as HTMLTextAreaElement, ' x '));
    expect((q('invoice-frist-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});
