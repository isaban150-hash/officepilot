/**
 * INVOICE-WIZARD-FULL-SAFE-RESUME-01B — die komplette sichere Rechnungsseite
 * überlebt einen Safari-Neuaufbau.
 *
 * Realbefund auf iPhone/Safari: Mitten in der Rechnung kurz zu einer anderen
 * App wechseln, zurückkommen, Safari baut die Seite neu auf — die Route bleibt,
 * aber Auswahlzustände fallen auf ihre Ausgangswerte zurück. Schlimmer noch:
 * `applyContractSkonto` startet wieder mit `false`, und der Effekt deutet das
 * als frische Ablehnung und **überschreibt den gespeicherten Skontotext** mit
 * dem Firmenstandard.
 *
 * Dieser Test bereitet nichts vor. Kein `captureAndPersistUiSession`, kein
 * `setPendingUiSessionApply` — der Schnappschuss muss durch den echten
 * `pagehide` des produktiven Trackers entstehen, und die Wiederaufnahme läuft
 * über den produktiven `UiSessionRecoveryHost`.
 *
 * Simuliert wird ausschliesslich das, was ein Test nicht haben kann: der
 * Prozesswechsel selbst. Statt eines echten Browser-Neustarts wird der Baum
 * abgebaut, ein neuer Wurzelknoten erzeugt und dieselbe Route neu gemountet —
 * derselbe Entwurf in IndexedDB, derselbe Schnappschuss im sessionStorage.
 *
 * Synthetische Daten, kein Netz, keine Finalisierung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { UiSessionRecoveryHost } from '../components/system/UiSessionRecoveryHost';
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
import {
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from '../services/invoice/invoiceDraftDurabilityService';
import * as workspaceSyncPayloadService from '../services/workspace/workspaceSyncPayloadService';
import type { InboxItem, InvoiceDraft } from '../types/models';

const WORKSPACE_ID = 'ws-full-safe-resume-01b';
/** Der Firmenstandard dieses Betriebs — muss sich vom Vertragstext unterscheiden. */
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
  skontoEnabled: true,
  skontoPercent: 3,
  skontoDays: 30,
};

function syntheticWerkvertragItem(): InboxItem {
  return {
    ...createAuftragInboxItem(),
    id: 'inbox-full-safe-resume',
    title: 'Werkvertrag BV Resume',
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
let contractDays = 0;
let currentSearch = '';

function SearchProbe() {
  currentSearch = useLocation().search;
  return null;
}

beforeEach(async () => {
  sessionStorage.clear();
  localStorage.clear();
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
  contractDays = offer!.days;

  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID });
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE_ID);
  await resetInvoiceDraftDurabilityDatabaseForTests();

  currentSearch = '';
  host = createHost();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.restoreAllMocks();
});

/** Der Hauptbereich trägt die Scrollposition — dieselbe Klasse wie in der Hülle. */
function createHost(): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'app-shell__main';
  document.body.appendChild(element);
  root = createRoot(element);
  return element;
}

async function settle(rounds = 12): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

/**
 * Die echte Kette: Router, Auth, App, produktiver Wiederaufnahme-Host (der den
 * Tracker mitbringt) und darin die Rechnungsseite.
 */
