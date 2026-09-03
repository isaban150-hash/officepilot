/**
 * SKONTO-INVOICE-TEXT-01B — Firmenstandard, Vertragsskonto und Handeingabe.
 *
 * Der Firmenstandard belegt den neuen Entwurf vor. Ein erkanntes Vertragsskonto
 * darf ihn ersetzen — und eine Ablehnung des Angebots muss auf den
 * Firmenstandard zurückfallen, **nicht** auf den Leerstring. Bis zu diesem
 * Block setzte die Auswahl „Nein" den Text hart auf leer und löschte dabei auch
 * jede Handeingabe.
 *
 * Der Rückfallwert stammt aus `draft.companySnapshot`, also aus dem beim Aufbau
 * eingefrorenen Profil. Eine spätere Änderung der Firmendaten verschiebt ihn
 * deshalb nicht.
 *
 * Synthetische Daten, kein Netz, keine Finalisierung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { RechnungPage } from './RechnungPage';
import { createAuftragInboxItem } from '../test/fixtures';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
} from '../test/werkvertragMultiSectionFixtures';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateInboxStore } from '../services/inboxService';
import { getVorgangById, hydrateVorgangStore } from '../services/vorgangService';
import { getContractSkontoOfferForVorgang } from '../services/contractIntelligenceService';
import { confirmImportSafeContractPositions } from '../services/contractPositionImportService';
import {
  createVorgangFromInboxWithContract,
  getContractPreviewForInbox,
} from '../services/intakeWorkflowService';
import { resetInvoiceNumberSequence } from '../services/invoiceNumberService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { resetInvoiceDraftDurabilityDatabaseForTests } from '../services/invoice/invoiceDraftDurabilityService';
import * as workspaceSyncPayloadService from '../services/workspace/workspaceSyncPayloadService';
import type { InboxItem } from '../types/models';

const WORKSPACE_ID = 'ws-skonto-contract-01b';
/** Der Firmenstandard dieses Betriebs. */
const COMPANY_SKONTO = 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';

const company = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Skonto GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
  skontoEnabled: true,
  skontoPercent: 2,
  skontoDays: 10,
};

function syntheticWerkvertragItem(): InboxItem {
  return {
    ...createAuftragInboxItem(),
    id: 'inbox-skonto-werkvertrag',
    title: 'Werkvertrag BV Test',
    sender: 'Isobautec GmbH',
    recognizedData: {
      Kunde: 'Isobautec GmbH',
      Baustelle: 'BV Sägewerk Fisch',
      _vertragstext: buildSyntheticWerkvertragText(),
      _pageTexts: JSON.stringify(buildSyntheticWerkvertragPages()),
    },
  } as InboxItem;
}

let root: Root;
let host: HTMLDivElement;
let vorgangId = '';
let contractText = '';

beforeEach(async () => {
  resetInvoiceNumberSequence();
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateCompanyProfileStore(company);

  const item = syntheticWerkvertragItem();
  hydrateInboxStore([item]);
  const preview = getContractPreviewForInbox(item);
  const created = createVorgangFromInboxWithContract(item);
  expect(created, 'Vorgang aus Vertrag konnte nicht erzeugt werden').not.toBeNull();
  confirmImportSafeContractPositions(created!.vorgang.id, preview.positions);
  vorgangId = created!.vorgang.id;

  const vorgang = getVorgangById(vorgangId)!;
  vorgang.createdFromInboxId = item.id;
  const offer = getContractSkontoOfferForVorgang(vorgang);
  expect(offer, 'Der Vertrag bietet kein Skonto an').not.toBeNull();
  contractText = offer!.text;
  // Vertrags- und Firmenwert müssen sich unterscheiden, sonst prüft der Test nichts.
  expect(contractText).not.toBe(COMPANY_SKONTO);

  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID });
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE_ID);
  await resetInvoiceDraftDurabilityDatabaseForTests();

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

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/${vorgangId}/rechnung?type=rechnung`]}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
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
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

/** Der Skontotext, wie ihn die Vorschau tatsächlich zeigt. */
async function skontoInPreview(): Promise<string> {
  await click(find('invoice-continue-preview')!);
  const block = host.querySelector('.invoice-payment-block, [data-testid="invoice-document"]');
  return (block?.textContent ?? host.textContent ?? '').replace(/\s+/g, ' ');
}

describe('SKONTO-INVOICE-TEXT-01B — Vertragsskonto und Firmenstandard', () => {
  // R10 — angenommen: der Vertrag gewinnt.
  it('R10: angenommenes Vertragsskonto ersetzt den Firmenstandard', async () => {
    await renderPage();
    expect(find('invoice-skonto-choice'), 'Vertragsangebot nicht sichtbar').not.toBeNull();

    await click(find('invoice-skonto-yes')!);
    const preview = await skontoInPreview();
    expect(preview).toContain(contractText.replace(/\s+/g, ' '));
    expect(preview).not.toContain(COMPANY_SKONTO);
  });

  /*
   * R11 — abgelehnt: der Firmenstandard bleibt.
   *
   * Bis 01B ergab die Ablehnung einen leeren Skontotext. Der Betrieb verlor
   * damit seinen eingerichteten Hausstandard, nur weil ein Vertrag ein anderes
   * Skonto anbot.
   */
  it('R11: abgelehntes Vertragsskonto fällt auf den Firmenstandard zurück', async () => {
    await renderPage();
    await click(find('invoice-skonto-yes')!);
    await click(find('invoice-skonto-no')!);

    const preview = await skontoInPreview();
    expect(preview).toContain(COMPANY_SKONTO);
    expect(preview).not.toContain(contractText.replace(/\s+/g, ' '));
  });

  // Ohne jede Auswahl gilt von vornherein der Firmenstandard.
  it('R11b: ohne Auswahl steht der Firmenstandard im Entwurf', async () => {
    await renderPage();
    const preview = await skontoInPreview();
    expect(preview).toContain(COMPANY_SKONTO);
  });

  /*
   * R12 — eine Handeingabe überlebt.
   *
   * Der Effekt der Vertragsauswahl schreibt nur noch beim Umschalten. Vorher
   * lief er bei jeder Entwurfsänderung und löschte den Text.
   */
  it('R12: ein von Hand geänderter Skontotext wird nicht überschrieben', async () => {
    await renderPage();
    await click(find('invoice-continue-preview')!);
    await click(find('invoice-edit')!);

    const field = Array.from(host.querySelectorAll('input, textarea')).find(
      (element) => (element as HTMLInputElement).value === COMPANY_SKONTO,
    ) as HTMLInputElement | undefined;
    expect(field, 'Skontofeld im Bearbeitungsformular nicht gefunden').not.toBeUndefined();

    const manual = 'Zahlbar ohne Abzug — Skonto nach Absprache.';
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        field! instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(field!, manual);
      field!.dispatchEvent(new Event('input', { bubbles: true }));
      field!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }

    await click(find('invoice-back-preview')!);
    const preview = (host.textContent ?? '').replace(/\s+/g, ' ');
    expect(preview).toContain(manual);
    expect(preview).not.toContain(COMPANY_SKONTO);
  });
});
