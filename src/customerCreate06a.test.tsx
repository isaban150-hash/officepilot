/**
 * CUSTOMER-FACHOBJEKT-06A — creating a customer without any Vorgang.
 * Real route, real page, real services; only localStorage.setItem is injected
 * as a persistence failure.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './components/ui/Card';
import { AppProvider, useApp } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { KundenDetailPage } from './pages/KundenDetailPage';
import { KundenPage } from './pages/KundenPage';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { createCustomer } from './services/customerService';
import { getCustomerStoreSnapshot, hydrateCustomerStore } from './services/customerStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { setTaskStoreForTests } from './services/taskStore';
import { getAllVorgaenge, hydrateVorgangStore } from './services/vorgangService';
import { createTestVorgang } from './test/fixtures';
import type { CustomerBilling, VorgangInvoice } from './types/models';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const OWN = 'Cirmak Haustechnik GmbH';
const SAME_NAME = 'NordWest Dachbau GmbH';

const FULL: CustomerBilling = {
  name: SAME_NAME,
  contactPerson: 'Frau Nordmann',
  street: 'Hafenstraße 12',
  zip: '45356',
  city: 'Essen',
  email: 'kontakt@nordwest-dachbau.de',
  phone: '0201 4711',
};

const INVOICE_SNAPSHOT: CustomerBilling = { ...FULL, name: 'Rheinbau Partner GmbH' };

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
        <Route path="/kunden" element={<KundenPage />} />
        <Route
          path="/kunden/customer/:customerId"
          element={<KundenDetailPage kind="customer" />}
        />
      </Routes>
      {toast && (
        <Toast message={toast} onClose={clearToast} closeLabel={translate('common.close')} />
      )}
    </>
  );
}

function mountKunden() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/kunden']}>
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

function fieldValue(container: HTMLElement, field: keyof CustomerBilling): string {
  const input = container.querySelector(
    `[data-testid="kunden-edit-${field}"]`,
  ) as HTMLInputElement;
  expect(input, `missing ${field}`).not.toBeNull();
  return input.value;
}

function fillAll(container: HTMLElement, values: CustomerBilling): void {
  for (const field of FIELDS) {
    typeInto(container, `kunden-edit-${field}`, values[field]);
  }
}

/** Opens the create form and asserts it starts empty. */
function openCreateForm(container: HTMLElement): void {
  expect(container.querySelector('[data-testid="kunden-create-action"]')).not.toBeNull();
  click(container, 'kunden-create-action');
  expect(container.querySelector('[data-testid="kunden-edit-form"]')).not.toBeNull();
  for (const field of FIELDS) {
    expect(fieldValue(container, field), field).toBe('');
  }
}

/** Submits and awaits the release microtask inside the same act. */
async function saveAndSettle(container: HTMLElement): Promise<void> {
  const button = container.querySelector('[data-testid="kunden-edit-save"]') as HTMLButtonElement;
  expect(button).not.toBeNull();
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function toastText(container: HTMLElement): string | null {
  return container.querySelector('.toast')?.textContent ?? null;
}

function customerFields(customer: {
  name: string;
  contactPerson: string;
  street: string;
  zip: string;
  city: string;
  email: string;
  phone: string;
}): CustomerBilling {
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

function invoiceFixture(): VorgangInvoice {
  return {
    id: 'inv-06a',
    number: 'R-2026-070',
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

/** Legacy Vorgang with the same name — must stay its own entry. */
function seedLegacyVorgang(): void {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-06a',
      title: 'Alt-Vorgang',
      customer: SAME_NAME,
      customerBilling: { ...FULL, contactPerson: 'Alt Kontakt' },
      invoices: [invoiceFixture()],
    }),
  ]);
}

