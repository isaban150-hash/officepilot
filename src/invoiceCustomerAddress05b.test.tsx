/**
 * CUSTOMER-FACHOBJEKT-05B — explicit takeover of the customer master data into
 * a single invoice draft. Real invoice route, real services; nothing but the
 * local draft may change.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './components/ui/Card';
import { AppProvider, useApp } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { RechnungPage } from './pages/RechnungPage';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { createCustomer, updateCustomer } from './services/customerService';
import { getCustomerById, hydrateCustomerStore } from './services/customerStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { setTaskStoreForTests } from './services/taskStore';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import { createTestVorgang } from './test/fixtures';
import type { Customer, CustomerBilling, Vorgang, VorgangInvoice } from './types/models';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const OWN = 'Cirmak Haustechnik GmbH';
const SAME_NAME = 'NordWest Dachbau GmbH';

/** Alter, vollständiger Vorgangssnapshot. */
const OLD_BILLING: CustomerBilling = {
  name: SAME_NAME,
  contactPerson: 'Frau Nordmann',
  street: 'Hafenstraße 12',
  zip: '45356',
  city: 'Essen',
  email: 'alt@nordwest-dachbau.de',
  phone: '0201 4711',
};

/** Aktuelle Stammdaten von Customer A. */
const MASTER: CustomerBilling = {
  name: 'NordWest Dachbau Nord GmbH',
  contactPerson: 'Herr Nordmann',
  street: 'Ruhrallee 5',
  zip: '44787',
  city: 'Bochum',
  email: 'neu@nordwest-dachbau.de',
  phone: '0234 999999',
};

/** Snapshot einer bereits bestehenden Rechnung. */
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

function TestHarness() {
  const { toast, clearToast, translate } = useApp();
  return (
    <>
      <Routes>
        <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
      </Routes>
      {toast && (
        <Toast message={toast} onClose={clearToast} closeLabel={translate('common.close')} />
      )}
    </>
  );
}

