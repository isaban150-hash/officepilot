/**
 * CUSTOMER-FACHOBJEKT-04C — contract accept requires an explicit CustomerDecision
 * before a new Vorgang is created, and mutates nothing when it is missing.
 * Includes the real UI path (EingangDetailPage → DocumentReviewExperience →
 * ContractOrderProposalPanel) so prop wiring is covered too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import {
  buildContractDecisionResetKey,
  EingangDetailPage,
  resolveSuggestedCustomerName,
} from './pages/EingangDetailPage';
import { isCustomerDecisionIncomplete } from './components/customer/customerDecisionUi';
import { SAMPLE_WERKVERTRAG_TEXT } from './services/contractAnalysisService';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { buildContractOrderProposal } from './services/contractIntelligenceService';
import * as contractOrderAcceptService from './services/contractOrderAcceptService';
import { acceptContractOrderFromProposal } from './services/contractOrderAcceptService';
import { isImportableLvPosition } from './services/contractPositionImportService';
import { createCustomer } from './services/customerService';
import {
  getCustomerStoreSnapshot,
  hydrateCustomerStore,
} from './services/customerStoreService';
import { getDocumentStoreSnapshot, hydrateDocumentStore } from './services/documentService';
import { getInboxItemById, getInboxStoreSnapshot, hydrateInboxStore } from './services/inboxService';
import {
  getAllVorgaenge,
  getVorgangById,
  hydrateVorgangStore,
} from './services/vorgangService';
import { confirmFilingDecisionForTests } from './test/confirmFilingDecisionForTests';
import { createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { ContractOrderProposal, EnhancedDetectedOrderPosition } from './types/documentIntelligence';
import type { CustomerDecision } from './services/customerService';
import type { InboxItem } from './types/models';

const OWN = 'Cirmak Haustechnik GmbH';
const NORDWEST = {
  name: 'NordWest Dachbau GmbH',
  contactPerson: 'Frau Nordmann',
  street: 'Hafenstraße 12',
  zip: '45356',
  city: 'Essen',
  email: 'kontakt@nordwest-dachbau.de',
  phone: '0201 4711',
};

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true, companyName: OWN };

function seedItem(overrides: Partial<InboxItem> = {}): InboxItem {
  const base = createAuftragInboxItem({
    id: 'inbox-04c',
    title: 'Werkvertrag NordWest',
    sender: NORDWEST.name,
    classifiedKind: 'werkvertrag',
    documentType: 'kundenauftrag',
    recognizedData: {
      Kunde: NORDWEST.name,
      Baustelle: 'Hafenstraße 12, Essen',
      Leistung: 'Dachsanierung Nord',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
    },
    ...overrides,
  });
  hydrateInboxStore([base]);
  return getInboxItemById(base.id)!;
}

/** Real proposal from the production builder — no hand-written literal. */
function proposalFor(item: InboxItem): ContractOrderProposal {
  const proposal = buildContractOrderProposal(item);
  if (!proposal) throw new Error('Kein ContractOrderProposal aus der Produktionsfixture');
  return proposal;
}

function importablePositions(proposal: ContractOrderProposal): EnhancedDetectedOrderPosition[] {
  return proposal.positions.filter((position) => isImportableLvPosition(position));
}

function accept(item: InboxItem, customerDecision?: CustomerDecision) {
  const proposal = proposalFor(item);
  return acceptContractOrderFromProposal({
    item,
    proposal,
    selectedPositions: importablePositions(proposal),
    companyName: OWN,
    materialStandard: 'betrieb',
    customerDecision,
  });
}

function storeSnapshot() {
  return {
    inbox: getInboxStoreSnapshot(),
    documents: getDocumentStoreSnapshot(),
    customers: getCustomerStoreSnapshot(),
    vorgaenge: getAllVorgaenge(),
  };
}

type Mount = { container: HTMLDivElement; root: Root };

/** Test-only probe: surfaces the AppProvider toast inside the mounted subtree. */
function ToastProbe() {
  const { toast } = useApp();
  return createElement('div', { 'data-testid': 'toast-probe' }, toast ?? '');
}

