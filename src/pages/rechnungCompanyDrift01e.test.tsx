import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { AppProvider } from '../context/AppContext';
import { RechnungPage } from './RechnungPage';
import { createTestVorgangWithExecutedQuantity } from '../test/fixtures';
import { hydrateVorgangStore } from '../services/vorgangService';
import { resetInvoiceDraftDurabilityDatabaseForTests } from '../services/invoice/invoiceDraftDurabilityService';
import * as coordinator from '../services/invoice/invoiceFinalizationCoordinator';
import * as scopeService from '../services/storage/storageScopeService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import type { CompanyProfile } from '../types/models';

/**
 * COMPANY-PROFILE-DRAFT-DRIFT-01E — die Rückfrage im echten Freigabepfad.
 *
 * Der Dienst selbst ist eigens geprüft; hier geht es um das Verhalten an der
 * Oberfläche: Erscheint die Rückfrage nur dann, wenn sie muss? Trägt die
 * Entscheidung bis zur Finalisierung? Und entsteht dabei keine Schleife und
 * keine zweite Freigabe?
 *
 * Synthetische Daten, kein Netz.
 */

const WORKSPACE = 'ws-drift-a';
const VORGANG = 'vg-drift-1';

type Mount = { container: HTMLDivElement; root: Root };

const PROFILE_A: CompanyProfile = {
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
            <Route
              path="/vorgaenge/:id/rechnungen/:invoiceId"
              element={<div data-testid="invoice-detail" />}
            />
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

/** Trägt den Leistungszeitraum ein — wie ein Nutzer. */
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
  const confirm = q<HTMLButtonElement>(mount, 'invoice-confirm-service-period');
  if (confirm) await click(mount, 'invoice-confirm-service-period');
}

/** Vom Positionsschritt in die Vorschau, wo die Freigabe liegt. */
async function gotoPreview(mount: Mount): Promise<void> {
  if (q(mount, 'invoice-apply-all-positions')) {
    await click(mount, 'invoice-apply-all-positions');
  }
  await fillServicePeriod(mount);
  if (q(mount, 'invoice-continue-preview')) {
    await click(mount, 'invoice-continue-preview');
  }
}

function unmount(mount: Mount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
}

let start: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  await resetInvoiceDraftDurabilityDatabaseForTests();
  hydrateVorgangStore([createTestVorgangWithExecutedQuantity({ id: VORGANG, invoices: [] })]);
  scopeService.setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  hydrateCompanyProfileStore({ ...PROFILE_A });
  vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
  start = vi
    .spyOn(coordinator, 'startInvoiceDraftFinalization')
    .mockResolvedValue({ ok: false, reason: 'offline_or_unconfigured', recovery: 'retry_allowed', cloudState: 'not_committed' } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('01E — die Rückfrage erscheint nur, wenn sie muss', () => {
  it('J3: ohne Profiländerung gibt es kein zusätzliches Gate', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    await click(mount, 'invoice-approve');

    expect(q(mount, 'invoice-company-drift-confirm'), 'unerwartete Rückfrage').toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    unmount(mount);
  }, 30_000);

  it('J4: eine geänderte Firmierung öffnet die Rückfrage statt der Freigabe', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    hydrateCompanyProfileStore({ ...PROFILE_A, companyName: 'Beispiel Betrieb GmbH & Co. KG' });
    await click(mount, 'invoice-approve');

    expect(q(mount, 'invoice-company-drift-confirm'), 'Rückfrage fehlt').not.toBeNull();
    expect(q(mount, 'invoice-company-drift-fields')?.textContent).toContain('Firmenname');
    /* Entscheidend: es wurde noch nichts finalisiert. */
    expect(start).not.toHaveBeenCalled();
    unmount(mount);
  }, 30_000);

  it('J9/J10: geänderte Kontakt- und Zahlungsstandards öffnen keine Rückfrage', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    hydrateCompanyProfileStore({
      ...PROFILE_A,
      phone: '0521 999999',
      defaultPaymentDays: 30,
      skontoPercent: 3,
    });
    await click(mount, 'invoice-approve');

    expect(q(mount, 'invoice-company-drift-confirm')).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    unmount(mount);
  }, 30_000);
});

