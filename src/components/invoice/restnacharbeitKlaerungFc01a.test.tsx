/**
 * FINANZ-CORE-01A — Restnacharbeit nach WEISS-Bericht 18:
 *
 *  R1  END18-R1 (P2): dieselbe Klärungskennung für denselben unveränderten Versuch (verlorene Antwort,
 *      erneuter Klick), eine neue Kennung nach jeder inhaltlichen Änderung; lokaler Betrieb idempotent.
 *  R2  END18-R2 (P2): eine eindeutige, aber falsche Grundlage ist über die Oberfläche berichtigbar — NI → NW und
 *      umgekehrt, protokolliert, Beleg unverändert; Mitglied ohne Knopf; nach abgezogener Schlussrechnung gesperrt;
 *      berührt die Berichtigung abgeschlossene Monate, verlangt sie eine ausdrückliche Bestätigung.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoicePaymentSummary } from './InvoicePaymentSummary';
import { resetTestStores } from '../../test/resetStores';
import { createTestVorgang } from '../../test/fixtures';
import { alsInhaber, alsMitglied } from '../../test/workspaceRoleTestUtils';
import * as supabaseModule from '../../lib/supabase';
import * as workspacePayload from '../../services/workspace/workspaceSyncPayloadService';
import { getVorgangInvoice, hydrateVorgangStore } from '../../services/vorgangService';
import { hydrateInvoiceStore } from '../../services/invoice/invoiceStore';
import { getOpenAmount } from '../../services/invoicePaymentService';
import { klaereRechnungsfrist, naechsterKlaerungsVersuch } from '../../services/invoice/invoiceFristKlaerungService';
import { hydrateAccountingPeriodStore } from '../../services/accounting/accountingPeriodStore';
import type { InvoiceFristBasis, InvoicePayment, VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

const VORGANG_ID = 'v-test-1';
const SKONTO = 'Bei Zahlung innerhalb von 10 Tagen ab Rechnungsdatum gewähren wir 2 % Skonto.';

const translate = (key: TranslationKey): string => key;

function zahlung(id: string, amount: number, date: string): InvoicePayment {
  return { id, amount, date, createdAt: `${date}T10:00:00.000Z` };
}

function basis(land: 'NI' | 'NW', quelle: InvoiceFristBasis['quelle'] = 'klaerung'): InvoiceFristBasis {
  return {
    lage: { art: 'inland', laender: [land], gemeinde: {}, quelle: quelle === 'klaerung' ? 'klaerung' : 'plz' },
    quelle,
    festgelegtAm: '2026-06-10T08:00:00.000Z',
    ...(quelle === 'klaerung'
      ? { klaerung: { id: `kl-alt-${land}`, begruendung: `versehentlich ${land}`, am: '2026-06-10T08:00:00.000Z', angabe: { art: 'inland', region: land } } }
      : {}),
  } as InvoiceFristBasis;
}

function abschlag(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-ab-1', number: '2026-0101', type: 'abschlag', abschlagNumber: 1, calculationMode: 'fixed_amount',
    fixedAmountNet: 400, positions: [], subtotal: 400, taxStatus: 'standard_19', amount: 476, status: 'versendet',
    date: '2026-05-25', issueDate: '2026-05-25', createdAt: '2026-05-25T10:00:00.000Z', skontoText: SKONTO,
    customerSnapshot: { name: 'Grenz GmbH', contactPerson: '', street: 'Weg 1', zip: '48431', city: 'Rheine', email: '', phone: '' },
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

const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

function render(invoice: VorgangInvoice, extra: Record<string, unknown> = {}) {
  const onInvoiceChange = vi.fn();
  act(() => {
    root.render(createElement(InvoicePaymentSummary, { invoice, translate, vorgangId: VORGANG_ID, onInvoiceChange, ...extra }));
  });
  return onInvoiceChange;
}

async function speichern() {
  await act(async () => {
    (q('invoice-frist-submit') as HTMLButtonElement).click();
  });
}

describe('R1 — END18-R1: dieselbe Kennung für denselben Versuch', () => {
  it('R1a naechsterKlaerungsVersuch: gleicher Inhalt → gleiche Kennung; Ort oder Grundlage geändert → neue', () => {
    const a = naechsterKlaerungsVersuch(undefined, { art: 'inland', region: 'NW' }, 'Sitz laut Vertrag');
    expect(a.id).toMatch(/^kl-/);
    expect(naechsterKlaerungsVersuch(a, { art: 'inland', region: 'NW' }, '  Sitz laut Vertrag ')).toBe(a);
    expect(naechsterKlaerungsVersuch(a, { art: 'inland', region: 'NI' }, 'Sitz laut Vertrag').id).not.toBe(a.id);
    expect(naechsterKlaerungsVersuch(a, { art: 'inland', region: 'NW' }, 'Andere Grundlage').id).not.toBe(a.id);
  });

  it('R1b WEISS-Dialog: verlorene Antwort, unverändert erneut gespeichert → dieselbe Kennung; nach Änderung eine neue', async () => {
    vi.spyOn(supabaseModule, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue('00000000-0000-4000-8000-0000000000d1');
    const rpc = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    vi.spyOn(supabaseModule, 'getSupabaseClient').mockReturnValue({ rpc } as never);
    hydrateVorgangStore([createTestVorgang({ invoices: [abschlag()] })]);
    render(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!);
    act(() => (q('payment-summary-frist-clarify') as HTMLButtonElement).click());
    act(() => setValue(q('invoice-frist-region') as HTMLSelectElement, 'NW'));
    act(() => setValue(q('invoice-frist-reason') as HTMLTextAreaElement, 'Sitz laut Handelsregister'));
    await speichern();
    expect(q('invoice-frist-error')).not.toBeNull();
    await speichern();
    const ids = rpc.mock.calls.map((call) => (call as unknown as [string, { p_client_klaerung_id: string }])[1].p_client_klaerung_id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    act(() => setValue(q('invoice-frist-reason') as HTMLTextAreaElement, 'Sitz laut Gewerbeanmeldung'));
    await speichern();
    const dritte = (rpc.mock.calls[2] as unknown as [string, { p_client_klaerung_id: string }])[1].p_client_klaerung_id;
    expect(dritte).not.toBe(ids[0]);
  });

  it('R1c lokaler Betrieb: dieselbe Kennung zweimal ändert nichts ein zweites Mal', async () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [abschlag()] })]);
    const eingabe = { vorgangId: VORGANG_ID, invoiceId: 'inv-ab-1', klaerung: { art: 'inland' as const, region: 'NW' as const }, begruendung: 'Sitz NW', klaerungId: 'kl-lokal-1' };
    const erste = await klaereRechnungsfrist(eingabe);
    if (!erste.ok) throw new Error(erste.errorKey);
    const am = erste.invoice.fristBasis!.festgelegtAm;
    const zweite = await klaereRechnungsfrist(eingabe);
    expect(zweite.ok).toBe(true);
    expect(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!.fristBasis!.festgelegtAm).toBe(am);
  });
});

describe('R2 — END18-R2: eine eindeutige, aber falsche Grundlage berichtigen', () => {
  it('R2a WEISS: versehentlich NI (9,52 offen) → Berichtigung NW (0,00), protokolliert, Beleg unverändert', async () => {
    const ab = abschlag({ fristBasis: basis('NI') });
    hydrateVorgangStore([createTestVorgang({ invoices: [ab] })]);
    const vorher = getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!;
    expect(getOpenAmount(vorher)).toBe(9.52);
    const onChange = render(vorher);
    expect(q('payment-summary-skonto-unclear')).toBeNull();
    expect(q('payment-summary-frist-clarify')).toBeNull();
    act(() => (q('payment-summary-frist-correct') as HTMLButtonElement).click());
    expect(q('invoice-frist-dialog')!.textContent).toContain('invoice.frist.correctTitle');
    act(() => setValue(q('invoice-frist-region') as HTMLSelectElement, 'NW'));
    act(() => setValue(q('invoice-frist-reason') as HTMLTextAreaElement, 'Sitz Rheine liegt in NW (Handelsregister)'));
    await speichern();
    const berichtigt = onChange.mock.calls[0]![0] as VorgangInvoice;
    expect(berichtigt.fristBasis).toMatchObject({ quelle: 'klaerung', lage: { laender: ['NW'] }, klaerung: { begruendung: 'Sitz Rheine liegt in NW (Handelsregister)' } });
    expect(getOpenAmount(berichtigt)).toBe(0);
    // Beleg unverändert: Beträge, Positionen, Skontotext, Zahlungen.
    const { fristBasis: _a, ...belegVorher } = vorher;
    const { fristBasis: _b, ...belegNachher } = getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!;
    expect(belegNachher).toEqual(belegVorher);
  });

  it('R2b umgekehrt: NW → NI berichtigt, danach 9,52 offen', async () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [abschlag({ fristBasis: basis('NW') })] })]);
    const onChange = render(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!);
    act(() => (q('payment-summary-frist-correct') as HTMLButtonElement).click());
    act(() => setValue(q('invoice-frist-region') as HTMLSelectElement, 'NI'));
    act(() => setValue(q('invoice-frist-reason') as HTMLTextAreaElement, 'Sitz tatsächlich Bad Bentheim (NI)'));
    await speichern();
    expect(getOpenAmount(onChange.mock.calls[0]![0] as VorgangInvoice)).toBe(9.52);
  });

  it('R2c auch eine bei der Freigabe gebundene Grundlage ist berichtigbar', () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [abschlag({ fristBasis: basis('NI', 'freigabe') })] })]);
    render(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!);
    expect(q('payment-summary-frist-correct')).not.toBeNull();
  });

  it('R2d Mitglied: kein Berichtigungsknopf', () => {
    alsMitglied();
    hydrateVorgangStore([createTestVorgang({ invoices: [abschlag({ fristBasis: basis('NI') })] })]);
    render(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!, { actor: { userId: 'u-2', cloudConfigured: true } });
    expect(q('payment-summary-frist-correct')).toBeNull();
  });

  it('R2e nach abgezogener Schlussrechnung: kein Knopf, sichtbarer Grund; der Dienst weist ab', async () => {
    const ab = abschlag({ fristBasis: basis('NI') });
    const schluss: VorgangInvoice = {
      id: 'inv-schluss-1', number: '2026-0102', type: 'schluss', positions: [], subtotal: 1000, taxStatus: 'standard_19',
      amount: 714, status: 'versendet', date: '2026-07-01', issueDate: '2026-07-01', createdAt: '2026-07-01T10:00:00.000Z', payments: [],
      previousAbschlagDeductions: [{ invoiceId: 'inv-ab-1', invoiceNumber: '2026-0101', abschlagNumber: 1, date: '2026-05-25', subtotal: 400, amount: 476, paidAmount: 466.48, skontoAmount: 0 }],
    };
    hydrateVorgangStore([createTestVorgang({ invoices: [ab, schluss] })]);
    render(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!);
    expect(q('payment-summary-frist-correct')).toBeNull();
    expect(q('payment-summary-frist-locked')).not.toBeNull();
    const versuch = await klaereRechnungsfrist({ vorgangId: VORGANG_ID, invoiceId: 'inv-ab-1', klaerung: { art: 'inland', region: 'NW' }, begruendung: 'Umgehung' });
    expect(versuch).toMatchObject({ ok: false, errorKey: 'invoice.frist.finalInvoiceExists' });
  });

  it('R2f abgeschlossener Zahlungsmonat: Hinweis und ausdrückliche Bestätigung vor dem Speichern', () => {
    hydrateAccountingPeriodStore([
      { id: 'cl-juni', monthKey: '2026-06', revision: 1, fingerprint: 'p4:x:1', manifest: { monthKey: '2026-06', fingerprintVersion: 4, entries: [], payments: [] }, closedAt: '2026-07-02T10:00:00.000Z' } as never,
    ]);
    hydrateVorgangStore([createTestVorgang({ invoices: [abschlag({ fristBasis: basis('NI') })] })]);
    render(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!);
    act(() => (q('payment-summary-frist-correct') as HTMLButtonElement).click());
    expect(q('invoice-frist-closed-months')!.getAttribute('data-months')).toBe('2026-06');
    act(() => setValue(q('invoice-frist-region') as HTMLSelectElement, 'NW'));
    act(() => setValue(q('invoice-frist-reason') as HTMLTextAreaElement, 'Sitz NW'));
    expect((q('invoice-frist-submit') as HTMLButtonElement).disabled).toBe(true);
    act(() => (q('invoice-frist-closed-ack') as HTMLInputElement).click());
    expect((q('invoice-frist-submit') as HTMLButtonElement).disabled).toBe(false);
  });
});