describe('CUSTOMER-FACHOBJEKT-06A', () => {
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

  it('Fall A — vollständige Anlage ohne Vorgang, sofort in Liste und Kundenakte', async () => {
    // Positive Vorbedingung: kein Customer, kein Vorgang.
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getAllVorgaenge()).toHaveLength(0);

    const view = mountKunden();
    const { container } = view;
    expect(container.querySelector('[data-testid="kunden-page"]')).not.toBeNull();
    // Auch im leeren Zustand unmittelbar erreichbar.
    expect(container.querySelector('[data-testid="kunden-empty-state"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-create-action"]')).not.toBeNull();
    expect(toastText(container)).toBeNull();

    openCreateForm(container);
    fillAll(container, FULL);
    // Tippen persistiert nichts.
    expect(getCustomerStoreSnapshot()).toHaveLength(0);

    await saveAndSettle(container);

    const customers = getCustomerStoreSnapshot();
    expect(customers).toHaveLength(1);
    const customer = customers[0]!;
    expect(customerFields(customer)).toEqual(FULL);
    expect(customer.id).toBeTruthy();
    expect(customer.createdAt).toBeTruthy();
    expect('createdFromInboxId' in customer).toBe(false);

    // Formular geschlossen, Erfolgstoast sichtbar.
    expect(container.querySelector('[data-testid="kunden-edit-form"]')).toBeNull();
    expect(toastText(container)).toContain('Kunde angelegt.');

    // Sofort als eigene Zeile mit korrektem Link.
    const row = container.querySelector(`[data-testid="kunde-customer-${customer.id}"]`);
    expect(row).not.toBeNull();
    expect(row!.getAttribute('href')).toBe(`/kunden/customer/${customer.id}`);
    expect(row!.textContent).toContain(SAME_NAME);
    expect(row!.querySelector('[data-testid="kunde-address"]')!.textContent).toBe(
      'Hafenstraße 12, 45356 Essen',
    );
    expect(container.textContent).not.toContain(customer.id);

    // Kein Vorgang entstanden.
    expect(getAllVorgaenge()).toHaveLength(0);

    // Navigation in die neue Kundenakte — dort ist 05A verfügbar.
    click(container, `kunde-customer-${customer.id}`);
    expect(container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-edit-action"]')).not.toBeNull();
    expect(container.querySelector('h1')!.textContent).toBe(SAME_NAME);
    expect(container.textContent).not.toContain(customer.id);

    view.unmount();
  });

  it('Fall B — Anlage nur mit Name, übrige Felder bleiben leer', async () => {
    const view = mountKunden();
    const { container } = view;
    openCreateForm(container);
    typeInto(container, 'kunden-edit-name', 'Nur Name GmbH');
    await saveAndSettle(container);

    const customers = getCustomerStoreSnapshot();
    expect(customers).toHaveLength(1);
    expect(customerFields(customers[0]!)).toEqual({
      name: 'Nur Name GmbH',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    });
    // Fehlende Anschrift nutzt den vorhandenen übersetzten Fallback.
    const row = container.querySelector(`[data-testid="kunde-customer-${customers[0]!.id}"]`)!;
    expect(row.querySelector('[data-testid="kunde-address"]')!.textContent).toContain(
      'Anschrift nicht hinterlegt',
    );
    view.unmount();
  });

  it('Fall C — Abbrechen verwirft ohne jede Persistenz', async () => {
    const view = mountKunden();
    const { container } = view;
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    openCreateForm(container);
    fillAll(container, FULL);
    click(container, 'kunden-edit-cancel');

    expect(container.querySelector('[data-testid="kunden-edit-form"]')).toBeNull();
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(toastText(container)).toBeNull();

    // Erneutes Öffnen beginnt wieder leer.
    openCreateForm(container);
    view.unmount();
  });

  it('Fall D — leerer Name und eigene Firma blockieren ohne Persistenz', async () => {
    const view = mountKunden();
    const { container } = view;
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    openCreateForm(container);
    typeInto(container, 'kunden-edit-name', '   ');
    typeInto(container, 'kunden-edit-city', 'Bochum');
    await saveAndSettle(container);

    expect(container.querySelector('[data-testid="kunden-edit-form"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-edit-error"]')!.textContent).toBe(
      'Kundenname erforderlich.',
    );
    expect(fieldValue(container, 'city')).toBe('Bochum');
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(toastText(container)).toBeNull();

    typeInto(container, 'kunden-edit-name', OWN);
    await saveAndSettle(container);

    expect(container.querySelector('[data-testid="kunden-edit-error"]')!.textContent).toBe(
      'Eigene Firma kann nicht als Kunde angelegt werden.',
    );
    expect(fieldValue(container, 'name')).toBe(OWN);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(toastText(container)).toBeNull();
    view.unmount();
  });

  it('Fall E — Persistenzfehler rollt zurück und hält die Eingaben', async () => {
    const seeded = createCustomer({ ...FULL, name: 'Bestandskunde GmbH', city: 'Köln' });
    expect(seeded.success).toBe(true);
    if (!seeded.success) return;
    const before = getCustomerStoreSnapshot();
    expect(before).toHaveLength(1);

    const view = mountKunden();
    const { container } = view;
    openCreateForm(container);
    fillAll(container, FULL);

    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    await saveAndSettle(container);

    expect(setItemSpy).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="kunden-edit-form"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-edit-error"]')!.textContent).toBe(
      'Speichern fehlgeschlagen. Es wurde nichts geändert.',
    );
    expect(fieldValue(container, 'street')).toBe(FULL.street);
    expect(toastText(container)).toBeNull();
    // Vollständiger Rollback auf den Vorzustand.
    expect(getCustomerStoreSnapshot()).toEqual(before);

    // Späterer Versuch gelingt — keine dauerhafte Verriegelung.
    setItemSpy.mockRestore();
    await saveAndSettle(container);
    expect(getCustomerStoreSnapshot()).toHaveLength(2);
    expect(toastText(container)).toContain('Kunde angelegt.');
    view.unmount();
  });

  it('Fall F — zwei synchrone Submits erzeugen genau einen Customer', async () => {
    const view = mountKunden();
    const { container } = view;
    openCreateForm(container);
    fillAll(container, FULL);

    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    const form = container.querySelector('[data-testid="kunden-edit-form"]') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('Fall G — gleichnamige Customer und Legacy-Eintrag bleiben getrennt', async () => {
    seedLegacyVorgang();
    const vorgaengeBefore = getAllVorgaenge();
    expect(vorgaengeBefore).toHaveLength(1);
    expect(vorgaengeBefore[0]!.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);

    const first = createCustomer({ ...FULL });
    expect(first.success).toBe(true);
    if (!first.success) return;
    const firstBefore = getCustomerStoreSnapshot()[0]!;

    const view = mountKunden();
    const { container } = view;
    openCreateForm(container);
    fillAll(container, { ...FULL, street: 'Seeufer 9', zip: '88131', city: 'Lindau' });
    await saveAndSettle(container);

    const customers = getCustomerStoreSnapshot();
    expect(customers).toHaveLength(2);
    const second = customers.find((entry) => entry.id !== first.customer.id)!;
    expect(second.id).not.toBe(first.customer.id);
    expect(second.name).toBe(first.customer.name);
    // Bestehender Customer vollständig unverändert.
    expect(customers.find((entry) => entry.id === first.customer.id)).toEqual(firstBefore);

    // Getrennte Zeilen, getrennte Links, getrennte Adressen.
    const rowA = container.querySelector(`[data-testid="kunde-customer-${first.customer.id}"]`)!;
    const rowB = container.querySelector(`[data-testid="kunde-customer-${second.id}"]`)!;
    expect(rowA.getAttribute('href')).not.toBe(rowB.getAttribute('href'));
    expect(rowA.querySelector('[data-testid="kunde-address"]')!.textContent).toBe(
      'Hafenstraße 12, 45356 Essen',
    );
    expect(rowB.querySelector('[data-testid="kunde-address"]')!.textContent).toBe(
      'Seeufer 9, 88131 Lindau',
    );

    // Der gleichnamige Legacy-Eintrag bleibt eigenständig.
    const legacyRow = container.querySelector('[data-testid^="kunde-legacy-"]');
    expect(legacyRow).not.toBeNull();
    expect(legacyRow!.textContent).toContain('Altbestand');
    expect(container.textContent).not.toContain(first.customer.id);
    expect(container.textContent).not.toContain(second.id);

    // Vorgänge und Rechnungssnapshot vollständig unverändert.
    const vorgaengeAfter = getAllVorgaenge();
    expect(vorgaengeAfter).toHaveLength(1);
    expect(vorgaengeAfter).toEqual(vorgaengeBefore);
    expect(vorgaengeAfter[0]!.customerId).toBeUndefined();
    expect(vorgaengeAfter[0]!.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);
    view.unmount();
  });
});
