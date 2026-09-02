/**
 * MOBILE-RESUME-STATE-01B — der Rechnungsschritt überlebt einen Neuaufbau.
 *
 * Belegter Realbefund auf iPhone/Safari: Wer in der Rechnungsvorschau steht,
 * zu einer anderen App wechselt und zurückkommt, landet wieder bei den
 * Positionen. Das Betriebssystem verwirft den Tab; der Entwurf überlebt in
 * IndexedDB, der Schritt lag ausschliesslich in `useState`.
 *
 * Der Schritt steht jetzt als Suchparameter in der Adresse. Er ist dabei
 * **niemals eine Berechtigung**: Eine §13b-Rechnung ohne erneute Bestätigung
 * und ein ungeklärter Steuerstatus führen weiterhin nicht in die Vorschau.
 *
 * Synthetische Daten, kein Netz, keine Finalisierung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { RechnungPage } from './RechnungPage';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { resetInvoiceNumberSequence } from '../services/invoiceNumberService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { resetInvoiceDraftDurabilityDatabaseForTests } from '../services/invoice/invoiceDraftDurabilityService';
import * as workspaceSyncPayloadService from '../services/workspace/workspaceSyncPayloadService';
import type { TaxStatus } from '../types/models';

const WORKSPACE_ID = 'ws-resume-step-01b';

const company = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Resume GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
};

function setupWith(taxStatus: TaxStatus) {
  return { ...DEFAULT_SETUP, setupComplete: true, taxStatus };
}

let root: Root;
let host: HTMLDivElement;
/** Der zuletzt gerenderte Suchstring — so sieht der Test die Adresse. */
let currentSearch = '';

function SearchProbe() {
  currentSearch = useLocation().search;
  return null;
}

beforeEach(async () => {
  resetInvoiceNumberSequence();
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore(company);
  hydrateVorgangStore([createTestVorgang()]);
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID });
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE_ID);
  await resetInvoiceDraftDurabilityDatabaseForTests();
  currentSearch = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * Rendert die Rechnungsanlage unter einer konkreten Adresse und wartet, bis der
 * Entwurf aus IndexedDB steht. Die Adresse wird über einen kleinen Beobachter
 * mitgelesen, damit der Test die Normalisierung prüfen kann.
 */