async function renderApp(search: string): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/${vorgangId}/rechnung${search}`]}>
        <AuthProvider>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
            <UiSessionRecoveryHost />
            <SearchProbe />
            <Routes>
              <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (host.querySelector('[data-testid="rechnung-page"]')) break;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
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
  await settle(10);
}

function setNumber(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function readDraft(): Promise<InvoiceDraft> {
  const result = await loadInvoiceDraftRecordByLocator({
    sourceScopeKey: `workspace:${WORKSPACE_ID}`,
    workspaceId: WORKSPACE_ID,
    vorgangId,
    invoiceType: 'rechnung',
  });
  expect(result.ok, `Kein gespeicherter Entwurf: ${JSON.stringify(result)}`).toBe(true);
  return (result as { ok: true; draft: InvoiceDraft }).draft;
}

/** Der Appwechsel: genau das Ereignis, auf das der produktive Tracker hört. */
async function leaveToOtherApp(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
  });
  await settle(4);
}

/** Safari verwirft den Tab und baut dieselbe Adresse neu auf. */
async function safariRebuild(): Promise<void> {
  const search = currentSearch;
  await act(async () => root.unmount());
  host.remove();
  host = createHost();
  await renderApp(search);
}

function skontoYesActive(): boolean {
  return find('invoice-skonto-yes')?.className.includes('chip--active') ?? false;
}

function skontoNoActive(): boolean {
  return find('invoice-skonto-no')?.className.includes('chip--active') ?? false;
}

describe('INVOICE-WIZARD-FULL-SAFE-RESUME-01B', () => {
  /*
   * R1 — der belegte Realbefund in einem Zug.
   *
   * Mengen, Steuerart und Vertragsskonto setzen, Appwechsel, Neuaufbau: Alles
   * fachlich Sichere muss stehen, und der Skontotext darf beim Mount nicht
   * überschrieben werden.
   */
  it('R1: die komplette sichere Rechnungsseite kommt nach dem Neuaufbau zurück', async () => {
    await renderApp('?type=rechnung');

    const quantity = host.querySelector<HTMLInputElement>('.position-row input.input')!;
    setNumber(quantity, '2');
    await settle(6);
    await click(find('invoice-tax-standard_7')!);
    await click(find('invoice-skonto-yes')!);
    expect(skontoYesActive(), 'Vorbedingung: Vertragsskonto angenommen').toBe(true);
    expect((await readDraft()).skontoText).toBe(contractText);

    await leaveToOtherApp();
    await safariRebuild();

    // A/B — Schritt und Rechnungsart
    expect(find('rechnung-page'), 'Die Rechnungsseite fehlt nach dem Neuaufbau').not.toBeNull();
    expect(find('invoice-type-rechnung')?.className).toContain('chip--active');
    // C/D — Menge und Steuerart aus dem Entwurf
    const draft = await readDraft();
    expect(draft.positions[0]!.quantity).toBe(2);
    expect(draft.taxStatus).toBe('standard_7');
    // I — der Skontotext wurde nicht überschrieben
    expect(draft.skontoText, 'Der Skontotext wurde beim Mount überschrieben').toBe(contractText);
    // H — die Auswahl steht wieder auf Ja
    expect(skontoYesActive(), 'Die Vertragsskonto-Auswahl ging verloren').toBe(true);
  });

  /*
   * R2 — „Nein" ist ebenso eine Entscheidung.
   *
   * Sie darf nach dem Neuaufbau nicht in ein Ja umschlagen, nur weil irgendwo
   * noch ein Vertragstext steht.
   */
  it('R2: eine bewusste Ablehnung bleibt nach dem Neuaufbau eine Ablehnung', async () => {
    await renderApp('?type=rechnung');
    await click(find('invoice-skonto-yes')!);
    await click(find('invoice-skonto-no')!);
    expect(skontoNoActive()).toBe(true);

    await leaveToOtherApp();
    await safariRebuild();

    expect(skontoNoActive(), 'Aus Nein wurde nach dem Neuaufbau ein Ja').toBe(true);
    expect(skontoYesActive()).toBe(false);
  });

  /*
   * R3 — die sensible Bestätigung bleibt flüchtig.
   *
   * Die Steuerart §13b kommt aus dem Entwurf zurück; die ausdrückliche
   * Bestätigung darf das ausdrücklich **nicht**. Ohne sie führt kein Weg in die
   * Vorschau.
   */
  it('R3: §13b kommt zurück, die ausdrückliche Bestätigung nicht', async () => {
    await renderApp('?type=rechnung');
    await click(find('invoice-tax-reverse_charge_13b')!);
    const confirm = find('invoice-13b-confirm-checkbox') as HTMLInputElement | null;
    expect(confirm, 'Die §13b-Bestätigung fehlt').not.toBeNull();
    await act(async () => {
      confirm!.click();
    });
    await settle(6);
    expect(confirm!.checked).toBe(true);

    await leaveToOtherApp();
    await safariRebuild();

    expect((await readDraft()).taxStatus).toBe('reverse_charge_13b');
    const after = find('invoice-13b-confirm-checkbox') as HTMLInputElement | null;
    expect(after, 'Die §13b-Bestätigung wird nicht mehr angeboten').not.toBeNull();
    expect(after!.checked, 'Die §13b-Bestätigung wurde wiederhergestellt').toBe(false);
    expect(find('invoice-preview-hint'), 'Vorschau ohne Bestätigung erreicht').toBeNull();
  });

  /*
   * R4 — der Due-Date-Guard bleibt maßgeblich.
   *
   * Ein gespeichertes „Ja" darf nach dem Neuaufbau nicht blind gelten, wenn das
   * Zahlungsziel inzwischen kürzer ist als die Skontofrist. Und OfficePilot
   * repariert dabei nichts von selbst: Fälligkeit und Text bleiben unangetastet.
   */
  it('R4: ein gespeichertes Ja wird bei zu kurzem Zahlungsziel nicht wiederhergestellt', async () => {
    await renderApp('?type=rechnung');
    await click(find('invoice-skonto-yes')!);
    expect(skontoYesActive()).toBe(true);
    const accepted = await readDraft();
    expect(accepted.skontoText).toBe(contractText);

    // Das Zahlungsziel wird über die echte Oberfläche verkürzt — kürzer als die
    // Vertragsfrist.
    const shortDue = new Date(
      Date.parse(`${accepted.issueDate}T00:00:00Z`) + (contractDays - 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    await click(find('invoice-continue-preview')!);
    await click(find('invoice-edit')!);
    const dueInput = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="date"]')).find(
      (input) => input.value === accepted.paymentDueDate,
    );
    expect(dueInput, 'Kein Feld für das Zahlungsziel gefunden').toBeDefined();
    setNumber(dueInput!, shortDue);
    await settle(8);
    expect((await readDraft()).paymentDueDate).toBe(shortDue);

    await leaveToOtherApp();
    await safariRebuild();
    await goToPositions();

    expect(skontoYesActive(), 'Das Ja wurde trotz zu kurzem Zahlungsziel übernommen').toBe(false);
    const after = await readDraft();
    expect(after.paymentDueDate, 'Das Zahlungsziel wurde still verändert').toBe(shortDue);
    expect(after.skontoText, 'Der vorhandene Skontotext wurde zerstört').toBe(contractText);
  });

  /*
   * R5 — die Scrollposition.
   *
   * Die Maske ist lang; wer an der Steuerentscheidung stand, soll nicht wieder
   * am Seitenanfang landen.
   */
  it('R5: die Scrollposition wird nach dem Neuaufbau wiederhergestellt', async () => {
    await renderApp('?type=rechnung');
    Object.defineProperty(host, 'scrollHeight', { value: 4000, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true });
    host.scrollTop = 900;

    await leaveToOtherApp();
    const search = currentSearch;
    await act(async () => root.unmount());
    host.remove();
    host = createHost();
    Object.defineProperty(host, 'scrollHeight', { value: 4000, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true });
    await renderApp(search);
    await settle(10);

    expect(host.scrollTop, 'Die Seite startet wieder ganz oben').toBeGreaterThan(0);
  });
});

/** Zurück zum Positionsschritt, egal wo der Neuaufbau gelandet ist. */
async function goToPositions(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (find('invoice-skonto-choice')) return;
    const back = find('invoice-back-preview') ?? find('invoice-back-positions');
    if (!back) return;
    await click(back);
  }
}