function mountInvoice(vorgangId: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/${vorgangId}/rechnung?type=rechnung`]}>
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

/** Öffnet den Bearbeiten-Schritt des Rechnungseditors. */
function openEditStep(container: HTMLElement): void {
  expect(container.querySelector('[data-testid="invoice-continue-preview"]')).not.toBeNull();
  click(container, 'invoice-continue-preview');
  expect(container.querySelector('[data-testid="invoice-edit"]')).not.toBeNull();
  click(container, 'invoice-edit');
  expect(container.querySelector('[data-testid="invoice-edit-customer-name"]')).not.toBeNull();
}

function draftFields(container: HTMLElement): CustomerBilling {
  const read = (field: keyof CustomerBilling) =>
    (
      container.querySelector(
        `[data-testid="invoice-edit-customer-${field}"]`,
      ) as HTMLInputElement
    ).value;
  return {
    name: read('name'),
    contactPerson: read('contactPerson'),
    street: read('street'),
    zip: read('zip'),
    city: read('city'),
    email: read('email'),
    phone: read('phone'),
  };
}

/** Ändert ein kontrolliertes Eingabefeld wie ein Nutzer. */
function typeInto(container: HTMLElement, testId: string, value: string): void {
  const input = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
  expect(input, `missing ${testId}`).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function toastText(container: HTMLElement): string | null {
  return container.querySelector('.toast')?.textContent ?? null;
}

function seedCustomer(values: CustomerBilling): Customer {
  const result = createCustomer(values);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('fixture');
  return result.customer;
}

function invoiceFixture(): VorgangInvoice {
  return {
    id: 'inv-05b',
    number: 'R-2026-060',
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
  } as VorgangInvoice;
}

function seedVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  const vorgang = createTestVorgang({
    id: 'v-05b',
    title: 'Dachsanierung',
    customer: SAME_NAME,
    customerBilling: { ...OLD_BILLING },
    invoices: [invoiceFixture()],
    ...overrides,
  });
  hydrateVorgangStore([vorgang]);
  return getVorgangById('v-05b')!;
}

describe('CUSTOMER-FACHOBJEKT-05B', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCustomerStore([]);
    hydrateVorgangStore([]);
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Fall A — Quelle, Vorschau und Bestätigung ohne jede Änderung', () => {
    const a = seedCustomer({ ...OLD_BILLING });
    const b = seedCustomer({ ...OLD_BILLING, street: 'Seeufer 9', zip: '88131', city: 'Lindau' });
    expect(a.id).not.toBe(b.id);
    const vorgang = seedVorgang({ customerId: a.id });
    expect(vorgang.customerBilling).toEqual(OLD_BILLING);

    // Der Stamm von A ändert sich, der Vorgang bleibt auf dem alten Stand.
    const updated = updateCustomer(a.id, MASTER);
    expect(updated.success).toBe(true);
    expect(getVorgangById('v-05b')!.customerBilling).toEqual(OLD_BILLING);

    const view = mountInvoice('v-05b');
    const { container } = view;
    openEditStep(container);

    // Ohne Klick zeigt der Entwurf weiterhin den Vorgangssnapshot.
    expect(draftFields(container)).toEqual(OLD_BILLING);

    // Quelle ist Customer A — nicht der gleichnamige B und keine ID.
    const source = container.querySelector('[data-testid="invoice-customer-master-source"]')!;
    expect(source.textContent).toContain(MASTER.name);
    expect(source.textContent).toContain('Ruhrallee 5, 44787 Bochum');
    expect(source.textContent).not.toContain('Seeufer 9');
    expect(container.textContent).not.toContain(a.id);
    expect(container.textContent).not.toContain(b.id);

    // Alle Aktionsschaltflächen sind ausdrücklich keine Formular-Submits.
    const actionButton = container.querySelector('[data-testid="invoice-customer-master-action"]');
    expect(actionButton).not.toBeNull();
    expect(actionButton!.getAttribute('type')).toBe('button');

    // Erster Klick öffnet nur die Bestätigung.
    click(container, 'invoice-customer-master-action');
    const applyButton = container.querySelector('[data-testid="invoice-customer-master-apply"]');
    const cancelButton = container.querySelector('[data-testid="invoice-customer-master-cancel"]');
    expect(applyButton).not.toBeNull();
    expect(cancelButton).not.toBeNull();
    expect(applyButton!.getAttribute('type')).toBe('button');
    expect(cancelButton!.getAttribute('type')).toBe('button');
    expect(container.querySelector('[data-testid="invoice-customer-master-confirm"]')).not.toBeNull();
    expect(draftFields(container)).toEqual(OLD_BILLING);
    expect(toastText(container)).toBeNull();

    // Abbrechen verwirft die Aktion vollständig.
    click(container, 'invoice-customer-master-cancel');
    expect(container.querySelector('[data-testid="invoice-customer-master-confirm"]')).toBeNull();
    expect(draftFields(container)).toEqual(OLD_BILLING);
    expect(toastText(container)).toBeNull();
    expect(getVorgangById('v-05b')!.customerBilling).toEqual(OLD_BILLING);

    // E-Mail und Telefon sind kontrolliert an den lokalen Draft gebunden.
    const customerBefore = getCustomerById(a.id)!;
    const vorgangBefore = getVorgangById('v-05b')!;
    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    typeInto(container, 'invoice-edit-customer-email', 'tipp@example.com');
    typeInto(container, 'invoice-edit-customer-phone', '0201 000111');
    expect(draftFields(container).email).toBe('tipp@example.com');
    expect(draftFields(container).phone).toBe('0201 000111');
    // Die Eingaben bleiben rein lokal — keine Übernahme, keine Speicherung.
    expect(getCustomerById(a.id)).toEqual(customerBefore);
    expect(getVorgangById('v-05b')!.customerBilling).toEqual(vorgangBefore.customerBilling);
    expect(getVorgangById('v-05b')!.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(toastText(container)).toBeNull();

    view.unmount();
  });

  it('Fall B — Bestätigung übernimmt alle sieben Felder nur in den Entwurf', () => {
    const a = seedCustomer({ ...OLD_BILLING });
    const b = seedCustomer({ ...OLD_BILLING, street: 'Seeufer 9', zip: '88131', city: 'Lindau' });
    seedVorgang({ customerId: a.id });
    expect(updateCustomer(a.id, MASTER).success).toBe(true);
    const aAfterUpdate = getCustomerById(a.id)!;
    const bBefore = getCustomerById(b.id)!;
    const vorgangBefore = getVorgangById('v-05b')!;
    expect(vorgangBefore.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);

    const view = mountInvoice('v-05b');
    const { container } = view;
    openEditStep(container);

    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    click(container, 'invoice-customer-master-action');
    click(container, 'invoice-customer-master-apply');

    // Alle sieben Felder stammen exakt aus Customer A.
    expect(draftFields(container)).toEqual(MASTER);
    for (const field of FIELDS) {
      expect(draftFields(container)[field]).toBe(aAfterUpdate[field]);
    }
    expect(toastText(container)).toContain('Kundendaten für diesen Rechnungsentwurf übernommen.');
    expect(container.querySelector('[data-testid="invoice-customer-master-confirm"]')).toBeNull();

    // Nichts außerhalb des Entwurfs hat sich verändert.
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(getCustomerById(a.id)).toEqual(aAfterUpdate);
    expect(getCustomerById(b.id)).toEqual(bBefore);
    const vorgangAfter = getVorgangById('v-05b')!;
    expect(vorgangAfter.customer).toBe(SAME_NAME);
    expect(vorgangAfter.customerId).toBe(a.id);
    expect(vorgangAfter.customerBilling).toEqual(OLD_BILLING);
    expect(vorgangAfter.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);

    // Wechsel Bearbeiten → Vorschau → Bearbeiten im selben Draft, ohne Unmount.
    const callsAfterApply = setItemSpy.mock.calls.length;
    click(container, 'invoice-back-preview');
    expect(container.querySelector('[data-testid="invoice-edit"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="invoice-edit-customer-name"]')).toBeNull();
    click(container, 'invoice-edit');
    expect(container.querySelector('[data-testid="invoice-edit-customer-name"]')).not.toBeNull();

    // Die Übernahme bleibt erhalten, ohne erneuten Erfolg oder Schreibvorgang.
    expect(draftFields(container)).toEqual(MASTER);
    expect(setItemSpy.mock.calls.length).toBe(callsAfterApply);
    expect(getCustomerById(a.id)).toEqual(aAfterUpdate);
    const vorgangAfterSwitch = getVorgangById('v-05b')!;
    expect(vorgangAfterSwitch.customerBilling).toEqual(OLD_BILLING);
    expect(vorgangAfterSwitch.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);

    // Jetzt sind Entwurf und Stamm identisch — die Aktion ist deaktiviert.
    const action = container.querySelector(
      '[data-testid="invoice-customer-master-action"]',
    ) as HTMLButtonElement;
    expect(action).not.toBeNull();
    expect(action.disabled).toBe(true);
    const identical = container.querySelector(
      '[data-testid="invoice-customer-master-identical"]',
    );
    expect(identical).not.toBeNull();
    expect(identical!.textContent).toBe('Der Entwurf enthält bereits die aktuellen Kundendaten.');

    view.unmount();
  });

  it('Fall C — Legacy, Orphan und Unknown erhalten keine Aktion', () => {
    // Legacy ohne customerId.
    seedVorgang({});
    const legacy = mountInvoice('v-05b');
    openEditStep(legacy.container);
    expect(draftFields(legacy.container)).toEqual(OLD_BILLING);
    expect(legacy.container.querySelector('[data-testid="invoice-customer-master"]')).toBeNull();
    legacy.unmount();

    // Orphan: customerId ohne Customer im Store.
    seedVorgang({ customerId: 'cust-nicht-im-store' });
    const orphan = mountInvoice('v-05b');
    openEditStep(orphan.container);
    expect(draftFields(orphan.container)).toEqual(OLD_BILLING);
    expect(orphan.container.querySelector('[data-testid="invoice-customer-master"]')).toBeNull();
    expect(orphan.container.textContent).not.toContain('cust-nicht-im-store');
    orphan.unmount();

    // Ausdrücklich unbekannter Kunde.
    const unknownBilling: CustomerBilling = {
      name: '',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    };
    seedVorgang({ customer: '', customerExplicitlyUnknown: true, customerBilling: unknownBilling });
    const unknown = mountInvoice('v-05b');
    openEditStep(unknown.container);
    expect(draftFields(unknown.container)).toEqual(unknownBilling);
    expect(unknown.container.querySelector('[data-testid="invoice-customer-master"]')).toBeNull();
    unknown.unmount();
  });

  it('Fall D — unvollständige Stammanschrift deaktiviert die Aktion', () => {
    const a = seedCustomer({
      ...OLD_BILLING,
      name: 'Ohne Anschrift GmbH',
      street: '',
      zip: '',
      city: '',
    });
    seedVorgang({ customerId: a.id });

    const view = mountInvoice('v-05b');
    const { container } = view;
    openEditStep(container);

    // Positive Vorbedingung: der Block ist gerendert.
    expect(container.querySelector('[data-testid="invoice-customer-master"]')).not.toBeNull();
    const action = container.querySelector(
      '[data-testid="invoice-customer-master-action"]',
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="invoice-customer-master-incomplete"]')!.textContent,
    ).toBe('Im Kundenstamm ist noch keine vollständige Anschrift hinterlegt.');
    expect(draftFields(container)).toEqual(OLD_BILLING);

    click(container, 'invoice-customer-master-action');
    expect(container.querySelector('[data-testid="invoice-customer-master-confirm"]')).toBeNull();
    expect(draftFields(container)).toEqual(OLD_BILLING);

    view.unmount();
  });

  it('Fall E — zwischenzeitlich entfernter Customer wird sicher behandelt', () => {
    const a = seedCustomer({ ...MASTER });
    seedVorgang({ customerId: a.id });

    const view = mountInvoice('v-05b');
    const { container } = view;
    openEditStep(container);
    // Positive Vorbedingungen: Block, Quelle und Entwurfsstand.
    expect(container.querySelector('[data-testid="invoice-customer-master"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="invoice-customer-master-source"]')).not.toBeNull();
    expect(draftFields(container)).toEqual(OLD_BILLING);

    click(container, 'invoice-customer-master-action');
    expect(container.querySelector('[data-testid="invoice-customer-master-confirm"]')).not.toBeNull();

    // Der Customer verschwindet zwischen Anzeige und Bestätigung.
    hydrateCustomerStore([]);
    expect(getCustomerById(a.id)).toBeUndefined();
    click(container, 'invoice-customer-master-apply');

    // Der Fehlerknoten ist positiv vorhanden.
    const error = container.querySelector('[data-testid="invoice-customer-master-error"]');
    expect(error).not.toBeNull();
    expect(error!.textContent).toBe('Der Kunde ist nicht mehr vorhanden. Es wurde nichts geändert.');

    // Bestätigung, Quellenanzeige und Aktion sind verschwunden.
    expect(container.querySelector('[data-testid="invoice-customer-master-confirm"]')).toBeNull();
    expect(container.querySelector('[data-testid="invoice-customer-master-source"]')).toBeNull();
    expect(container.querySelector('[data-testid="invoice-customer-master-action"]')).toBeNull();

    // Nichts wurde geändert.
    expect(draftFields(container)).toEqual(OLD_BILLING);
    expect(toastText(container)).toBeNull();
    const vorgangAfter = getVorgangById('v-05b')!;
    expect(vorgangAfter.customerBilling).toEqual(OLD_BILLING);
    expect(vorgangAfter.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);
    expect(container.textContent).not.toContain(a.id);

    view.unmount();
  });

  it('Fall F — erneutes Öffnen baut den Entwurf wieder aus dem Vorgang auf', () => {
    const a = seedCustomer({ ...OLD_BILLING });
    seedVorgang({ customerId: a.id });
    expect(updateCustomer(a.id, MASTER).success).toBe(true);

    const first = mountInvoice('v-05b');
    openEditStep(first.container);
    click(first.container, 'invoice-customer-master-action');
    click(first.container, 'invoice-customer-master-apply');
    expect(draftFields(first.container)).toEqual(MASTER);
    first.unmount();

    const second = mountInvoice('v-05b');
    openEditStep(second.container);
    // Keine automatische Wiederübernahme.
    expect(draftFields(second.container)).toEqual(OLD_BILLING);
    const action = second.container.querySelector(
      '[data-testid="invoice-customer-master-action"]',
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    second.unmount();
  });
});
