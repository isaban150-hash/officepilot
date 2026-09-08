/**
 * INVOICE-SKONTO-PAYMENT-TERMS-CONSISTENCY-01B2 — Vertragsskonto.
 *
 * 01B hat den Widerspruch für das **Firmenskonto** behoben: Der Basissatz wird
 * beim Aufbau des Entwurfs ohne „ohne Abzug" gebildet, sobald ein Skontosatz
 * entsteht.
 *
 * Vertragsskonto entsteht aber **später** — der Nutzer nimmt das Angebot des
 * Werkvertrags erst auf der Rechnungsseite an, und `skontoText` wird dann über
 * `mutateDraft` nachgetragen. Der Basissatz stand zu diesem Zeitpunkt längst.
 *
 * Dieser Test geht bewusst über den **echten** Pfad: Werkvertrag einlesen,
 * Vorgang erzeugen, Rechnungsseite rendern, Angebot annehmen, Vorschau lesen.
 * Kein Nachbau der Vertragslogik.
 *
 * Der Betrieb hier hat **kein** eigenes Skonto — nur der Vertrag bietet eines
 * an. Genau diese Kombination deckte 01B nicht ab.
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

const WORKSPACE_ID = 'ws-skonto-terms-01b2';

const STANDARD_WITH_DEDUCTION = 'Zahlbar innerhalb von 14 Tagen ohne Abzug.';
const STANDARD_PLAIN = 'Zahlbar innerhalb von 14 Tagen.';

/** Dieser Betrieb gewährt selbst kein Skonto — nur der Vertrag bietet eines an. */
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
  defaultPaymentDays: 14,
  defaultPaymentTerms: STANDARD_WITH_DEDUCTION,
  skontoEnabled: false,
  skontoPercent: 0,
  skontoDays: 0,
  defaultSkonto: '',
};

function syntheticWerkvertragItem(): InboxItem {
  return {
    ...createAuftragInboxItem(),
    id: 'inbox-skonto-terms-werkvertrag',
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

async function settle(rounds = 10): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

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
    await settle(1);
  }
  await settle();
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

/** Der Zahlungsblock, wie ihn die Vorschau tatsächlich zeigt. */
async function paymentBlockInPreview(): Promise<string> {
  await click(find('invoice-continue-preview')!);
  const block = host.querySelector('.invoice-payment-block, [data-testid="invoice-document"]');
  return (block?.textContent ?? host.textContent ?? '').replace(/\s+/g, ' ');
}

describe('SKONTO-TERMS-01B2 — Vertragsskonto und Zahlungsbedingungen', () => {
  it('K6: angenommenes Vertragsskonto lässt keinen widersprüchlichen Basissatz stehen', async () => {
    await renderPage();
    expect(find('invoice-skonto-choice'), 'Vertragsangebot nicht sichtbar').not.toBeNull();
    await click(find('invoice-skonto-yes')!);

    const preview = await paymentBlockInPreview();

    // Der Vertragsskontosatz steht da …
    expect(preview).toContain(contractText.replace(/\s+/g, ' '));
    // … und der Basissatz widerspricht ihm nicht mehr.
    expect(preview).not.toContain(STANDARD_WITH_DEDUCTION);
    expect(preview).toContain(STANDARD_PLAIN);
  });

  it('K6b: ohne angenommenes Skonto bleibt „ohne Abzug" stehen', async () => {
    /*
     * Der Betrieb gewährt selbst kein Skonto, und das Vertragsangebot ist nicht
     * angenommen. Dann ist der Beleg abzugsfrei — und darf es auch sagen.
     */
    await renderPage();
    const preview = await paymentBlockInPreview();

    expect(preview).toContain(STANDARD_WITH_DEDUCTION);
    expect(preview).not.toContain(contractText.replace(/\s+/g, ' '));
  });

  it('K6c: ein abgelehntes Vertragsskonto stellt den abzugsfreien Satz wieder her', async () => {
    await renderPage();
    await click(find('invoice-skonto-yes')!);
    await click(find('invoice-skonto-no')!);

    const preview = await paymentBlockInPreview();

    expect(preview).toContain(STANDARD_WITH_DEDUCTION);
    expect(preview).not.toContain(contractText.replace(/\s+/g, ' '));
  });
});