async function renderAt(search: string, taxStatus: TaxStatus): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/v-test-1/rechnung${search}`]}>
        <AppProvider initialSetup={setupWith(taxStatus)}>
          <Routes>
            <Route
              path="/vorgaenge/:id/rechnung"
              element={
                <>
                  <RechnungPage />
                  <SearchProbe />
                </>
              }
            />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (host.querySelector('[data-testid="rechnung-page"]')) break;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
  // Die Wiederaufnahme läuft nach der Hydration; ihr Ergebnis braucht Renderzeit.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

function previewVisible(): boolean {
  return find('invoice-document-number') !== null;
}

function positionsVisible(): boolean {
  return find('invoice-continue-preview') !== null;
}

function editVisible(): boolean {
  return find('invoice-back-preview') !== null;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

describe('MOBILE-RESUME-STATE-01B — Wiederaufnahme aus der Adresse', () => {
  // 1
  it('R1: step=preview wird nach der Hydration wiederhergestellt', async () => {
    await renderAt('?type=rechnung&step=preview', 'standard_19');
    expect(previewVisible()).toBe(true);
    expect(positionsVisible()).toBe(false);
  });

  // 2
  it('R2: step=edit wird wiederhergestellt', async () => {
    await renderAt('?type=rechnung&step=edit', 'standard_19');
    expect(editVisible()).toBe(true);
    expect(previewVisible()).toBe(false);
  });

  // 3
  it('R3: ohne step beginnt der Ablauf bei den Positionen', async () => {
    await renderAt('?type=rechnung', 'standard_19');
    expect(positionsVisible()).toBe(true);
    expect(previewVisible()).toBe(false);
  });

  // 4
  it('R4: ein ungültiger step fällt auf positions zurück und wird normalisiert', async () => {
    await renderAt('?type=rechnung&step=freigabe', 'standard_19');
    expect(positionsVisible()).toBe(true);
    expect(currentSearch).toContain('step=positions');
    expect(currentSearch).not.toContain('freigabe');
  });

  /*
   * 5 — der Kern der Sicherheitsregel.
   *
   * `reverseCharge13bConfirmed` ist bewusst flüchtig. Nach einem Neuaufbau ist
   * die Bestätigung offen, und dann darf keine Adresse eine bestätigte
   * §13b-Vorschau herbeiführen.
   */
  it('R5: §13b ohne Bestätigung erreicht trotz step=preview keine Vorschau', async () => {
    await renderAt('?type=rechnung&step=preview', 'reverse_charge_13b');

    expect(previewVisible()).toBe(false);
    expect(positionsVisible()).toBe(true);
    expect(currentSearch).toContain('step=positions');
    // Die Bestätigung muss erneut erfolgen.
    const box = find('invoice-13b-confirm-checkbox') as HTMLInputElement | null;
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
    expect((find('invoice-continue-preview') as HTMLButtonElement).disabled).toBe(true);
  });

  // 6
  it('R6: unclear erreicht trotz step=preview keine Vorschau', async () => {
    await renderAt('?type=rechnung&step=preview', 'unclear');
    expect(previewVisible()).toBe(false);
    expect(positionsVisible()).toBe(true);
    expect(currentSearch).toContain('step=positions');
  });

  // 7
  it('R7: der Wechsel zur Vorschau schreibt step und erhält type', async () => {
    await renderAt('?type=rechnung', 'standard_19');
    await click(find('invoice-continue-preview')!);

    expect(previewVisible()).toBe(true);
    expect(currentSearch).toContain('step=preview');
    expect(currentSearch).toContain('type=rechnung');
  });

  // 8
  it('R8: der Rückweg zu den Positionen schreibt step=positions', async () => {
    await renderAt('?type=rechnung&step=preview', 'standard_19');
    await click(find('invoice-back-positions')!);

    expect(positionsVisible()).toBe(true);
    expect(currentSearch).toContain('step=positions');
    expect(currentSearch).toContain('type=rechnung');
  });

  /*
   * 11 — der Realbefund in Testform.
   *
   * Eine neue Komponenteninstanz auf derselben Adresse ist genau das, was nach
   * einem verworfenen Safari-Tab geschieht: Der Entwurf kommt aus IndexedDB,
   * der React-Zustand ist neu.
   */
  it('R11: ein Neuaufbau derselben Rechnung landet wieder in der Vorschau', async () => {
    await renderAt('?type=rechnung', 'standard_19');
    await click(find('invoice-continue-preview')!);
    expect(previewVisible()).toBe(true);
    const searchAfterStep = currentSearch;

    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await renderAt(`?${searchAfterStep.replace(/^\?/, '')}`, 'standard_19');
    expect(previewVisible()).toBe(true);
  });

  // 9
  it('R9: ein echter Wechsel der Rechnungsart übernimmt den alten Schritt nicht', async () => {
    await renderAt('?type=rechnung&step=preview', 'standard_19');
    expect(previewVisible()).toBe(true);

    /*
     * Die Auswahl der Rechnungsart steht nur im Positionsschritt. Der Weg
     * dorthin ist deshalb Teil des Falls — und er hinterlässt `step=positions`
     * in der Adresse, was den Wechsel erst aussagekräftig macht.
     */
    await click(find('invoice-back-positions')!);
    expect(currentSearch).toContain('step=positions');

    const abschlag = find('invoice-type-abschlag') as HTMLButtonElement | null;
    expect(abschlag, 'Auswahl der Rechnungsart nicht gefunden').not.toBeNull();
    await click(abschlag!);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }

    expect(currentSearch).toContain('type=abschlag');
    expect(previewVisible()).toBe(false);
    expect(positionsVisible()).toBe(true);
    expect(currentSearch).not.toContain('step=preview');
  });
});