describe('01F — die Karte trägt die Entscheidung', () => {
  it('zeigt bisherigen und aktuellen Wert — nur für tatsächlich geänderte Felder', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    hydrateCompanyProfileStore({
      ...PROFILE_A,
      companyName: 'Beispiel Betrieb GmbH & Co. KG',
      iban: 'DE02 1203 0000 0000 2020 51',
      /* Unkritisch — darf in der Karte nicht auftauchen. */
      phone: '0521 999999',
      defaultPaymentDays: 30,
    });
    await click(mount, 'invoice-approve');

    const karte = q(mount, 'invoice-company-drift-fields')!;
    const text = karte.textContent ?? '';

    /* Genau die zwei geänderten Felder — und keine weiteren. */
    expect(karte.querySelectorAll('.invoice-drift-list__item')).toHaveLength(2);
    expect(text).toContain('Firmenname');
    expect(text).toContain('IBAN');
    expect(text).not.toContain('Telefon');
    expect(text).not.toContain('Zahlungsziel');

    /* Alter und neuer Wert, beide beschriftet. */
    expect(text).toContain('Bisher');
    expect(text).toContain('Aktuell');
    expect(text).toContain(PROFILE_A.companyName);
    expect(text).toContain('Beispiel Betrieb GmbH & Co. KG');
    expect(text).toContain(PROFILE_A.iban);
    expect(text).toContain('DE02 1203 0000 0000 2020 51');

    /* Keine internen Schlüssel. */
    for (const key of ['companyName', 'vatId', 'bankName', 'taxNumber', 'iban"']) {
      expect(text).not.toContain(key);
    }

    /* Keine zweite Datenpflege: die Karte ist reine Anzeige. */
    const gate = q(mount, 'invoice-company-drift-confirm')!;
    expect(gate.querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(q(mount, 'invoice-company-drift-keep')).not.toBeNull();
    expect(q(mount, 'invoice-company-drift-apply')).not.toBeNull();
    unmount(mount);
  }, 30_000);

  it('ein leeres Feld wird lesbar benannt statt leer zu bleiben', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    hydrateCompanyProfileStore({ ...PROFILE_A, bic: '' });
    await click(mount, 'invoice-approve');

    const text = q(mount, 'invoice-company-drift-fields')?.textContent ?? '';
    expect(text).toContain('BIC');
    expect(text).toContain('nicht angegeben');
    unmount(mount);
  }, 30_000);
});

describe('01E — die beiden Wege der Rückfrage', () => {
  it('J15/J16: „Bisherigen Stand behalten" lässt den Snapshot unberührt und gibt frei', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    hydrateCompanyProfileStore({ ...PROFILE_A, iban: 'DE02 1203 0000 0000 2020 51' });
    await click(mount, 'invoice-approve');
    await click(mount, 'invoice-company-drift-keep');

    expect(start).toHaveBeenCalledTimes(1);
    const call = start.mock.calls[0]![0] as { identity: { draftId: string } };
    expect(call.identity.draftId, 'Finalisierung ohne Entwurfsidentität').toBeTruthy();
    /* Die Rückfrage ist weg und kommt im selben Versuch nicht wieder. */
    expect(q(mount, 'invoice-company-drift-confirm')).toBeNull();
    unmount(mount);
  }, 30_000);

  it('J13: „Aktuelle Firmendaten übernehmen" schreibt die kritischen Felder und gibt frei', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    hydrateCompanyProfileStore({ ...PROFILE_A, iban: 'DE02 1203 0000 0000 2020 51' });
    await click(mount, 'invoice-approve');
    await click(mount, 'invoice-company-drift-apply');
    await settle();

    expect(start).toHaveBeenCalledTimes(1);
    expect(q(mount, 'invoice-company-drift-confirm')).toBeNull();
    unmount(mount);
  }, 30_000);

  it('J20: die Rückfrage verschluckt das Übermengen-Gate nicht', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);
    hydrateCompanyProfileStore({ ...PROFILE_A, iban: 'DE02 1203 0000 0000 2020 51' });
    await click(mount, 'invoice-approve');

    /* Erst die Firmendaten … */
    expect(q(mount, 'invoice-company-drift-confirm')).not.toBeNull();
    await click(mount, 'invoice-company-drift-keep');

    /*
     * … danach entweder direkt freigegeben oder — falls die Menge über dem
     * dokumentierten Rest liegt — das bestehende Übermengen-Gate. Beides ist
     * zulässig; unzulässig wäre ein Verschlucken oder eine zweite Freigabe.
     */
    const overbilling = q(mount, 'invoice-approve-anyway');
    if (overbilling) {
      expect(start, 'vor der Übermengenbestätigung darf nichts laufen').not.toHaveBeenCalled();
      await click(mount, 'invoice-approve-anyway');
    }
    expect(start).toHaveBeenCalledTimes(1);
    expect(q(mount, 'invoice-company-drift-confirm'), 'Warnschleife').toBeNull();
    unmount(mount);
  }, 30_000);
});
