/**
 * FINANZ-CORE-01A (ANG-10) — „Als neuen Kunden anlegen" im Angebotseditor.
 *
 * Bisher führte ein Link auf die Kundenliste: voller Seitenwechsel, Eingaben weg, und ein
 * Freitext-Kunde blieb ohne Kundenstamm. Jetzt entsteht der Kunde aus genau den Eingaben, ohne
 * die Seite zu verlassen.
 *
 *  K10a  der Kunde entsteht aus den Eingaben, der Editor verweist auf ihn, nichts geht verloren
 *  K10b  ein wahrscheinlicher Doppelkunde wird nicht angelegt, sondern genannt
 *  K10c  eine ungültige E-Mail wird mit verständlicher Meldung abgewiesen (KUN-09)
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../context/AppContext';
import { createCompanyProfileFromSetup } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { t } from '../i18n';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../services/companyProfileService';
import { createCustomer } from '../services/customerService';
import { getCustomerStoreSnapshot, hydrateCustomerStore } from '../services/customerStoreService';
import { resetOffers } from '../services/offer/offerService';
import { resetSyncChangeTrackerForTests } from '../services/sync/syncChangeTrackerService';
import { resetSyncClientForTests } from '../services/sync/syncClientService';
import { hydrateSyncOutbox } from '../services/sync/syncOutboxService';
import { hydrateWorkspaceStore, resetWorkspaceStore } from '../services/workspace/workspaceStore';
import { alsInhaber } from '../test/workspaceRoleTestUtils';
import { AngebotEditorPage } from './AngebotEditorPage';

const WORKSPACE = '2e49b0a1-dbee-4649-aa4e-68064d52c8f5';

let container: HTMLDivElement;
let root: Root | null = null;

const el = (id: string) => container.querySelector(`[data-testid="${id}"]`);

function tippe(id: string, text: string): void {
  const input = el(id) as HTMLInputElement;
  expect(input, id).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function zeigeEditor(): void {
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/angebote/neu'] },
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
          createElement(Routes, null, createElement(Route, { path: '/angebote/neu', element: createElement(AngebotEditorPage) })),
        ),
      ),
    );
  });
}

function fuelleKunde(name: string, email = 'neu@example.invalid'): void {
  tippe('offer-customer-name', name);
  tippe('offer-customer-street', 'Neuer Weg 7');
  tippe('offer-customer-zip', '44135');
  tippe('offer-customer-city', 'Dortmund');
  tippe('offer-customer-email', email);
}

function klickeAnlegen(): void {
  const knopf = el('offer-customer-new') as HTMLButtonElement | null;
  expect(knopf, 'Knopf „Als neuen Kunden anlegen" fehlt').not.toBeNull();
  act(() => knopf!.click());
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetOffers();
  resetCompanyProfile();
  resetSyncChangeTrackerForTests();
  hydrateSyncOutbox([]);
  hydrateCustomerStore([]);
  resetWorkspaceStore();
  hydrateWorkspaceStore({ workspace: { id: WORKSPACE, name: 'Test', ownerUserId: 'user-1' } as never });
  resetSyncClientForTests({
    deviceId: 'device-test',
    workspaceId: WORKSPACE,
    serverWorkspaceId: WORKSPACE,
    createdAt: '2026-09-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
  hydrateCompanyProfileStore({
    ...createCompanyProfileFromSetup(DEFAULT_SETUP),
    companyName: 'Beispiel Haustechnik GmbH',
    street: 'Musterstrasse 5',
    zip: '33602',
    city: 'Bielefeld',
  });
  alsInhaber();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

describe('ANG-10 — neuer Kunde aus dem Angebotseditor', () => {
  it('K10a: der Kunde entsteht aus den Eingaben, der Editor verweist auf ihn', () => {
    zeigeEditor();
    fuelleKunde('Neubau Ost GmbH');
    klickeAnlegen();

    const kunde = getCustomerStoreSnapshot().find((c) => c.name === 'Neubau Ost GmbH');
    expect(kunde, 'Kunde nicht angelegt').toBeTruthy();
    expect(kunde).toMatchObject({ street: 'Neuer Weg 7', zip: '44135', city: 'Dortmund', email: 'neu@example.invalid' });
    expect((el('offer-customer') as HTMLSelectElement).value).toBe(kunde!.id);
    // Die Eingaben bleiben stehen; kein Seitenwechsel.
    expect((el('offer-customer-name') as HTMLInputElement).value).toBe('Neubau Ost GmbH');
    expect(el('offer-editor-error')).toBeNull();
  });

  it('K10b: ein wahrscheinlicher Doppelkunde wird genannt, nicht angelegt', () => {
    const vorhanden = createCustomer(
      { name: 'Neubau Ost GmbH', contactPerson: '', street: 'Neuer Weg 7', zip: '44135', city: 'Dortmund', email: 'neu@example.invalid', phone: '' },
      { allowDuplicate: true },
    );
    expect(vorhanden.success).toBe(true);
    zeigeEditor();
    fuelleKunde('Neubau Ost GmbH');
    klickeAnlegen();
    expect(getCustomerStoreSnapshot().filter((c) => c.name === 'Neubau Ost GmbH')).toHaveLength(1);
    expect(el('offer-editor-error')?.textContent).toContain('Neubau Ost GmbH');
  });

  it('K10c: eine ungültige E-Mail wird verständlich abgewiesen', () => {
    zeigeEditor();
    fuelleKunde('Format Test GmbH', 'kaputt@');
    klickeAnlegen();
    expect(getCustomerStoreSnapshot().some((c) => c.name === 'Format Test GmbH')).toBe(false);
    expect(el('offer-editor-error')?.textContent).toBe(t('customer.validation.email', 'de'));
  });
});
