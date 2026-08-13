/**
 * CUSTOMER-FACHOBJEKT-04D-U4 — later, explicit customer assignment for a Vorgang
 * created with "customer not yet known". Service boundary plus the real UI state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { createCustomer } from './services/customerService';
import {
  getCustomerStoreSnapshot,
  hydrateCustomerStore,
} from './services/customerStoreService';
import {
  addDocument,
  getDocumentById,
  getDocumentStoreSnapshot,
} from './services/documentService';
import { DOCUMENT_ARCHIVE_TRUTH_SNAPSHOT_SCHEMA_VERSION } from './types/documentArchiveTruthSnapshot';
import { getInboxStoreSnapshot } from './services/inboxService';
import {
  assignCustomerToVorgang,
  getVorgangById,
  hydrateVorgangStore,
} from './services/vorgangService';
import { createAbschlagInvoice, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { CustomerDecision } from './services/customerService';
import type { DocumentArchiveTruthSnapshot } from './types/documentArchiveTruthSnapshot';
import type {
  ContractConfirmationSnapshot,
  CustomerBilling,
  Vorgang,
  VorgangDocument,
  VorgangPhoto,
  VorgangTask,
} from './types/models';

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

const EMPTY_BILLING = {
  name: '',
  contactPerson: '',
  street: '',
  zip: '',
  city: '',
  email: '',
  phone: '',
};

/** Vorgang in the exact unknown state, as the atomic handoff would leave it. */
function seedUnknownVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  const vorgang = createTestVorgang({
    id: 'v-u4',
    customer: '',
    customerBilling: { ...EMPTY_BILLING },
    customerExplicitlyUnknown: true,
    ...overrides,
  });
  hydrateVorgangStore([vorgang]);
  return getVorgangById(vorgang.id)!;
}

/** Two eligible unknown Vorgänge side by side, for the route-switch proof. */
function seedTwoUnknownVorgaenge(): [Vorgang, Vorgang] {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-u4-a',
      title: 'Vorgang A',
      customer: '',
      customerBilling: { ...EMPTY_BILLING },
      customerExplicitlyUnknown: true,
    }),
    createTestVorgang({
      id: 'v-u4-b',
      title: 'Vorgang B',
      customer: '',
      customerBilling: { ...EMPTY_BILLING },
      customerExplicitlyUnknown: true,
    }),
  ]);
  return [getVorgangById('v-u4-a')!, getVorgangById('v-u4-b')!];
}

function storeSnapshot() {
  return {
    inbox: getInboxStoreSnapshot(),
    documents: getDocumentStoreSnapshot(),
    customers: getCustomerStoreSnapshot(),
    vorgaenge: getVorgangById('v-u4'),
  };
}

type Mount = { container: HTMLDivElement; root: Root };

/** Test-only: navigation inside the same React root, without touching the app route. */
function NavProbe({ targets }: { targets: string[] }) {
  const navigate = useNavigate();
  return createElement(
    'div',
    null,
    ...targets.map((target) =>
      createElement(
        'button',
        {
          key: target,
          type: 'button',
          'data-testid': `nav-to-${target}`,
          onClick: () => navigate(`/vorgaenge/${target}`),
        },
        target,
      ),
    ),
  );
}

