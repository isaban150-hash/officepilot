/**
 * CUSTOMER-FACHOBJEKT-06B — explicit takeover of the current customer master
 * data into a Vorgang. Only `customer` and `customerBilling` change; existing
 * invoices and their customerSnapshot stay frozen.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './components/ui/Card';
import { AppProvider, useApp } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { createCustomer, updateCustomer } from './services/customerService';
import { getCustomerById, getCustomerStoreSnapshot } from './services/customerStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { buildRechnungDraft } from './services/invoiceService';
import { setTaskStoreForTests } from './services/taskStore';
import {
  getVorgangById,
  getVorgangCustomerMasterPreview,
  hydrateVorgangStore,
  updateVorgangCustomerFromMaster,
} from './services/vorgangService';
import { createOrderPosition, createTestVorgang, testSetup } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { Customer, CustomerBilling, Vorgang, VorgangInvoice } from './types/models';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const OWN = 'Cirmak Haustechnik GmbH';
const SAME_NAME = 'NordWest Dachbau GmbH';

/** Old, complete data stored on the Vorgang. */
const OLD_BILLING: CustomerBilling = {
  name: SAME_NAME,
  contactPerson: 'Frau Nordmann',
  street: 'Hafenstraße 12',
  zip: '45356',
  city: 'Essen',
  email: 'alt@nordwest-dachbau.de',
  phone: '0201 4711',
};

/** Current master data of the very same customer id. */
const MASTER: CustomerBilling = {
  name: 'NordWest Dachbau Nord GmbH',
  contactPerson: 'Herr Nordmann',
  street: 'Ruhrallee 5',
  zip: '44787',
  city: 'Bochum',
  email: 'neu@nordwest-dachbau.de',
  phone: '0234 999999',
};

const INVOICE_SNAPSHOT: CustomerBilling = { ...OLD_BILLING };

const FIELDS: Array<keyof CustomerBilling> = [
  'name',
  'contactPerson',
  'street',
  'zip',
  'city',
  'email',
  'phone',
];

/** Navigation target of the next in-root router navigation. */
let navTarget = '';

function TestNavigator() {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="test-navigate" onClick={() => navigate(navTarget)}>
      go
    </button>
  );
}

function TestHarness() {
  const { toast, clearToast, translate } = useApp();
  return (
    <>
      <Routes>
        <Route path="/vorgaenge/:id" element={<VorgangDetailPage />} />
      </Routes>
      <TestNavigator />
      {toast && (
        <Toast message={toast} onClose={clearToast} closeLabel={translate('common.close')} />
      )}
    </>
  );
}