function toastText(mount: Mount): string {
  return mount.container.querySelector('[data-testid="toast-probe"]')?.textContent ?? '';
}

async function mountDetailPage(itemId: string): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${itemId}`] },
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(
            'div',
            null,
            createElement(ToastProbe),
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: '/ablage/:id',
                element: createElement(EingangDetailPage),
              }),
            ),
          ),
        ),
      ),
    );
  });
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return { container, root };
}

function unmount(mount: Mount) {
  act(() => mount.root.unmount());
  mount.container.remove();
}

/** Waits for a selector by draining microtasks inside act — no timers. */
async function waitForSelector(mount: Mount, selector: string): Promise<Element> {
  for (let i = 0; i < 200; i += 1) {
    const found = mount.container.querySelector(selector);
    if (found) return found;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error(`waitForSelector: "${selector}" ist nach 200 Microtask-Runden nicht erschienen`);
}

const EXTRA_FIELDS = ['contactPerson', 'street', 'zip', 'city', 'email', 'phone'] as const;

async function typeInto(mount: Mount, testId: string, value: string): Promise<void> {
  const input = mount.container.querySelector(
    `[data-testid="${testId}"]`,
  ) as HTMLInputElement | null;
  if (!input) throw new Error(`missing ${testId}`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function fillExtraFields(mount: Mount): Promise<void> {
  for (const field of EXTRA_FIELDS) {
    await typeInto(mount, `customer-decision-${field}`, NORDWEST[field]);
  }
}

function extraFieldValue(mount: Mount, field: (typeof EXTRA_FIELDS)[number]): string {
  const input = mount.container.querySelector(
    `[data-testid="customer-decision-${field}"]`,
  ) as HTMLInputElement | null;
  if (!input) throw new Error(`missing ${field}`);
  return input.value;
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('element missing');
  await act(async () => {
    (element as HTMLElement).click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('CUSTOMER-FACHOBJEKT-04C', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    localStorage.clear();
  });

  it('Fall A — Neuanlage ohne Decision wird vor jeder Mutation abgelehnt', () => {
    const item = seedItem();
    const before = storeSnapshot();
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    const result = accept(item);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('customerDecision.required');
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(storeSnapshot()).toEqual(before);
    setItemSpy.mockRestore();
  });

  it('Fall B — ungültiger Vorgang-Link wird vor jeder Mutation abgelehnt', () => {
    const item = seedItem({ vorgangId: 'v-gibt-es-nicht', vorgangLinkStatus: 'created' });
    const before = storeSnapshot();
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    const result = accept(item, { kind: 'new', input: { name: NORDWEST.name } });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('documentIntelligence.createOrderFailed');
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(storeSnapshot()).toEqual(before);
    setItemSpy.mockRestore();
  });

  it('Fall B2 — fehlendes Inbox-Item im Store bricht vor jeder Mutation ab', () => {
    const item = seedItem();
    const proposal = proposalFor(item);
    // Item aus dem Store entfernen; das übergebene input.item bleibt gültig.
    hydrateInboxStore([]);
    const before = storeSnapshot();
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    const result = acceptContractOrderFromProposal({
      item,
      proposal,
      selectedPositions: importablePositions(proposal),
      companyName: OWN,
      materialStandard: 'betrieb',
      customerDecision: { kind: 'new', input: { name: NORDWEST.name } },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('documentIntelligence.createOrderFailed');
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(storeSnapshot()).toEqual(before);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getAllVorgaenge()).toHaveLength(0);
    expect(getDocumentStoreSnapshot()).toHaveLength(0);
    setItemSpy.mockRestore();
  });

  it('Fall M — Reset-Schlüssel wechselt bei jeder fachlichen Proposal-Änderung', () => {
    const item = seedItem();
    const proposal = proposalFor(item);
    // Inhaltlich identisches, neu erzeugtes Proposal.
    const rebuilt = proposalFor(getInboxItemById(item.id)!);

    expect(buildContractDecisionResetKey(item.id, rebuilt)).toBe(
      buildContractDecisionResetKey(item.id, proposal),
    );

    // Gleiche Positionsanzahl und gleiche Vertragssumme, geänderter Positionsinhalt.
    const changedPositions: ContractOrderProposal = {
      ...proposal,
      positions: proposal.positions.map((position, index) =>
        index === 0 ? { ...position, description: `${position.description} (geändert)` } : position,
      ),
    };
    expect(changedPositions.positions.length).toBe(proposal.positions.length);
    expect(changedPositions.contractTotalNet).toBe(proposal.contractTotalNet);
    expect(buildContractDecisionResetKey(item.id, changedPositions)).not.toBe(
      buildContractDecisionResetKey(item.id, proposal),
    );

    // Anderes Proposal-Feld bei gleicher Anzahl und Summe.
    const changedField: ContractOrderProposal = { ...proposal, constructionSite: 'Andere Baustelle' };
    expect(buildContractDecisionResetKey(item.id, changedField)).not.toBe(
      buildContractDecisionResetKey(item.id, proposal),
    );

    // Andere Inbox-ID.
    expect(buildContractDecisionResetKey('inbox-anders', proposal)).not.toBe(
      buildContractDecisionResetKey(item.id, proposal),
    );
  });

  it('Fall N — Namensvorschlag überspringt die eigene Firma', () => {
    const externalItem = {
      recognizedData: { Auftraggeber: NORDWEST.name, Kunde: OWN },
      sender: OWN,
    };
    const ownProposal = { customer: OWN } as unknown as ContractOrderProposal;

    // Erster Kandidat ist die eigene Firma → nächster externer Kandidat gewinnt.
    expect(resolveSuggestedCustomerName(externalItem, ownProposal)).toBe(NORDWEST.name);

    // Ausschließlich eigene Firma → leerer Vorschlag, Auswahl bleibt gesperrt.
    const ownOnlyItem = { recognizedData: { Kunde: OWN }, sender: OWN };
    const suggestion = resolveSuggestedCustomerName(ownOnlyItem, ownProposal);
    expect(suggestion).toBe('');
    expect(isCustomerDecisionIncomplete('new', suggestion, null)).toBe(true);
  });

  it('Fall C — new erzeugt genau einen Customer und Vorgang', () => {
    const item = seedItem();
    const result = accept(item, { kind: 'new', input: { name: NORDWEST.name } });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.createdNewVorgang).toBe(true);
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    expect(getAllVorgaenge()).toHaveLength(1);
    const customer = getCustomerStoreSnapshot()[0]!;
    expect(result.vorgang.customerId).toBe(customer.id);
    expect(result.vorgang.customer).toBe(NORDWEST.name);
    expect(customer.name).toBe(NORDWEST.name);
  });

  it('Fall D — existing verwendet ausschließlich die gewählte ID', () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;

    const item = seedItem();
    const result = accept(item, { kind: 'existing', customerId: created.customer.id });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    expect(result.vorgang.customerId).toBe(created.customer.id);
    expect(result.vorgang.customer).toBe(NORDWEST.name);
  });

  it('Fall E — zwei gleichnamige Customers bleiben getrennt', () => {
    const first = createCustomer({ ...NORDWEST, street: 'Hafenstraße 12', city: 'Essen' });
    const second = createCustomer({ ...NORDWEST, street: 'Ruhrallee 5', city: 'Bochum' });
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;

    const item = seedItem();
    const result = accept(item, { kind: 'existing', customerId: second.customer.id });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(getCustomerStoreSnapshot()).toHaveLength(2);
    expect(result.vorgang.customerId).toBe(second.customer.id);
    expect(result.vorgang.customerId).not.toBe(first.customer.id);
    expect(result.vorgang.customerBilling?.city).toBe('Bochum');
  });

  it('Fall F — none erzeugt Unknown-Marker und keinen Customer', () => {
    const item = seedItem();
    const result = accept(item, { kind: 'none' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const vorgang = getVorgangById(result.vorgang.id)!;
    expect(vorgang.customer).toBe('');
    expect(vorgang.customerId).toBeUndefined();
    expect(vorgang.customerExplicitlyUnknown).toBe(true);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });

  it('Fall G — leerer Name und eigene Firma erzeugen keine Mutation', () => {
    for (const testCase of [
      { label: 'leerer Name', name: '   ', errorKey: 'customer.nameRequired' },
      { label: 'eigene Firma', name: OWN, errorKey: 'customer.ownCompanyNotAllowed' },
    ]) {
      resetTestStores();
      hydrateDocumentStore([]);
      hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
      const item = seedItem();
      const before = storeSnapshot();
      const setItemSpy = vi.spyOn(localStorage, 'setItem');

      const result = accept(item, { kind: 'new', input: { name: testCase.name } });

      expect(result.success, testCase.label).toBe(false);
      if (!result.success) {
        expect(result.errorKey, testCase.label).toBe(testCase.errorKey);
      }
      expect(setItemSpy, testCase.label).not.toHaveBeenCalled();
      expect(storeSnapshot(), testCase.label).toEqual(before);
      setItemSpy.mockRestore();
    }
  });

  it('Fall H — verschwundener Customer erzeugt keine Mutation', () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;

    const item = seedItem();
    hydrateCustomerStore([]);
    const before = storeSnapshot();
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    const result = accept(item, { kind: 'existing', customerId: created.customer.id });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('customerDecision.missing');
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(storeSnapshot()).toEqual(before);
    setItemSpy.mockRestore();
  });

  it('Fall I — bestehender Vorgang braucht keine Auswahl und behält seine Identität', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-04c',
        customer: NORDWEST.name,
        customerId: 'cust-04c-fixed',
      }),
    ]);
    const item = seedItem({ vorgangId: 'v-04c', vorgangLinkStatus: 'created' });

    // Ohne Decision — bestehender Vorgang verlangt keine.
    const withoutDecision = accept(item, undefined);
    expect(withoutDecision.success).toBe(true);
    if (!withoutDecision.success) return;
    expect(withoutDecision.createdNewVorgang).toBe(false);
    expect(getVorgangById('v-04c')!.customer).toBe(NORDWEST.name);
    expect(getVorgangById('v-04c')!.customerId).toBe('cust-04c-fixed');

    // Eine irrtümlich übergebene Decision darf ebenfalls nicht wirken.
    const refreshed = getInboxItemById(item.id)!;
    const withDecision = accept(refreshed, {
      kind: 'new',
      input: { name: 'Rheinbau Partner GmbH' },
    });
    expect(withDecision.success).toBe(true);
    const vorgang = getVorgangById('v-04c')!;
    expect(vorgang.customer).toBe(NORDWEST.name);
    expect(vorgang.customerId).toBe('cust-04c-fixed');
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });

  it('Fall I-UI — bestehender Vorgang zeigt keine Customer-Auswahl', async () => {
    // Frischer Zustand, unabhängig von vorherigen Serviceaufrufen.
    resetTestStores();
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });

    const existing = createTestVorgang({
      id: 'v-04c-ui',
      customer: NORDWEST.name,
      customerId: 'cust-04c-ui',
    });
    expect(existing.contractConfirmation).toBeUndefined();
    hydrateVorgangStore([existing]);

    const item = seedItem({ id: 'inbox-04c-ui', vorgangId: 'v-04c-ui', vorgangLinkStatus: 'created' });

    const mount = await mountDetailPage(item.id);

    // Die Seite ist für dieses Item tatsächlich gerendert.
    expect(await waitForSelector(mount, '[data-testid="document-review-more-options"]')).toBeTruthy();

    // Kein neuer Vorgang → keine Auswahl.
    expect(mount.container.querySelector('[data-testid="contract-customer-decision"]')).toBeNull();
    expect(mount.container.querySelector('[data-testid="customer-decision-choice"]')).toBeNull();

    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    const vorgang = getVorgangById('v-04c-ui')!;
    expect(vorgang.customer).toBe(NORDWEST.name);
    expect(vorgang.customerId).toBe('cust-04c-ui');
    unmount(mount);
  });

  it('Fall J1 — primäre Vertragsbestätigung ist ohne Decision gesperrt', async () => {
    const item = seedItem();
    const before = storeSnapshot();
    const acceptSpy = vi.spyOn(contractOrderAcceptService, 'acceptContractOrderFromProposal');
    const mount = await mountDetailPage(item.id);

    // Auswahl sofort sichtbar — außerhalb des eingeklappten LV-Editors.
    expect(mount.container.querySelector('[data-testid="contract-order-proposal"]')).toBeTruthy();
    expect(mount.container.querySelector('[data-testid="contract-customer-decision"]')).toBeTruthy();
    expect(mount.container.querySelector('[data-testid="customer-decision-choice"]')).toBeTruthy();

    // Erster Bestätigungsbutton: primäre CTA der Auftragskarte.
    const primary = mount.container.querySelector(
      '[data-testid="contract-chef-primary-action"]',
    ) as HTMLButtonElement | null;
    expect(primary).toBeTruthy();
    expect(primary!.disabled).toBe(true);
    await click(primary);

    // Der LV-Editor liegt hinter der Scope-Disclosure (Panel: scopeExpanded && hasPositions).
    const scopeToggle = mount.container.querySelector(
      '[data-testid="auftragskarte-toggle-scope"]',
    ) as HTMLButtonElement | null;
    expect(scopeToggle).toBeTruthy();
    expect(scopeToggle!.disabled).toBe(false);
    await click(scopeToggle);

    const disclosure = mount.container.querySelector(
      '[data-testid="contract-lv-editor-disclosure"]',
    );
    expect(disclosure).toBeTruthy();
    await click(disclosure!.querySelector('[data-testid="show-more-toggle"]'));
    expect(disclosure!.querySelector('[data-testid="show-more-content"]')).toBeTruthy();

    // Zweiter Bestätigungsbutton: im gezielt geöffneten Positionseditor.
    const editorConfirm = mount.container.querySelector(
      '[data-testid="contract-create-order-button"]',
    ) as HTMLButtonElement | null;
    expect(editorConfirm).toBeTruthy();
    expect(editorConfirm!.disabled).toBe(true);
    await click(editorConfirm);

    expect(acceptSpy).not.toHaveBeenCalled();
    expect(storeSnapshot()).toEqual(before);
    acceptSpy.mockRestore();
    unmount(mount);
  });

  it('Fall J2 — manueller Vorgang-erstellen-Weg umgeht die Auswahl nicht', async () => {
    const item = seedItem({ markedAsCompanyDocument: true });
    // analysisAllowed hängt an workflow.companyRelevant; ohne diese Markierung
    // wird SmartIntakeSummary gar nicht gerendert.
    expect(getInboxItemById(item.id)?.markedAsCompanyDocument).toBe(true);

    const acceptSpy = vi.spyOn(contractOrderAcceptService, 'acceptContractOrderFromProposal');
    const mount = await mountDetailPage(item.id);

    expect(mount.container.querySelector('[data-testid="customer-decision-choice"]')).toBeTruthy();

    // Zwei Disclosures: „Weitere Optionen“ und darin die Sektion „Technisches“.
    await click(mount.container.querySelector('[data-testid="document-review-more-toggle"]'));
    expect(mount.container.querySelector('[data-testid="document-review-more-content"]')).toBeTruthy();
    await click(mount.container.querySelector('[data-testid="review-section-toggle-technical"]'));
    expect(
      mount.container.querySelector('[data-testid="review-section-content-technical"]'),
    ).toBeTruthy();

    const createButton = mount.container.querySelector(
      '[data-testid="smart-intake-create-vorgang"]',
    ) as HTMLButtonElement | null;
    expect(createButton).toBeTruthy();
    expect(createButton!.disabled).toBe(false);

    const inboxBeforeClick = getInboxStoreSnapshot();
    const documentsBeforeClick = getDocumentStoreSnapshot();
    await click(createButton);
    expect(toastText(mount)).toContain('Kundenzuordnung');

    expect(acceptSpy).not.toHaveBeenCalled();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getAllVorgaenge()).toHaveLength(0);
    expect(getInboxItemById(item.id)?.vorgangId).toBeUndefined();
    expect(getInboxStoreSnapshot()).toEqual(inboxBeforeClick);
    expect(getDocumentStoreSnapshot()).toEqual(documentsBeforeClick);
    expect(mount.container.querySelector('[data-testid="customer-decision-choice"]')).toBeTruthy();
    acceptSpy.mockRestore();
    unmount(mount);
  });

  it('Fall J3 — Alles-ausführen-Weg umgeht die Auswahl nicht', async () => {
    const item = seedItem({
      id: 'inbox-04c-j3',
      markedAsCompanyDocument: true,
      isAdvertisement: false,
    });
    // Erlaubte Vorbereitung: canExecuteAll verlangt bestätigtes Filing.
    confirmFilingDecisionForTests(item.id);
    const prepared = getInboxItemById(item.id)!;
    expect(prepared.markedAsCompanyDocument).toBe(true);
    expect(prepared.isAdvertisement).toBe(false);
    expect(prepared.filingDecision?.status).toBe('confirmed');

    const acceptSpy = vi.spyOn(contractOrderAcceptService, 'acceptContractOrderFromProposal');
    const mount = await mountDetailPage(item.id);

    expect(mount.container.querySelector('[data-testid="customer-decision-choice"]')).toBeTruthy();

    await click(mount.container.querySelector('[data-testid="document-review-more-toggle"]'));
    expect(mount.container.querySelector('[data-testid="document-review-more-content"]')).toBeTruthy();
    await click(mount.container.querySelector('[data-testid="review-section-toggle-technical"]'));
    expect(
      mount.container.querySelector('[data-testid="review-section-content-technical"]'),
    ).toBeTruthy();

    const executeAll = mount.container.querySelector(
      '[data-testid="smart-intake-execute-all"]',
    ) as HTMLButtonElement | null;
    expect(executeAll).toBeTruthy();
    expect(executeAll!.disabled).toBe(false);

    const inboxBeforeClick = getInboxStoreSnapshot();
    const documentsBeforeClick = getDocumentStoreSnapshot();
    await click(executeAll);
    expect(toastText(mount)).toContain('Kundenzuordnung');

    expect(acceptSpy).not.toHaveBeenCalled();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getAllVorgaenge()).toHaveLength(0);
    expect(getInboxItemById(item.id)?.vorgangId).toBeUndefined();
    expect(getInboxStoreSnapshot()).toEqual(inboxBeforeClick);
    expect(getDocumentStoreSnapshot()).toEqual(documentsBeforeClick);
    expect(mount.container.querySelector('[data-testid="customer-decision-choice"]')).toBeTruthy();
    acceptSpy.mockRestore();
    unmount(mount);
  });

  it('Fall K — Positionen und Decision erreichen denselben Accept-Aufruf', () => {
    const item = seedItem();
    const proposal = proposalFor(item);
    const selected = importablePositions(proposal);
    expect(selected.length).toBeGreaterThan(0);

    const result = acceptContractOrderFromProposal({
      item,
      proposal,
      selectedPositions: selected,
      companyName: OWN,
      materialStandard: 'betrieb',
      customerDecision: { kind: 'new', input: { name: NORDWEST.name } },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.positionsAdded).toBeGreaterThan(0);

    const vorgang = getVorgangById(result.vorgang.id)!;
    expect(vorgang.orderPositions.length).toBeGreaterThan(0);
    expect(vorgang.customer).toBe(NORDWEST.name);
    expect(vorgang.customerId).toBe(getCustomerStoreSnapshot()[0]!.id);
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
  });

  it('Fall L — Doppelklick erzeugt keinen zweiten Customer oder Vorgang', () => {
    const item = seedItem();
    const first = accept(item, { kind: 'new', input: { name: NORDWEST.name } });
    expect(first.success).toBe(true);
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    expect(getAllVorgaenge()).toHaveLength(1);

    const refreshed = getInboxItemById(item.id)!;
    const second = accept(refreshed, { kind: 'new', input: { name: NORDWEST.name } });

    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    expect(getAllVorgaenge()).toHaveLength(1);
    if (second.success) {
      expect(second.createdNewVorgang).toBe(false);
    }
  });

  it('Fall O — 05C: vollständige Neuanlage über die Oberfläche', async () => {
    const item = seedItem();
    /**
     * CUSTOMER-PREFILL-NAME-HANDOFF-02D — die Fixture nennt zwei Parteien
     * (Müller Bau als Auftraggeber, Mustermann Sanitär als Subunternehmer), von
     * denen keine die eigene Firma ist. Ohne sicher bestimmte Gegenpartei bleibt
     * der Vorschlag jetzt bewusst leer, statt rollenbasiert zu raten — der
     * Nutzer trägt den Namen wie die übrigen Felder selbst ein.
     */
    const expectedName = 'Müller Bau GmbH';

    const acceptSpy = vi.spyOn(contractOrderAcceptService, 'acceptContractOrderFromProposal');
    const mount = await mountDetailPage(item.id);

    await click(mount.container.querySelector('[data-testid="customer-decision-new"] input'));

    // Keine Vorbefüllung aus erkannten Dokumentdaten — alle sechs Felder leer.
    for (const field of EXTRA_FIELDS) {
      expect(extraFieldValue(mount, field), field).toBe('');
    }
    // Und ebenso wenig ein geratener Name.
    expect(
      (mount.container.querySelector(
        '[data-testid="contract-customer-name-input"]',
      ) as HTMLInputElement).value,
    ).toBe('');

    await typeInto(mount, 'contract-customer-name-input', expectedName);
    await fillExtraFields(mount);
    expect(acceptSpy).not.toHaveBeenCalled();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);

    await click(mount.container.querySelector('[data-testid="contract-chef-primary-action"]'));

    const expectedBilling = {
      name: expectedName,
      contactPerson: NORDWEST.contactPerson,
      street: NORDWEST.street,
      zip: NORDWEST.zip,
      city: NORDWEST.city,
      email: NORDWEST.email,
      phone: NORDWEST.phone,
    };

    expect(acceptSpy).toHaveBeenCalledTimes(1);
    expect(acceptSpy.mock.calls[0]![0]!.customerDecision).toEqual({
      kind: 'new',
      input: expectedBilling,
    });

    const customers = getCustomerStoreSnapshot();
    expect(customers).toHaveLength(1);
    const customer = customers[0]!;
    expect(customer.name).toBe(expectedName);
    expect(customer.contactPerson).toBe(NORDWEST.contactPerson);
    expect(customer.street).toBe(NORDWEST.street);
    expect(customer.zip).toBe(NORDWEST.zip);
    expect(customer.city).toBe(NORDWEST.city);
    expect(customer.email).toBe(NORDWEST.email);
    expect(customer.phone).toBe(NORDWEST.phone);
    expect(customer.createdFromInboxId).toBe(item.id);

    const vorgang = getAllVorgaenge()[0]!;
    expect(vorgang.customerId).toBe(customer.id);
    expect(vorgang.customer).toBe(expectedName);
    expect(vorgang.customerBilling).toEqual(expectedBilling);
    acceptSpy.mockRestore();
    unmount(mount);
  });

  it('Fall P — 05C: zwei unmittelbare Klicks lösen genau einen Accept-Aufruf aus', async () => {
    const item = seedItem();
    const acceptSpy = vi.spyOn(contractOrderAcceptService, 'acceptContractOrderFromProposal');
    const mount = await mountDetailPage(item.id);

    await click(mount.container.querySelector('[data-testid="customer-decision-new"] input'));
    // 02D: Ohne sichere Gegenpartei gibt es keinen Namensvorschlag mehr.
    await typeInto(mount, 'contract-customer-name-input', 'Müller Bau GmbH');
    await fillExtraFields(mount);

    const primary = mount.container.querySelector(
      '[data-testid="contract-chef-primary-action"]',
    ) as HTMLButtonElement;
    expect(primary.disabled).toBe(false);

    // Zwei Ereignisse im selben Turn, dazwischen kein Await und kein Flush.
    await act(async () => {
      primary.click();
      primary.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(acceptSpy).toHaveBeenCalledTimes(1);
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    expect(getAllVorgaenge()).toHaveLength(1);
    acceptSpy.mockRestore();
    unmount(mount);
  });
});