async function mountDetail(vorgangId: string, navTargets: string[] = []): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/vorgaenge/${vorgangId}`] },
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(
            'div',
            null,
            createElement(NavProbe, { targets: navTargets }),
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: '/vorgaenge/:id',
                element: createElement(VorgangDetailPage),
              }),
            ),
          ),
        ),
      ),
    );
  });
  for (let i = 0; i < 20; i += 1) {
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

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('element missing');
  await act(async () => {
    (element as HTMLElement).click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function typeInto(element: Element | null, value: string): Promise<void> {
  if (!element) throw new Error('input missing');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('CUSTOMER-FACHOBJEKT-04D-U4', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    localStorage.clear();
  });

  it('Fall A — bestehender Customer per ID', () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;
    const vorgang = seedUnknownVorgang();
    expect(vorgang.customerExplicitlyUnknown).toBe(true);
    const customersBefore = getCustomerStoreSnapshot();

    const result = assignCustomerToVorgang(vorgang.id, {
      kind: 'existing',
      customerId: created.customer.id,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const stored = getVorgangById(vorgang.id)!;
    expect(stored.customerId).toBe(created.customer.id);
    expect(stored.customer).toBe(NORDWEST.name);
    expect(stored.customerBilling).toEqual(NORDWEST);
    expect(stored.customerExplicitlyUnknown).toBeUndefined();
    // Customer-Stamm unverändert.
    expect(getCustomerStoreSnapshot()).toEqual(customersBefore);
  });

  it('Fall B — neuer Customer entsteht genau einmal', () => {
    const vorgang = seedUnknownVorgang();

    const result = assignCustomerToVorgang(vorgang.id, {
      kind: 'new',
      input: { name: NORDWEST.name },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const customers = getCustomerStoreSnapshot();
    expect(customers).toHaveLength(1);
    const stored = getVorgangById(vorgang.id)!;
    expect(stored.customerId).toBe(customers[0]!.id);
    expect(stored.customer).toBe(NORDWEST.name);
    expect(stored.customerBilling?.name).toBe(NORDWEST.name);
    expect(stored.customerExplicitlyUnknown).toBeUndefined();
  });

  it('Fall C — gleichnamige Customers bleiben getrennt', async () => {
    const first = createCustomer({ ...NORDWEST, street: 'Hafenstraße 12', city: 'Essen' });
    const second = createCustomer({ ...NORDWEST, street: 'Ruhrallee 5', city: 'Bochum' });
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;
    const vorgang = seedUnknownVorgang();

    const mount = await mountDetail(vorgang.id);
    expect(mount.container.querySelector('[data-testid="vorgang-assign-customer"]')).toBeTruthy();
    await click(mount.container.querySelector('[data-testid="customer-decision-existing"] input'));

    const list = mount.container.querySelector('[data-testid="customer-decision-list"]')!;
    expect(list.querySelectorAll('[data-testid^="customer-option-"]')).toHaveLength(2);
    expect(list.textContent).toContain('Hafenstraße 12, 45356 Essen');
    expect(list.textContent).toContain('Ruhrallee 5, 45356 Bochum');
    // Technische IDs bleiben unsichtbar.
    expect(list.textContent).not.toContain(first.customer.id);
    expect(list.textContent).not.toContain(second.customer.id);

    await click(
      mount.container.querySelector(`[data-testid="customer-option-${second.customer.id}"] input`),
    );
    await click(mount.container.querySelector('[data-testid="vorgang-assign-customer-submit"]'));

    const stored = getVorgangById(vorgang.id)!;
    expect(stored.customerId).toBe(second.customer.id);
    expect(stored.customerBilling?.city).toBe('Bochum');
    expect(getCustomerStoreSnapshot()).toHaveLength(2);
    unmount(mount);
  });

  it('Fall D — alle Vorab-Abbrüche ohne Mutation und ohne Persistierung', () => {
    const existing = createCustomer(NORDWEST);
    expect(existing.success).toBe(true);
    if (!existing.success) return;

    const cases: Array<{
      label: string;
      decision: CustomerDecision | undefined;
      overrides?: Partial<Vorgang>;
      errorKey: string;
    }> = [
      { label: 'fehlende Decision', decision: undefined, errorKey: 'customerDecision.required' },
      { label: 'kind none', decision: { kind: 'none' }, errorKey: 'customerDecision.required' },
      {
        label: 'leerer neuer Name',
        decision: { kind: 'new', input: { name: '   ' } },
        errorKey: 'customer.nameRequired',
      },
      {
        label: 'eigene Firma',
        decision: { kind: 'new', input: { name: OWN } },
        errorKey: 'customer.ownCompanyNotAllowed',
      },
      {
        label: 'fehlende Existing-ID',
        decision: { kind: 'existing', customerId: '   ' },
        errorKey: 'customerDecision.missing',
      },
      {
        label: 'verschwundene Existing-ID',
        decision: { kind: 'existing', customerId: 'cust-weg' },
        errorKey: 'customerDecision.missing',
      },
      {
        label: 'bestehende customerId',
        decision: { kind: 'existing', customerId: existing.customer.id },
        overrides: { customerId: 'cust-schon-da' },
        errorKey: 'customer.alreadyAssigned',
      },
      {
        label: 'bestehender customer',
        decision: { kind: 'existing', customerId: existing.customer.id },
        overrides: { customer: 'Rheinbau Partner GmbH' },
        errorKey: 'customer.alreadyAssigned',
      },
      {
        label: 'Identität in customerBilling',
        decision: { kind: 'existing', customerId: existing.customer.id },
        overrides: { customerBilling: { ...EMPTY_BILLING, name: 'Rheinbau Partner GmbH' } },
        errorKey: 'customer.alreadyAssigned',
      },
      {
        label: 'fehlender Unknown-Marker',
        decision: { kind: 'existing', customerId: existing.customer.id },
        overrides: { customerExplicitlyUnknown: undefined },
        errorKey: 'customer.alreadyAssigned',
      },
      {
        label: 'Billing contactPerson gesetzt',
        decision: { kind: 'existing', customerId: existing.customer.id },
        overrides: { customerBilling: { ...EMPTY_BILLING, contactPerson: 'Frau Nordmann' } },
        errorKey: 'customer.alreadyAssigned',
      },
      {
        label: 'Billing street gesetzt',
        decision: { kind: 'existing', customerId: existing.customer.id },
        overrides: { customerBilling: { ...EMPTY_BILLING, street: 'Hafenstraße 12' } },
        errorKey: 'customer.alreadyAssigned',
      },
      {
        label: 'Billing email gesetzt',
        decision: { kind: 'existing', customerId: existing.customer.id },
        overrides: { customerBilling: { ...EMPTY_BILLING, email: 'kontakt@nordwest-dachbau.de' } },
        errorKey: 'customer.alreadyAssigned',
      },
    ];

    for (const testCase of cases) {
      const vorgang = seedUnknownVorgang(testCase.overrides);
      const before = storeSnapshot();
      const setItemSpy = vi.spyOn(localStorage, 'setItem');

      const result = assignCustomerToVorgang(vorgang.id, testCase.decision);

      expect(result.success, testCase.label).toBe(false);
      if (!result.success) {
        expect(result.errorKey, testCase.label).toBe(testCase.errorKey);
      }
      expect(setItemSpy, testCase.label).not.toHaveBeenCalled();
      expect(storeSnapshot(), testCase.label).toEqual(before);
      setItemSpy.mockRestore();
    }

    // Unbekannter Vorgang.
    const missing = assignCustomerToVorgang('v-gibt-es-nicht', {
      kind: 'existing',
      customerId: existing.customer.id,
    });
    expect(missing).toEqual({ success: false, errorKey: 'vorgang.notFound' });

    // Ungültige Bestands-Customers: aus dem gültigen Objekt abgeleitet, kein Cast.
    for (const invalid of [
      { label: 'Customer mit leerem Namen', name: '   ', errorKey: 'customerDecision.missing' },
      { label: 'Customer ist eigene Firma', name: OWN, errorKey: 'customerDecision.ownCompany' },
    ]) {
      hydrateCustomerStore([{ ...existing.customer, name: invalid.name }]);
      const vorgang = seedUnknownVorgang();
      const before = storeSnapshot();
      const setItemSpy = vi.spyOn(localStorage, 'setItem');

      const result = assignCustomerToVorgang(vorgang.id, {
        kind: 'existing',
        customerId: existing.customer.id,
      });

      expect(result.success, invalid.label).toBe(false);
      if (!result.success) {
        expect(result.errorKey, invalid.label).toBe(invalid.errorKey);
      }
      expect(setItemSpy, invalid.label).not.toHaveBeenCalled();
      expect(storeSnapshot(), invalid.label).toEqual(before);
      expect(getVorgangById(vorgang.id)?.customerExplicitlyUnknown, invalid.label).toBe(true);
      setItemSpy.mockRestore();
    }
  });

  it('Fall E — Persistenzfehler hinterlässt keinen Teilerfolg', () => {
    const vorgang = seedUnknownVorgang();
    const before = storeSnapshot();
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    const result = assignCustomerToVorgang(vorgang.id, {
      kind: 'new',
      input: { name: NORDWEST.name },
    });

    expect(setItemSpy).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    const stored = getVorgangById(vorgang.id)!;
    expect(stored.customer).toBe('');
    expect(stored.customerId).toBeUndefined();
    expect(stored.customerExplicitlyUnknown).toBe(true);
    expect(storeSnapshot()).toEqual(before);
    setItemSpy.mockRestore();
  });

  it('Fall F — zweiter Aufruf erzeugt keine Dublette', () => {
    const vorgang = seedUnknownVorgang();
    const first = assignCustomerToVorgang(vorgang.id, {
      kind: 'new',
      input: { name: NORDWEST.name },
    });
    expect(first.success).toBe(true);

    const afterFirst = getVorgangById(vorgang.id)!;
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    const second = assignCustomerToVorgang(vorgang.id, {
      kind: 'new',
      input: { name: 'Rheinbau Partner GmbH' },
    });

    expect(second).toEqual({ success: false, errorKey: 'customer.alreadyAssigned' });
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    const afterSecond = getVorgangById(vorgang.id)!;
    expect(afterSecond.customerId).toBe(afterFirst.customerId);
    expect(afterSecond.customer).toBe(afterFirst.customer);
    expect(afterSecond.customerBilling).toEqual(afterFirst.customerBilling);
    setItemSpy.mockRestore();
  });

  it('Fall G — unveränderliche Vorgangsdaten bleiben unberührt', () => {
    const position = createOrderPosition({ id: 'op-u4' });
    // Rechnung mit echtem, vollständigem Kundensnapshot einer externen Firma.
    const invoiceCustomerSnapshot: CustomerBilling = {
      name: 'Rheinbau Partner GmbH',
      contactPerson: 'Herr Rhein',
      street: 'Rheinallee 3',
      zip: '50667',
      city: 'Köln',
      email: 'info@rheinbau-partner.de',
      phone: '0221 3030',
    };
    const invoice = createAbschlagInvoice('op-u4', 4, {
      customerSnapshot: invoiceCustomerSnapshot,
    });

    // CompanyDocument mit vollständigem, typgerechtem ArchiveTruth-Snapshot.
    const archiveTruthSnapshot: DocumentArchiveTruthSnapshot = {
      schemaVersion: DOCUMENT_ARCHIVE_TRUTH_SNAPSHOT_SCHEMA_VERSION,
      createdAt: '2026-05-04T09:00:00.000Z',
      sourceInboxItemId: 'inbox-u4',
      analyzedAt: '2026-05-04T08:59:00.000Z',
      analysisVersion: 'test-1',
      sourceFingerprint: 'fingerprint-u4',
      businessInterpretation: null,
      specialistRefs: {
        hasContractIntelligence: false,
        hasContractOrderProposal: false,
        hasClassification: false,
        hasDocumentUnderstanding: false,
        companyRelevant: true,
      },
      overlay: [],
    };
    const archived = addDocument({
      title: 'Werkvertrag NordWest',
      category: 'vertrag',
      issuer: 'Rheinbau Partner GmbH',
      recognizedText: 'Vertragstext',
      digitalFolder: { id: 'dig-u4', name: 'Verträge', path: '/Vertraege/' },
      paperFolder: { folderId: 'p1', register: 'A', label: 'Ordner 1' },
      tags: [],
      archiveTruthSnapshot,
    });
    expect(archived.success).toBe(true);
    if (!archived.success) return;
    expect(getDocumentById(archived.document.id)?.archiveTruthSnapshot).toBeDefined();
    // Vollständig typgerechter Snapshot mit allen Pflichtarrays — kein Cast.
    const confirmation: ContractConfirmationSnapshot = {
      id: 'cc-u4',
      confirmedAt: '2026-05-04T09:00:00.000Z',
      customer: 'Bestätigter Kunde GmbH',
      auftraggeber: 'Bestätigter Kunde GmbH',
      baustelle: 'Teststraße 1',
      title: 'Testvorgang',
      positions: [
        {
          id: position.id,
          description: position.description,
          plannedQuantity: position.plannedQuantity,
          unit: position.unit,
          unitPrice: position.unitPrice,
          category: position.category,
          billable: position.billable,
        },
      ],
      negotiation: {
        notes: ['Preis besprochen'],
        generalHints: ['Zahlungsziel 14 Tage'],
        priceProposals: [],
        positionProposals: [],
        drafts: [],
      },
      immutable: true,
    };
    const task: VorgangTask = {
      id: 'task-u4',
      type: 'termin',
      title: 'Aufmaß vereinbaren',
      done: false,
    };
    const document: VorgangDocument = {
      id: 'vdoc-u4',
      name: 'Werkvertrag.pdf',
      type: 'kundenauftrag',
      date: '2026-05-04',
    };
    const photo: VorgangPhoto = { id: 'photo-u4', caption: 'Dach vorher', date: '2026-05-04' };

    const vorgang = seedUnknownVorgang({
      orderPositions: [position],
      invoices: [invoice],
      contractConfirmation: confirmation,
      tasks: [task],
      documents: [document],
      photos: [photo],
    });

    // Vorbedingungen sind wirklich gesetzt — die Nachweise sind nicht vakuos.
    expect(vorgang.invoices).toHaveLength(1);
    expect(vorgang.invoices[0]?.customerSnapshot).toBeDefined();
    expect(vorgang.invoices[0]?.customerSnapshot?.name).toBe('Rheinbau Partner GmbH');
    expect(vorgang.contractConfirmation?.id).toBe('cc-u4');
    expect(vorgang.orderPositions).toHaveLength(1);
    expect(vorgang.tasks).toHaveLength(1);
    expect(vorgang.documents).toHaveLength(1);
    expect(vorgang.photos).toHaveLength(1);
    const documentsBefore = getDocumentStoreSnapshot();

    const result = assignCustomerToVorgang(vorgang.id, {
      kind: 'new',
      input: { name: NORDWEST.name },
    });
    expect(result.success).toBe(true);

    const stored = getVorgangById(vorgang.id)!;
    // Genau die vier Kundenfelder haben sich geändert.
    expect(stored.customer).toBe(NORDWEST.name);
    expect(stored.customerId).toBeTruthy();
    expect(stored.customerBilling?.name).toBe(NORDWEST.name);
    expect(stored.customerExplicitlyUnknown).toBeUndefined();

    expect(stored.invoices).toEqual(vorgang.invoices);
    expect(stored.invoices[0]?.customerSnapshot).toEqual(invoiceCustomerSnapshot);
    expect(getDocumentById(archived.document.id)?.archiveTruthSnapshot).toEqual(
      archiveTruthSnapshot,
    );
    expect(stored.contractConfirmation).toEqual(vorgang.contractConfirmation);
    expect(stored.contractConfirmation?.customer).toBe('Bestätigter Kunde GmbH');
    expect(stored.orderPositions).toEqual(vorgang.orderPositions);
    expect(stored.tasks).toEqual(vorgang.tasks);
    expect(stored.documents).toEqual(vorgang.documents);
    expect(stored.photos).toEqual(vorgang.photos);
    expect(stored.title).toBe(vorgang.title);
    expect(stored.baustelle).toBe(vorgang.baustelle);
    expect(stored.status).toBe(vorgang.status);
    expect(getDocumentStoreSnapshot()).toEqual(documentsBefore);
  });

  it('Fall H — UI zeigt den Bereich nur im gültigen Unknown-Zustand', async () => {
    // Bestehende Identität → kein Zuordnungsbereich.
    const assigned = seedUnknownVorgang({
      customer: NORDWEST.name,
      customerId: 'cust-fest',
      customerExplicitlyUnknown: undefined,
    });
    const assignedMount = await mountDetail(assigned.id);
    expect(
      assignedMount.container.querySelector('[data-testid="vorgang-assign-customer"]'),
    ).toBeNull();
    unmount(assignedMount);

    // Inkonsistent: Marker gesetzt, aber Kunde vorhanden → ebenfalls nicht sichtbar.
    const inconsistent = seedUnknownVorgang({ customer: NORDWEST.name });
    const inconsistentMount = await mountDetail(inconsistent.id);
    expect(
      inconsistentMount.container.querySelector('[data-testid="vorgang-assign-customer"]'),
    ).toBeNull();
    unmount(inconsistentMount);

    // Gültiger Unknown-Zustand → sichtbar, Aktion ohne Auswahl gesperrt.
    const unknown = seedUnknownVorgang();
    const mount = await mountDetail(unknown.id);
    expect(mount.container.querySelector('[data-testid="vorgang-assign-customer"]')).toBeTruthy();
    const submit = mount.container.querySelector(
      '[data-testid="vorgang-assign-customer-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // 'none' löst keine Zuordnung aus.
    await click(mount.container.querySelector('[data-testid="customer-decision-none"] input'));
    await click(submit);
    expect(getVorgangById(unknown.id)?.customerExplicitlyUnknown).toBe(true);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);

    // Eigene Firma sperrt mit sichtbarem Hinweis.
    await click(mount.container.querySelector('[data-testid="customer-decision-new"] input'));
    await typeInto(
      mount.container.querySelector('[data-testid="vorgang-assign-customer-name"]'),
      OWN,
    );
    expect(
      (mount.container.querySelector(
        '[data-testid="vorgang-assign-customer-submit"]',
      ) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      mount.container.querySelector('[data-testid="customer-decision-hint"]')?.textContent,
    ).toContain('Eigene Firma');

    // Gültiger neuer Name → Zuordnung, Bereich verschwindet.
    await typeInto(
      mount.container.querySelector('[data-testid="vorgang-assign-customer-name"]'),
      NORDWEST.name,
    );
    await click(mount.container.querySelector('[data-testid="vorgang-assign-customer-submit"]'));

    const stored = getVorgangById(unknown.id)!;
    expect(stored.customer).toBe(NORDWEST.name);
    expect(stored.customerId).toBeTruthy();
    expect(stored.customerExplicitlyUnknown).toBeUndefined();
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    expect(mount.container.querySelector('[data-testid="vorgang-assign-customer"]')).toBeNull();
    unmount(mount);
  });

  it('Fall H3 — Vorgangswechsel setzt Modus und neuen Namen zurück', async () => {
    const [a, b] = seedTwoUnknownVorgaenge();

    const mount = await mountDetail(a.id, [a.id, b.id]);
    expect(mount.container.querySelector('[data-testid="vorgang-assign-customer"]')).toBeTruthy();

    await click(mount.container.querySelector('[data-testid="customer-decision-new"] input'));
    await typeInto(
      mount.container.querySelector('[data-testid="vorgang-assign-customer-name"]'),
      'Rheinbau Partner GmbH',
    );
    expect(
      (mount.container.querySelector(
        '[data-testid="vorgang-assign-customer-submit"]',
      ) as HTMLButtonElement).disabled,
    ).toBe(false);

    // Wechsel im selben React-Root.
    await click(mount.container.querySelector(`[data-testid="nav-to-${b.id}"]`));

    expect(mount.container.querySelector('[data-testid="vorgang-assign-customer"]')).toBeTruthy();
    for (const mode of ['new', 'existing', 'none']) {
      expect(
        (mount.container.querySelector(
          `[data-testid="customer-decision-${mode}"] input`,
        ) as HTMLInputElement).checked,
        mode,
      ).toBe(false);
    }
    expect(mount.container.querySelector('[data-testid="customer-decision-list"]')).toBeNull();
    expect(
      (mount.container.querySelector(
        '[data-testid="vorgang-assign-customer-submit"]',
      ) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mount.container.textContent).not.toContain('Rheinbau Partner GmbH');

    // Nach erneuter Auswahl von new ist das Namensfeld leer.
    await click(mount.container.querySelector('[data-testid="customer-decision-new"] input'));
    expect(
      (mount.container.querySelector(
        '[data-testid="vorgang-assign-customer-name"]',
      ) as HTMLInputElement).value,
    ).toBe('');

    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getVorgangById(a.id)?.customerExplicitlyUnknown).toBe(true);
    expect(getVorgangById(b.id)?.customerExplicitlyUnknown).toBe(true);
    unmount(mount);
  });

  it('Fall H4 — existing-Auswahl und Laufzeitfehler überleben den Wechsel nicht', async () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;
    const [a, b] = seedTwoUnknownVorgaenge();

    const mount = await mountDetail(a.id, [a.id, b.id]);
    await click(mount.container.querySelector('[data-testid="customer-decision-existing"] input'));
    await click(
      mount.container.querySelector(`[data-testid="customer-option-${created.customer.id}"] input`),
    );

    // Customer verschwindet vor der Bestätigung → sichtbarer Laufzeitfehler.
    hydrateCustomerStore([]);
    await click(mount.container.querySelector('[data-testid="vorgang-assign-customer-submit"]'));
    expect(
      mount.container.querySelector('[data-testid="customer-decision-hint"]')?.textContent,
    ).toContain('nicht mehr vorhanden');

    // Wechsel im selben React-Root.
    await click(mount.container.querySelector(`[data-testid="nav-to-${b.id}"]`));

    expect(mount.container.querySelector('[data-testid="vorgang-assign-customer"]')).toBeTruthy();
    expect(
      (mount.container.querySelector(
        '[data-testid="customer-decision-existing"] input',
      ) as HTMLInputElement).checked,
    ).toBe(false);
    expect(mount.container.querySelector('[data-testid="customer-decision-list"]')).toBeNull();
    expect(mount.container.querySelector('[data-testid="customer-decision-hint"]')).toBeNull();
    expect(
      (mount.container.querySelector(
        '[data-testid="vorgang-assign-customer-submit"]',
      ) as HTMLButtonElement).disabled,
    ).toBe(true);

    // Beide Vorgänge bleiben unverändert, kein Customer entstand.
    for (const vorgang of [a, b]) {
      const stored = getVorgangById(vorgang.id)!;
      expect(stored.customerExplicitlyUnknown).toBe(true);
      expect(stored.customerId).toBeUndefined();
      expect(stored.customer).toBe('');
    }
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    unmount(mount);
  });

  it('Fall H2 — Laufzeitfehler erhält Modus, Name und Auswahl', async () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;
    const vorgang = seedUnknownVorgang();

    const mount = await mountDetail(vorgang.id);
    await click(mount.container.querySelector('[data-testid="customer-decision-existing"] input'));
    await click(
      mount.container.querySelector(`[data-testid="customer-option-${created.customer.id}"] input`),
    );

    // Customer verschwindet nach der Auswahl, vor dem Klick.
    hydrateCustomerStore([]);
    await click(mount.container.querySelector('[data-testid="vorgang-assign-customer-submit"]'));

    expect(getVorgangById(vorgang.id)?.customerExplicitlyUnknown).toBe(true);
    expect(getVorgangById(vorgang.id)?.customerId).toBeUndefined();
    expect(
      mount.container.querySelector('[data-testid="customer-decision-hint"]')?.textContent,
    ).toContain('nicht mehr vorhanden');
    // Auswahlzustand bleibt erhalten: Bereich und Modus stehen weiterhin.
    expect(mount.container.querySelector('[data-testid="vorgang-assign-customer"]')).toBeTruthy();
    expect(
      (mount.container.querySelector(
        '[data-testid="customer-decision-existing"] input',
      ) as HTMLInputElement).checked,
    ).toBe(true);
    unmount(mount);
  });
});
