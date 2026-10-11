/**
 * GO-LIVE-SECURITY-01 / ABSCHLUSS — Druck über das Browsermenü.
 *
 * Das Rechnungsdokument steht immer im DOM (Druck in Safari), und das Druck-CSS machte es
 * sichtbar — Strg+P druckte deshalb auch eine Rechnung, deren Ausgabe gesperrt war
 * (unbestätigter Leistungszeitraum, fehlender Cloud-Nachweis eines Mitglieds). Jetzt trägt
 * der Druckcontainer bei gesperrter Ausgabe eine Klasse, unter der das Druck-CSS statt der
 * Rechnung nur einen Hinweis druckt.
 *
 *   P1 Inhaber, Leistungszeitraum unbestätigt: gesperrt (Klasse + Hinweis).
 *   P2 Inhaber, bestätigt: frei (keine Klasse, kein Hinweis).
 *   P3 Mitglied ohne Cloud-Nachweis: gesperrt.
 *   P4 Das Druck-CSS blendet unter der Klasse die Rechnung aus und den Hinweis ein.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { hydrateVorgangStore } from '../services/vorgangService';
import * as invoiceCloud from '../services/invoice/workspaceInvoiceCloudService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import * as supabaseLib from '../lib/supabase';
import type { VorgangInvoice } from '../types/models';
import { InvoiceDetailPage } from './InvoiceDetailPage';

const WORKSPACE = '00000000-0000-4000-8000-000000000f02';
const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-druck-sperre';

function rechnung(bestaetigt: boolean): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0072',
    type: 'rechnung',
    positions: [
      { id: 'line-1', orderPositionId: 'op-test-1', description: 'Leistung', quantity: 1, unit: 'Stück', unitPrice: 100, lineTotal: 100 },
    ],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'vorbereitet',
    servicePeriodConfirmed: bestaetigt,
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
            createElement(Route, { path: '/vorgaenge/:id/rechnungen/:invoiceId', element: createElement(InvoiceDetailPage) }),
          ),
        ),
      ),
    );
  });
  for (let runde = 0; runde < 10; runde += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return { container, root };
}

const druck = (mount: Mount) => mount.container.querySelector('[data-testid="invoice-print-document"]') as HTMLElement;
const hinweis = (mount: Mount) => mount.container.querySelector('[data-testid="invoice-print-blocked-notice"]');

describe('GLS01 Abschluss — Druck über das Browsermenü folgt der Ausgabesperre', () => {
  let mount: Mount | null = null;

  function aufbau(bestaetigt: boolean, cloudBestaetigt: boolean) {
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [rechnung(bestaetigt)] })]);
    vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceServicePeriodConfirmation').mockResolvedValue({
      found: true,
      confirmed: cloudBestaetigt,
    });
  }

  beforeEach(() => {
    resetTestStores();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
      rpc: async () => ({ data: null, error: { message: 'im Test nicht vorgesehen' } }),
    } as never);
    vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
    vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceSent').mockResolvedValue({ found: true, snapshot: null, status: 'vorbereitet' });
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

  it('P1: Inhaber, Leistungszeitraum unbestätigt — gesperrt', async () => {
    alsInhaber();
    aufbau(false, false);
    mount = await oeffnen();
    expect(druck(mount).classList.contains('invoice-print-document--print-blocked')).toBe(true);
    expect(hinweis(mount)).not.toBeNull();
  });

  it('P2: Inhaber, bestätigt — frei', async () => {
    alsInhaber();
    aufbau(true, true);
    mount = await oeffnen();
    expect(druck(mount).classList.contains('invoice-print-document--print-blocked')).toBe(false);
    expect(hinweis(mount)).toBeNull();
  });

  it('P3: Mitglied, lokal bestätigt, die Cloud trägt es nicht — gesperrt', async () => {
    alsMitglied();
    aufbau(true, false);
    mount = await oeffnen();
    expect(druck(mount).classList.contains('invoice-print-document--print-blocked')).toBe(true);
    expect(hinweis(mount)).not.toBeNull();
  });

  it('P4: das Druck-CSS blendet unter der Klasse die Rechnung aus und den Hinweis ein', () => {
    const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8').replace(/\r\n/g, '\n');
    const druckBlock = css.slice(css.indexOf('@media print {'));
    expect(druckBlock).toMatch(/\.invoice-print-document--print-blocked \.invoice-document \{\s*display: none !important;/);
    expect(druckBlock).toMatch(/\.invoice-print-document--print-blocked \.invoice-print-blocked-notice \{\s*display: block !important;/);
    // Am Bildschirm ist der Hinweis unsichtbar.
    expect(css).toMatch(/\n\.invoice-print-blocked-notice \{\s*display: none;/);
  });
});
