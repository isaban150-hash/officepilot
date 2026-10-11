/**
 * GO-LIVE-SECURITY-01 — Client-Nacharbeit, Rechnungsdetailseite.
 *
 * Auf dem Gerät eines Mitglieds liegt ein Altzustand: ein Versandvermerk und
 * eine Bestätigung des Leistungszeitraums, die die Cloud nicht trägt. Beim
 * Öffnen gleicht die Seite beides an den Cloud-Stand an, bevor es Mahnung,
 * PDF oder Druck freigibt, und sagt es. Bei Inhabern bleibt der lokale Stand
 * ein noch nicht gesicherter Vermerk mit „Jetzt sichern". Kein Netzwerk.
 */
import { act, createElement } from 'react';
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
import { validateFinalizedInvoiceForPdf } from '../services/invoiceValidationService';
import { canDocumentDunningForInvoice } from '../services/dunningDocumentationService';
import * as invoiceCloud from '../services/invoice/workspaceInvoiceCloudService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import * as supabaseLib from '../lib/supabase';
import type { VorgangInvoice } from '../types/models';
import { InvoiceDetailPage } from './InvoiceDetailPage';

const WORKSPACE = '00000000-0000-4000-8000-000000000a03';
const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-gls01-seite';

function altzustand(): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0033',
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
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    companySnapshot: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Beispiel Betrieb GmbH',
      street: 'Werkstraße 2',
      zip: '54321',
      city: 'Beispielstadt',
      iban: 'DE00 0000 0000 0000 0000 00',
    },
    legalNotices: [],
    previousAbschlagDeductions: [],
    paymentStatus: 'offen',
    payments: [],
  } as VorgangInvoice;
}

type Mount = { container: HTMLDivElement; root: Root };

async function oeffnen(): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/vorgaenge/${VORGANG_ID}/rechnungen/${INVOICE_ID}`] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/vorgaenge/:id/rechnungen/:invoiceId',
              element: createElement(InvoiceDetailPage),
            }),
          ),
        ),
      ),
    );
  });
  for (let runde = 0; runde < 12; runde += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return { container, root };
}

const q = (mount: Mount, id: string) => mount.container.querySelector(`[data-testid="${id}"]`);
const lokal = () => getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;

describe('GLS01 Rechnungsdetailseite — Altzustand auf dem Gerät eines Mitglieds', () => {
  let mount: Mount | null = null;

  beforeEach(() => {
    resetTestStores();
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [altzustand()] })]);
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
      rpc: async () => ({ data: null, error: { message: 'im Test nicht vorgesehen' } }),
    } as never);
    vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
    // Die Cloud trägt weder den Vermerk noch die Bestätigung.
    vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceSent').mockResolvedValue({
      found: true,
      snapshot: null,
      status: 'vorbereitet',
    });
    vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceServicePeriodConfirmation').mockResolvedValue({
      found: true,
      confirmed: false,
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

  it('S1: Mitglied — Versand und Bestätigung werden angeglichen; Mahnung, PDF und Druck gesperrt', async () => {
    alsMitglied();
    expect(canDocumentDunningForInvoice(lokal())).toBe(true);

    mount = await oeffnen();

    expect(lokal().status).toBe('vorbereitet');
    expect(lokal().sentAt).toBeUndefined();
    expect(lokal().servicePeriodConfirmed).toBe(false);
    expect(canDocumentDunningForInvoice(lokal())).toBe(false);
    expect(validateFinalizedInvoiceForPdf(lokal()).blockingErrors.map((error) => error.code)).toContain(
      'service_period_unconfirmed',
    );
    expect(q(mount, 'invoice-sent-role-aligned')).not.toBeNull();
    expect(q(mount, 'invoice-service-period-role-aligned')).not.toBeNull();
    expect(q(mount, 'invoice-service-period-role-hint')).not.toBeNull();
    expect(q(mount, 'invoice-confirm-service-period')).toBeNull();
    expect(q(mount, 'invoice-sent-mark')).toBeNull();
  });

  it('S2: Inhaber — der lokale Stand bleibt ein noch nicht gesicherter Vermerk', async () => {
    alsInhaber();

    mount = await oeffnen();

    expect(lokal().status).toBe('versendet');
    expect(lokal().servicePeriodConfirmed).toBe(true);
    expect(q(mount, 'invoice-sent-role-aligned')).toBeNull();
    expect(q(mount, 'invoice-sent-secure-now')).not.toBeNull();
    expect(q(mount, 'invoice-secure-service-period')).not.toBeNull();
  });
});