function mountVorgang(vorgangId: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/${vorgangId}`]}>
        <AppProvider initialSetup={completeSetup}>
          <TestHarness />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function click(container: HTMLElement, testId: string): void {
  const element = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
  expect(element, `missing ${testId}`).not.toBeNull();
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Triggers the apply action and awaits the release microtask the page schedules,
 * inside the same act — no timers, no arbitrary delay.
 */
async function applyAndSettle(container: HTMLElement): Promise<void> {
  const button = container.querySelector(
    '[data-testid="vorgang-customer-master-apply"]',
  ) as HTMLButtonElement;
  expect(button, 'missing apply button').not.toBeNull();
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function applyButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector(
    '[data-testid="vorgang-customer-master-apply"]',
  ) as HTMLButtonElement;
  expect(button, 'missing apply button').not.toBeNull();
  return button;
}

function toastText(container: HTMLElement): string | null {
  return container.querySelector('.toast')?.textContent ?? null;
}

function billingOf(customer: Customer): CustomerBilling {
  return {
    name: customer.name,
    contactPerson: customer.contactPerson,
    street: customer.street,
    zip: customer.zip,
    city: customer.city,
    email: customer.email,
    phone: customer.phone,
  };
}

function invoiceFixture(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-06b',
    number: 'R-2026-080',
    type: 'rechnung',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    paymentStatus: 'offen',
    payments: [],
    customerSnapshot: { ...INVOICE_SNAPSHOT },
    ...overrides,
  } as VorgangInvoice;
}

/** Customer with current master data plus a Vorgang still holding the old data. */
function seedCustomerAndVorgang(): { customer: Customer; vorgang: Vorgang } {
  const created = createCustomer({ ...OLD_BILLING });
  expect(created.success).toBe(true);
  if (!created.success) throw new Error('fixture');
  const updated = updateCustomer(created.customer.id, MASTER);
  expect(updated.success).toBe(true);
  if (!updated.success) throw new Error('fixture');

  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-06b',
      title: 'Dachsanierung',
      customer: OLD_BILLING.name,
      customerId: created.customer.id,
      customerBilling: { ...OLD_BILLING },
      orderPositions: [createOrderPosition({ id: 'op-06b' })],
      invoices: [invoiceFixture()],
    }),
  ]);
  return { customer: updated.customer, vorgang: getVorgangById('v-06b')! };
}

describe('CUSTOMER-FACHOBJEKT-06B', () => {
  beforeEach(() => {
    localStorage.clear();
    navTarget = '';
    resetTestStores();
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    localStorage.clear();
  });

  it('Fall A — bestätigte Übernahme aktualisiert nur Name und Billing', async () => {
    const { customer, vorgang } = seedCustomerAndVorgang();
    // Positive Vorbedingungen.
    expect(billingOf(customer)).toEqual(MASTER);
    expect(vorgang.customer).toBe(OLD_BILLING.name);
    expect(vorgang.customerBilling).toEqual(OLD_BILLING);
    expect(vorgang.customerId).toBe(customer.id);
    expect(vorgang.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);

    const view = mountVorgang('v-06b');
    const { container } = view;
    expect(container.querySelector('[data-testid="vorgang-customer-master"]')).not.toBeNull();

    // Öffnen mutiert nichts.
    click(container, 'vorgang-customer-master-action');
    const confirm = container.querySelector('[data-testid="vorgang-customer-master-confirm"]');
    expect(confirm).not.toBeNull();
    const currentBlock = container.querySelector('[data-testid="vorgang-customer-master-current"]')!;
    const nextBlock = container.querySelector('[data-testid="vorgang-customer-master-next"]')!;
    expect(currentBlock.textContent).toContain(OLD_BILLING.name);
    expect(currentBlock.textContent).toContain('Hafenstraße 12');
    expect(nextBlock.textContent).toContain(MASTER.name);
    expect(nextBlock.textContent).toContain('Ruhrallee 5');
    expect(getVorgangById('v-06b')!.customerBilling).toEqual(OLD_BILLING);
    expect(toastText(container)).toBeNull();

    await applyAndSettle(container);

    const after = getVorgangById('v-06b')!;
    expect(after.customer).toBe(MASTER.name);
    expect(after.customerBilling).toEqual(MASTER);
    for (const field of FIELDS) {
      expect(after.customerBilling![field], field).toBe(customer[field]);
    }
    // Identität und Rechnungen unverändert.
    expect(after.customerId).toBe(vorgang.customerId);
    expect(after.invoices).toEqual(vorgang.invoices);
    expect(after.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);
    expect(getCustomerById(customer.id)).toEqual(customer);

    expect(toastText(container)).toContain('Kundendaten im Vorgang aktualisiert.');
    expect(container.querySelector('[data-testid="vorgang-customer-master-confirm"]')).toBeNull();
    // Kein Unterschied mehr — Aktion verschwindet.
    expect(container.querySelector('[data-testid="vorgang-customer-master"]')).toBeNull();
    expect(container.textContent).not.toContain(customer.id);
    view.unmount();
  });

  it('Fall B — Abbrechen schreibt nichts', () => {
    const { customer, vorgang } = seedCustomerAndVorgang();
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    const view = mountVorgang('v-06b');
    const { container } = view;
    click(container, 'vorgang-customer-master-action');
    expect(
      container.querySelector('[data-testid="vorgang-customer-master-current"]')!.textContent,
    ).toContain(OLD_BILLING.name);
    expect(
      container.querySelector('[data-testid="vorgang-customer-master-next"]')!.textContent,
    ).toContain(MASTER.name);

    click(container, 'vorgang-customer-master-cancel');

    expect(container.querySelector('[data-testid="vorgang-customer-master-confirm"]')).toBeNull();
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(getVorgangById('v-06b')).toEqual(vorgang);
    expect(getCustomerById(customer.id)).toEqual(customer);
    expect(toastText(container)).toBeNull();
    view.unmount();
  });

  it('Fall C — zukünftiger Entwurf verwendet die aktualisierten Vorgangsdaten', () => {
    const { vorgang } = seedCustomerAndVorgang();
    // Vorher: der Entwurf trägt den alten Snapshot.
    const before = buildRechnungDraft('v-06b', testSetup);
    expect(before).not.toBeNull();
    expect(before!.customerBilling).toEqual(OLD_BILLING);

    const result = updateVorgangCustomerFromMaster('v-06b');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.changed).toBe(true);

    const after = buildRechnungDraft('v-06b', testSetup);
    expect(after).not.toBeNull();
    expect(after!.customerBilling).toEqual(MASTER);
    // Die bestehende Rechnung bleibt alt.
    expect(getVorgangById('v-06b')!.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);
    expect(getVorgangById('v-06b')!.customerId).toBe(vorgang.customerId);
  });

  it('Fall D — Identitätsgrenzen: gleichnamig, Legacy und Orphan', () => {
    const { customer } = seedCustomerAndVorgang();
    // Zweiter Customer mit demselben Namen wie der Stamm, andere ID und Anschrift.
    const twin = createCustomer({ ...MASTER, street: 'Seeufer 9', zip: '88131', city: 'Lindau' });
    expect(twin.success).toBe(true);
    if (!twin.success) return;
    expect(twin.customer.name).toBe(MASTER.name);
    expect(twin.customer.id).not.toBe(customer.id);
    const twinBefore = getCustomerById(twin.customer.id)!;

    const result = updateVorgangCustomerFromMaster('v-06b');
    expect(result.success).toBe(true);
    if (!result.success) return;
    const after = getVorgangById('v-06b')!;
    // Ausschließlich der Customer aus vorgang.customerId.
    expect(after.customerBilling).toEqual(MASTER);
    expect(after.customerBilling!.street).toBe('Ruhrallee 5');
    expect(after.customerId).toBe(customer.id);
    expect(getCustomerById(twin.customer.id)).toEqual(twinBefore);

    // Legacy ohne customerId.
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-legacy',
        customer: MASTER.name,
        customerBilling: { ...OLD_BILLING },
      }),
    ]);
    const legacyBefore = getVorgangById('v-legacy')!;
    expect(legacyBefore.customerId).toBeUndefined();
    expect(getVorgangCustomerMasterPreview('v-legacy')).toBeNull();
    const legacyResult = updateVorgangCustomerFromMaster('v-legacy');
    expect(legacyResult).toEqual({ success: false, errorKey: 'customer.notFound' });
    expect(getVorgangById('v-legacy')).toEqual(legacyBefore);

    const legacyView = mountVorgang('v-legacy');
    expect(
      legacyView.container.querySelector('[data-testid="vorgang-customer-master"]'),
    ).toBeNull();
    legacyView.unmount();

    // Orphan: customerId ohne Customer im Store.
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-orphan',
        customer: MASTER.name,
        customerId: 'cust-nicht-im-store',
        customerBilling: { ...OLD_BILLING },
      }),
    ]);
    const orphanBefore = getVorgangById('v-orphan')!;
    expect(orphanBefore.customerId).toBe('cust-nicht-im-store');
    expect(getVorgangCustomerMasterPreview('v-orphan')).toBeNull();
    const orphanResult = updateVorgangCustomerFromMaster('v-orphan');
    expect(orphanResult).toEqual({ success: false, errorKey: 'customer.notFound' });
    expect(getVorgangById('v-orphan')).toEqual(orphanBefore);

    const orphanView = mountVorgang('v-orphan');
    expect(
      orphanView.container.querySelector('[data-testid="vorgang-customer-master"]'),
    ).toBeNull();
    orphanView.unmount();
  });

  it('Fall E — No-op ohne Persistenz', () => {
    const created = createCustomer({ ...MASTER });
    expect(created.success).toBe(true);
    if (!created.success) return;
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-06b',
        customer: MASTER.name,
        customerId: created.customer.id,
        customerBilling: { ...MASTER },
        invoices: [invoiceFixture()],
      }),
    ]);
    const before = getVorgangById('v-06b')!;
    const preview = getVorgangCustomerMasterPreview('v-06b');
    expect(preview).not.toBeNull();
    expect(preview!.differs).toBe(false);

    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    const result = updateVorgangCustomerFromMaster('v-06b');
    expect(result).toMatchObject({ success: true, changed: false });
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(getVorgangById('v-06b')).toEqual(before);

    const view = mountVorgang('v-06b');
    expect(view.container.querySelector('[data-testid="vorgang-customer-master"]')).toBeNull();
    view.unmount();
  });

  it('Fall F — Persistenzfehler rollt vollständig zurück', async () => {
    const { customer, vorgang } = seedCustomerAndVorgang();
    const customersBefore = getCustomerStoreSnapshot();

    const view = mountVorgang('v-06b');
    const { container } = view;
    click(container, 'vorgang-customer-master-action');

    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    await applyAndSettle(container);
    expect(setItemSpy).toHaveBeenCalled();
    setItemSpy.mockRestore();

    expect(getVorgangById('v-06b')).toEqual(vorgang);
    expect(getVorgangById('v-06b')!.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);
    expect(getCustomerStoreSnapshot()).toEqual(customersBefore);
    expect(getCustomerById(customer.id)).toEqual(customer);

    const error = container.querySelector('[data-testid="vorgang-customer-master-error"]');
    expect(error).not.toBeNull();
    expect(error!.textContent).toBe('Speichern fehlgeschlagen. Es wurde nichts geändert.');
    expect(container.querySelector('[data-testid="vorgang-customer-master-confirm"]')).not.toBeNull();
    expect(toastText(container)).toBeNull();

    // Nach der Microtask ist die Sperre wieder frei.
    expect(applyButton(container).disabled).toBe(false);

    // Späterer Retry gelingt — keine dauerhafte Verriegelung.
    await applyAndSettle(container);
    expect(getVorgangById('v-06b')!.customerBilling).toEqual(MASTER);
    expect(getVorgangById('v-06b')!.customer).toBe(MASTER.name);
    expect(toastText(container)).toContain('Kundendaten im Vorgang aktualisiert.');
    view.unmount();
  });

  it('Fall G — zwei synchrone Bestätigungen erzeugen genau eine Mutation', async () => {
    seedCustomerAndVorgang();
    const view = mountVorgang('v-06b');
    const { container } = view;
    click(container, 'vorgang-customer-master-action');

    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    const apply = applyButton(container);
    // Zwei Ereignisse im selben Turn — dazwischen kein Await, kein Flush, kein Timer.
    await act(async () => {
      apply.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      apply.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(getVorgangById('v-06b')!.customerBilling).toEqual(MASTER);
    view.unmount();
  });

  it('Fall H — ein zweiter Vorgang desselben Customers bleibt unverändert', () => {
    const { customer } = seedCustomerAndVorgang();
    const other = createTestVorgang({
      id: 'v-06b-other',
      title: 'Zweiter Vorgang',
      customer: 'Abweichender Name GmbH',
      customerId: customer.id,
      customerBilling: {
        name: 'Abweichender Name GmbH',
        contactPerson: 'Herr Anders',
        street: 'Abweichweg 1',
        zip: '10115',
        city: 'Berlin',
        email: 'anders@example.com',
        phone: '030 111',
      },
      invoices: [invoiceFixture({ id: 'inv-06b-other', number: 'R-2026-081' })],
    });
    hydrateVorgangStore([getVorgangById('v-06b')!, other]);
    const otherBefore = getVorgangById('v-06b-other')!;
    expect(otherBefore.customerBilling!.street).toBe('Abweichweg 1');

    const result = updateVorgangCustomerFromMaster('v-06b');
    expect(result.success).toBe(true);

    expect(getVorgangById('v-06b')!.customerBilling).toEqual(MASTER);
    // Der zweite Vorgang bleibt per Gesamtvergleich unberührt.
    expect(getVorgangById('v-06b-other')).toEqual(otherBefore);
    expect(getVorgangById('v-06b-other')!.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);
  });

  it('Fall I — Vorgangswechsel im selben Root verwirft Bestätigung, Fehler und Sperre', async () => {
    // Zwei eindeutig verschiedene Customer.
    const createdA = createCustomer({ ...OLD_BILLING });
    expect(createdA.success).toBe(true);
    if (!createdA.success) return;
    const masterA = updateCustomer(createdA.customer.id, MASTER);
    expect(masterA.success).toBe(true);
    if (!masterA.success) return;

    const createdB = createCustomer({
      name: 'Rheinbau Partner GmbH',
      contactPerson: 'Herr Rhein',
      street: 'Rheinallee 3',
      zip: '50667',
      city: 'Köln',
      email: 'info@rheinbau-partner.de',
      phone: '0221 3030',
    });
    expect(createdB.success).toBe(true);
    if (!createdB.success) return;
    expect(createdB.customer.id).not.toBe(createdA.customer.id);

    const oldBillingB: CustomerBilling = {
      name: 'Rheinbau Alt GmbH',
      contactPerson: 'Frau Alt',
      street: 'Altweg 7',
      zip: '50667',
      city: 'Köln',
      email: 'alt@rheinbau-partner.de',
      phone: '0221 1111',
    };

    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-06b-a',
        title: 'Vorgang A',
        customer: OLD_BILLING.name,
        customerId: createdA.customer.id,
        customerBilling: { ...OLD_BILLING },
        invoices: [invoiceFixture()],
      }),
      createTestVorgang({
        id: 'v-06b-b',
        title: 'Vorgang B',
        customer: oldBillingB.name,
        customerId: createdB.customer.id,
        customerBilling: { ...oldBillingB },
        invoices: [invoiceFixture({ id: 'inv-06b-b', number: 'R-2026-082' })],
      }),
    ]);
    const vorgangBBefore = getVorgangById('v-06b-b')!;
    // Beide besitzen grundsätzlich eine 06B-Aktion.
    expect(getVorgangCustomerMasterPreview('v-06b-a')!.differs).toBe(true);
    expect(getVorgangCustomerMasterPreview('v-06b-b')!.differs).toBe(true);

    const view = mountVorgang('v-06b-a');
    const { container } = view;
    expect(container.textContent).toContain('Vorgang A');

    click(container, 'vorgang-customer-master-action');
    expect(
      container.querySelector('[data-testid="vorgang-customer-master-current"]')!.textContent,
    ).toContain(OLD_BILLING.name);
    expect(
      container.querySelector('[data-testid="vorgang-customer-master-next"]')!.textContent,
    ).toContain(MASTER.name);

    // Sichtbarer Fehler bei A erzeugen.
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    await applyAndSettle(container);
    setItemSpy.mockRestore();

    const errorA = container.querySelector('[data-testid="vorgang-customer-master-error"]');
    expect(errorA).not.toBeNull();
    const errorTextA = errorA!.textContent!;
    expect(errorTextA).toBe('Speichern fehlgeschlagen. Es wurde nichts geändert.');
    expect(container.querySelector('[data-testid="vorgang-customer-master-confirm"]')).not.toBeNull();

    // Echte Navigation im selben React-Root — kein Remount.
    navTarget = '/vorgaenge/v-06b-b';
    click(container, 'test-navigate');

    // B ist gerendert und trägt ausschließlich eigene Daten.
    expect(container.textContent).toContain('Vorgang B');
    expect(container.textContent).not.toContain('Vorgang A');
    expect(container.querySelector('[data-testid="vorgang-customer-master-confirm"]')).toBeNull();
    expect(container.querySelector('[data-testid="vorgang-customer-master-error"]')).toBeNull();
    expect(container.textContent).not.toContain(errorTextA);
    expect(container.querySelector('[data-testid="vorgang-customer-master-action"]')).not.toBeNull();
    expect(container.textContent).not.toContain(createdA.customer.id);
    expect(container.textContent).not.toContain(createdB.customer.id);
    // Ohne ausdrückliche Bestätigung bleibt B vollständig unverändert.
    expect(getVorgangById('v-06b-b')).toEqual(vorgangBBefore);

    // Bestätigung bei B zeigt ausschließlich B-Daten.
    click(container, 'vorgang-customer-master-action');
    const currentB = container.querySelector('[data-testid="vorgang-customer-master-current"]')!;
    const nextB = container.querySelector('[data-testid="vorgang-customer-master-next"]')!;
    expect(currentB.textContent).toContain('Altweg 7');
    expect(nextB.textContent).toContain('Rheinallee 3');
    expect(currentB.textContent).not.toContain(OLD_BILLING.street);
    expect(nextB.textContent).not.toContain(MASTER.street);
    expect(container.querySelector('[data-testid="vorgang-customer-master-error"]')).toBeNull();
    expect(applyButton(container).disabled).toBe(false);

    // Abbrechen bei B schreibt nichts.
    const cancelSpy = vi.spyOn(localStorage, 'setItem');
    click(container, 'vorgang-customer-master-cancel');
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="vorgang-customer-master-confirm"]')).toBeNull();
    expect(getVorgangById('v-06b-b')).toEqual(vorgangBBefore);
    cancelSpy.mockRestore();

    view.unmount();
  });
});
