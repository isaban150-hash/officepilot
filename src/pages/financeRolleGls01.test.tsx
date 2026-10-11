/**
 * GO-LIVE-SECURITY-01 / ABSCHLUSS — Geld und Buchhaltung auf dem Gerät eines Mitglieds.
 *
 * Der Server weist Zahlungen, Storno, Kontierung, Monatsabschluss und Ausgaben von
 * Mitgliedern ab (finance_forbidden_role). Bisher bot die Oberfläche sie trotzdem an,
 * buchte die Zahlung zuerst lokal und nahm sie nach der Abweisung nie zurück. Geprüft:
 *
 *   F1 Detailseite: Mitglied sieht den Rollenhinweis statt Zahlung, Storno und Kontierung.
 *   F2 Detailseite: Inhaber wie bisher.
 *   F3 Dienst: Mit Akteur bucht ein Mitglied nichts; ohne Akteur wie bisher.
 *   F4 Formular: Weist die Cloud die Zahlung ab, wird sie lokal zurückgenommen.
 *   F4b Formular: Die Rücknahme meldet keinen zweiten Erfolg (eigener Rückruf statt onSaved).
 *   F4c Formular mit echtem Elternzustand: Der Rücknahme-Hinweis bleibt stehen.
 *   F5 Kontierung und Monatsabschluss: schreibgeschützt mit Hinweis.
 *   F6 Ausgabenliste: Mitglied legt keine Ausgabe an.
 *   F7 Storno: Eine Finanzabweisung ist „keine Berechtigung“, nicht „unbekannt“.
 *
 * Kein Netzwerk.
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alsInhaber, alsMitglied } from '../test/workspaceRoleTestUtils';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { resetTestStores } from '../test/resetStores';
import { createTestVorgang } from '../test/fixtures';
import { getVorgangInvoice, hydrateVorgangStore } from '../services/vorgangService';
import * as invoiceCloud from '../services/invoice/workspaceInvoiceCloudService';
import * as invoicePayments from '../services/invoicePaymentService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import * as supabaseLib from '../lib/supabase';
import { cancelFinalizedInvoice } from '../services/invoice/invoiceCancellationService';
import { InvoicePaymentForm } from '../components/invoice/InvoicePaymentForm';
import { AccountingAssignmentPanel } from '../components/accounting/AccountingAssignmentPanel';
import { AccountingPeriodPanel } from '../components/accounting/AccountingPeriodPanel';
import type { VorgangInvoice } from '../types/models';
import { InvoiceDetailPage } from './InvoiceDetailPage';
import { AusgabenPage } from './AusgabenPage';

const WORKSPACE = '00000000-0000-4000-8000-000000000f01';
const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-abschluss-geld';

function rechnung(): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0071',
    type: 'rechnung',
    positions: [
      { id: 'line-1', orderPositionId: 'op-test-1', description: 'Leistung', quantity: 2, unit: 'Stunden', unitPrice: 50, lineTotal: 100 },
    ],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    sentAt: '2026-06-02',
    sentVia: 'post',
    sentSource: 'manual',
    servicePeriodConfirmed: true,
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-05',
    paymentDueDate: '2026-06-15',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    customerSnapshot: { name: 'Kundschaft GmbH', contactPerson: '', street: 'Weg 1', zip: '12345', city: 'Stadt', email: '', phone: '' },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb GmbH', street: 'Straße 2', zip: '54321', city: 'Stadt', iban: 'DE00 0000 0000 0000 0000 00' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    paymentStatus: 'offen',
    payments: [],
  } as VorgangInvoice;
}

type Mount = { container: HTMLDivElement; root: Root };

async function render(node: ReturnType<typeof createElement>): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  for (let runde = 0; runde < 10; runde += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return { container, root };
}

function mitApp(element: ReturnType<typeof createElement>, pfad: string, route: string) {
  return createElement(
    MemoryRouter,
    { initialEntries: [pfad] },
    createElement(
      AppProvider,
      { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
      createElement(Routes, null, createElement(Route, { path: route, element })),
    ),
  );
}

const q = (mount: Mount, id: string) => mount.container.querySelector(`[data-testid="${id}"]`);
const lokal = () => getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;

describe('GLS01 Abschluss — Geld und Buchhaltung', () => {
  let mount: Mount | null = null;

  beforeEach(() => {
    resetTestStores();
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [rechnung()] })]);
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
      rpc: async () => ({ data: null, error: { message: 'im Test nicht vorgesehen' } }),
    } as never);
    vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
    vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceSent').mockResolvedValue({
      found: true,
      snapshot: { sentAt: '2026-06-02', sentVia: 'post', sentSource: 'manual' } as never,
      status: 'versendet',
    });
    vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceServicePeriodConfirmation').mockResolvedValue({
      found: true,
      confirmed: true,
    });
  });

  afterEach(() => {
    if (mount) {
      act(() => mount!.root.unmount());
      mount.container.remove();
      mount = null;
    }
    vi.restoreAllMocks();
    resetTestStores();
  });

  const detailseite = () =>
    render(mitApp(createElement(InvoiceDetailPage), `/vorgaenge/${VORGANG_ID}/rechnungen/${INVOICE_ID}`, '/vorgaenge/:id/rechnungen/:invoiceId'));

  it('F1: Mitglied — Rollenhinweis statt Zahlung, Storno und Kontierung', async () => {
    alsMitglied();
    mount = await detailseite();
    expect(q(mount, 'invoice-finance-role-hint')).not.toBeNull();
    expect(q(mount, 'invoice-cancel-action')).toBeNull();
    expect(q(mount, 'invoice-accounting-start')).toBeNull();
    expect(q(mount, 'invoice-accounting-role-hint')).not.toBeNull();
    expect(mount.container.textContent).not.toContain('Zahlung erfassen');
  });

  it('F2: Inhaber — Zahlung, Storno und Kontierung wie bisher', async () => {
    alsInhaber();
    mount = await detailseite();
    expect(q(mount, 'invoice-finance-role-hint')).toBeNull();
    expect(q(mount, 'invoice-cancel-action')).not.toBeNull();
    expect(q(mount, 'invoice-accounting-start')).not.toBeNull();
  });

  it('F3: Dienst — mit Akteur bucht ein Mitglied nichts; Inhaber und Aufruf ohne Akteur wie bisher', () => {
    const akteur = { userId: 'nutzer-1', cloudConfigured: true };
    alsMitglied();
    const abgewiesen = invoicePayments.recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-06-10', amount: 50 }, { actor: akteur });
    expect(abgewiesen).toEqual({ success: false, errorKey: 'payment.forbidden' });
    expect(lokal().payments ?? []).toHaveLength(0);

    alsInhaber();
    const gebucht = invoicePayments.recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-06-10', amount: 50 }, { actor: akteur });
    expect(gebucht.success).toBe(true);
    expect(lokal().payments).toHaveLength(1);

    // Ohne Akteur (Altaufrufer, Tests): keine Rollenprüfung im Dienst.
    alsMitglied();
    expect(invoicePayments.recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-06-11', amount: 10 }).success).toBe(true);
  });

  it('F4: Formular — weist die Cloud die Zahlung ab, wird sie lokal zurückgenommen', async () => {
    alsInhaber();
    const sync = vi.spyOn(invoicePayments, 'syncInvoicePaymentToCloud').mockResolvedValue('denied');
    const gespeichert: VorgangInvoice[] = [];
    mount = await render(
      createElement(InvoicePaymentForm, {
        vorgangId: VORGANG_ID,
        invoice: rechnung(),
        open: true,
        onClose: () => undefined,
        onSaved: (invoice: VorgangInvoice) => gespeichert.push(invoice),
        translate: (key: string) => key,
      } as never),
    );
    expect(q(mount, 'payment-save')).not.toBeNull();
    // Betrag setzen und das Formular absenden (wie in expenseOverpaymentDialog05c).
    const betrag = mount.container.querySelector('input[type="number"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(betrag, '50');
      betrag.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const formular = mount.container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      formular.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    for (let runde = 0; runde < 6; runde += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(sync).toHaveBeenCalledTimes(1);
    expect(lokal().payments ?? []).toHaveLength(0);
    expect(gespeichert.at(-1)?.payments ?? []).toHaveLength(0);
    expect(mount.container.textContent).toContain('payment.roleReverted');
  });

  it('F4b: Formular — nach der Rücknahme keine zweite Erfolgsmeldung (onReverted statt onSaved)', async () => {
    alsInhaber();
    vi.spyOn(invoicePayments, 'syncInvoicePaymentToCloud').mockResolvedValue('denied');
    const gespeichert: VorgangInvoice[] = [];
    const zurueckgenommen: VorgangInvoice[] = [];
    mount = await render(
      createElement(InvoicePaymentForm, {
        vorgangId: VORGANG_ID,
        invoice: rechnung(),
        open: true,
        onClose: () => undefined,
        onSaved: (invoice: VorgangInvoice) => gespeichert.push(invoice),
        onReverted: (invoice: VorgangInvoice) => zurueckgenommen.push(invoice),
        translate: (key: string) => key,
      } as never),
    );
    const betrag = mount.container.querySelector('input[type="number"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(betrag, '50');
      betrag.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const formular = mount.container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      formular.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    for (let runde = 0; runde < 6; runde += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    // Die lokale Buchung meldet sich genau einmal (vor der Cloud-Antwort) …
    expect(gespeichert).toHaveLength(1);
    expect(gespeichert[0].payments).toHaveLength(1);
    // … die Rücknahme läuft über den eigenen Rückruf, ohne Erfolgsmeldung.
    expect(zurueckgenommen).toHaveLength(1);
    expect(zurueckgenommen[0].payments ?? []).toHaveLength(0);
    expect(mount.container.textContent).toContain('payment.roleReverted');
  });

  it('F4c: Formular mit echtem Elternzustand — der Rücknahme-Hinweis bleibt nach der Abweisung stehen', async () => {
    alsInhaber();
    vi.spyOn(invoicePayments, 'syncInvoicePaymentToCloud').mockResolvedValue('denied');
    // Wie die Detailseite: Speichern und Rücknahme reichen den neuen Stand an das Formular zurück,
    // dadurch ändert sich der offene Betrag zweimal (Live-Befund der App-Prüfung).
    function Eltern() {
      const [invoice, setInvoice] = useState<VorgangInvoice>(rechnung());
      return createElement(InvoicePaymentForm, {
        vorgangId: VORGANG_ID,
        invoice,
        open: true,
        onClose: () => undefined,
        onSaved: setInvoice,
        onReverted: setInvoice,
        translate: (key: string) => key,
      } as never);
    }
    mount = await render(createElement(Eltern));
    const betrag = mount.container.querySelector('input[type="number"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(betrag, '50');
      betrag.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const formular = mount.container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      formular.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    for (let runde = 0; runde < 6; runde += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(lokal().payments ?? []).toHaveLength(0);
    expect(mount.container.textContent).toContain('payment.roleReverted');
  });

  it('F5: Kontierung und Monatsabschluss — schreibgeschützt mit Hinweis', async () => {
    mount = await render(
      createElement(AccountingAssignmentPanel, {
        assignment: undefined,
        onStart: () => undefined,
        onChanged: () => undefined,
        translate: (key: string) => key,
        testIdPrefix: 'probe',
        readOnly: true,
      } as never),
    );
    expect(q(mount, 'probe-accounting-start')).toBeNull();
    expect(q(mount, 'probe-accounting-role-hint')).not.toBeNull();
    act(() => mount!.root.unmount());
    mount.container.remove();

    const zustand = {
      monthKey: '2026-09',
      readiness: 'ready',
      blockers: [],
      currentFingerprint: 'fp',
      currentManifest: { documentCount: 0 },
      activeClosure: null,
      revisionHistory: [],
    };
    mount = await render(
      createElement(AccountingPeriodPanel, {
        state: zustand,
        monthLabel: 'September 2026',
        onChanged: () => undefined,
        translate: (key: string) => key,
        canWrite: false,
      } as never),
    );
    expect(q(mount, 'accounting-period-close')).toBeNull();
    expect(q(mount, 'accounting-period-role-hint')).not.toBeNull();
  });

  it('F6: Ausgabenliste — Mitglied legt keine Ausgabe an, Inhaber wie bisher', async () => {
    alsMitglied();
    mount = await render(mitApp(createElement(AusgabenPage), '/ausgaben', '/ausgaben'));
    expect(q(mount, 'ausgaben-role-hint')).not.toBeNull();
    expect(mount.container.querySelector('a[href="/ausgaben/neu"]')).toBeNull();
    act(() => mount!.root.unmount());
    mount.container.remove();

    vi.restoreAllMocks();
    alsInhaber();
    mount = await render(mitApp(createElement(AusgabenPage), '/ausgaben', '/ausgaben'));
    expect(q(mount, 'ausgaben-role-hint')).toBeNull();
    expect(mount.container.querySelector('a[href="/ausgaben/neu"]')).not.toBeNull();
  });

  it('F7: Storno — eine Finanzabweisung des Servers ist „keine Berechtigung“', async () => {
    vi.spyOn(invoiceCloud, 'rpcCancelWorkspaceInvoice').mockRejectedValue(
      new invoiceCloud.WorkspaceInvoiceCloudError(
        'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht',
        'financial_action_denied',
        false,
      ),
    );
    const ergebnis = await cancelFinalizedInvoice({ vorgangId: VORGANG_ID, invoiceId: INVOICE_ID, reason: 'Fehler' });
    expect(ergebnis).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(lokal().cancelledAt).toBeUndefined();
  });
});
