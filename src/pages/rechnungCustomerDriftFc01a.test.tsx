import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { billingFromCustomer, createCustomer, updateCustomer } from '../services/customerService';
import { hydrateCustomerStore } from '../services/customerStoreService';
import { AppProvider } from '../context/AppContext';
import { RechnungPage } from './RechnungPage';
import { createTestVorgangWithExecutedQuantity } from '../test/fixtures';
import { disableInvoiceDraftCloudSyncForTests } from '../test/invoiceDraftCloudSwitch';
import { hydrateVorgangStore } from '../services/vorgangService';
import { resetInvoiceDraftDurabilityDatabaseForTests } from '../services/invoice/invoiceDraftDurabilityService';
import * as coordinator from '../services/invoice/invoiceFinalizationCoordinator';
import * as scopeService from '../services/storage/storageScopeService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import type { CompanyProfile, Customer } from '../types/models';

/**
 * FINANZ-CORE-01A (KUN-08) — die Rückfrage zu geänderten Kundendaten im echten Freigabepfad.
 *
 * Wie bei den Firmendaten (COMPANY-PROFILE-DRAFT-DRIFT-01E): Wurde der Kundenstamm seit dem
 * Entwurf geändert, friert die Freigabe den alten Empfänger nicht still ein, sondern fragt.
 *
 *  D1  ohne Änderung kein zusätzliches Gate
 *  D2  eine geänderte Anschrift öffnet die Rückfrage statt der Freigabe
 *  D3  „Angaben dieser Rechnung behalten" gibt frei, der Entwurf bleibt
 *  D4  „Aktuelle Kundendaten übernehmen" schreibt den Stamm vollständig und gibt frei
 *  D5  KUN-04: „Aus Kundenstamm übernehmen" entfernt ein im Stamm gelöschtes Feld
 *
 * Synthetische Daten, kein Netz.
 */

const WORKSPACE = 'ws-kun08';
const VORGANG = 'vg-kun08';

type Mount = { container: HTMLDivElement; root: Root };

const PROFILE: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Beispiel Betrieb GmbH',
  legalForm: 'GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Betriebsstadt',
  taxNumber: '11/222/33333',
  iban: 'DE89 3704 0044 0532 0130 00',
  bankName: 'Sparkasse Beispiel',
  bic: 'COBADEFFXXX',
};

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function waitFor(check: () => boolean, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderPage(): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/${VORGANG}/rechnung?type=abschlag`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
            <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={<div data-testid="invoice-detail" />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  const mount = { container, root };
  await waitFor(() => container.querySelector('[data-testid="rechnung-page"]') !== null);
  return mount;
}

function q<T extends HTMLElement>(mount: Mount, testId: string): T | null {
  return mount.container.querySelector<T>(`[data-testid="${testId}"]`);
}

async function click(mount: Mount, testId: string): Promise<void> {
  const el = q<HTMLButtonElement>(mount, testId);
  expect(el, `${testId} fehlt`).not.toBeNull();
  await act(async () => {
    el!.click();
    await Promise.resolve();
  });
  await settle();
}

async function fillServicePeriod(mount: Mount): Promise<void> {
  const setValue = (element: HTMLInputElement, value: string): void => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const from = q<HTMLInputElement>(mount, 'invoice-service-period-from');
  const to = q<HTMLInputElement>(mount, 'invoice-service-period-to');
  if (!from || !to) return;
  await act(async () => {
    setValue(from, '2026-08-01');
    await Promise.resolve();
  });
  await act(async () => {
    setValue(to, '2026-08-20');
    await Promise.resolve();
  });
  await settle();
  if (q<HTMLButtonElement>(mount, 'invoice-confirm-service-period')) await click(mount, 'invoice-confirm-service-period');
}

async function gotoPreview(mount: Mount): Promise<void> {
  if (q(mount, 'invoice-apply-all-positions')) await click(mount, 'invoice-apply-all-positions');
  await fillServicePeriod(mount);
  if (q(mount, 'invoice-continue-preview')) await click(mount, 'invoice-continue-preview');
}

function unmount(mount: Mount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
}

let start: ReturnType<typeof vi.spyOn>;
let stamm: Customer;

beforeEach(async () => {
  vi.restoreAllMocks();
  disableInvoiceDraftCloudSyncForTests();
  localStorage.clear();
  await resetInvoiceDraftDurabilityDatabaseForTests();
  scopeService.setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  hydrateCompanyProfileStore({ ...PROFILE });
  hydrateCustomerStore([]);
  const created = createCustomer(
    { name: 'Kunde Drift GmbH', contactPerson: '', street: 'Alte Straße 1', zip: '10115', city: 'Berlin', email: '', phone: '' },
    { allowDuplicate: true },
  );
  if (!created.success) throw new Error(created.errorKey);
  stamm = created.customer;
  hydrateVorgangStore([
    createTestVorgangWithExecutedQuantity({
      id: VORGANG,
      invoices: [],
      customerId: stamm.id,
      customer: stamm.name,
      customerBilling: billingFromCustomer(stamm),
    }),
  ]);
  vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
  start = vi
    .spyOn(coordinator, 'startInvoiceDraftFinalization')
    .mockResolvedValue({ ok: false, reason: 'offline_or_unconfigured', recovery: 'retry_allowed', cloudState: 'not_committed' } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('KUN-08 — Rückfrage zu geänderten Kundendaten', () => {
  it('D1: ohne Änderung des Kundenstamms gibt es kein zusätzliches Gate', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    await click(mount, 'invoice-approve');
    expect(q(mount, 'invoice-customer-drift-confirm'), 'unerwartete Rückfrage').toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    unmount(mount);
  }, 30_000);

  it('D2: eine geänderte Anschrift öffnet die Rückfrage statt der Freigabe', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    expect(updateCustomer(stamm.id, { street: 'Neue Straße 9' }).success).toBe(true);
    await click(mount, 'invoice-approve');
    const karte = q(mount, 'invoice-customer-drift-fields');
    expect(karte, 'Rückfrage fehlt').not.toBeNull();
    expect(karte?.textContent).toContain('Alte Straße 1');
    expect(karte?.textContent).toContain('Neue Straße 9');
    expect(start).not.toHaveBeenCalled();
    unmount(mount);
  }, 30_000);

  it('D3: „Angaben dieser Rechnung behalten" gibt frei und lässt den Entwurf', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    updateCustomer(stamm.id, { street: 'Neue Straße 9' });
    await click(mount, 'invoice-approve');
    await click(mount, 'invoice-customer-drift-keep');
    expect(q(mount, 'invoice-customer-drift-confirm')).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(mount.container.textContent).toContain('Alte Straße 1');
    unmount(mount);
  }, 30_000);

  it('D4: „Aktuelle Kundendaten übernehmen" schreibt den Stamm und gibt frei', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    updateCustomer(stamm.id, { street: 'Neue Straße 9' });
    await click(mount, 'invoice-approve');
    await click(mount, 'invoice-customer-drift-apply');
    expect(q(mount, 'invoice-customer-drift-confirm')).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(mount.container.textContent).toContain('Neue Straße 9');
    unmount(mount);
  }, 30_000);

  it('D5: „Aus Kundenstamm übernehmen" entfernt ein im Stamm gelöschtes Feld (KUN-04)', async () => {
    // Der Auftrag trägt noch eine USt-IdNr., die im Kundenstamm inzwischen gelöscht ist.
    hydrateVorgangStore([
      createTestVorgangWithExecutedQuantity({
        id: VORGANG,
        invoices: [],
        customerId: stamm.id,
        customer: stamm.name,
        customerBilling: { ...billingFromCustomer(stamm), vatId: 'DE999999999' },
      }),
    ]);
    const mount = await renderPage();
    await gotoPreview(mount);
    await click(mount, 'invoice-edit');
    // Nicht „bereits aktuell": die Abweichung liegt in einem optionalen Feld.
    expect(q(mount, 'invoice-customer-master-identical')).toBeNull();
    await click(mount, 'invoice-customer-master-action');
    await click(mount, 'invoice-customer-master-apply');
    expect(q(mount, 'invoice-customer-master-identical'), 'nach der Übernahme aktuell').not.toBeNull();
    unmount(mount);
  }, 30_000);
});
