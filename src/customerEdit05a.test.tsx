/**
 * CUSTOMER-FACHOBJEKT-05A — editing customer master data in the customer workspace.
 * Real production route, real services; only localStorage.setItem is injected as
 * a persistence failure in Fall E.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './components/ui/Card';
import { AppProvider, useApp } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { KundenDetailPage } from './pages/KundenDetailPage';
import { createTestVorgang } from './test/fixtures';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { createCustomer } from './services/customerService';
import { getCustomerById, hydrateCustomerStore } from './services/customerStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { setTaskStoreForTests } from './services/taskStore';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import type { Customer, CustomerBilling, Vorgang, VorgangInvoice } from './types/models';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const OWN = 'Cirmak Haustechnik GmbH';

const SOURCE: CustomerBilling = {
  name: 'NordWest Dachbau GmbH',
  contactPerson: 'Frau Nordmann',
  street: 'Hafenstraße 12',
  zip: '45356',
  city: 'Essen',
  email: 'kontakt@nordwest-dachbau.de',
  phone: '0201 4711',
};

const NEXT: CustomerBilling = {
  name: 'NordWest Dachbau Nord GmbH',
  contactPerson: 'Herr Nordmann',
  street: 'Ruhrallee 5',
  zip: '44787',
  city: 'Bochum',
  email: 'neu@nordwest-dachbau.de',
  phone: '0234 999999',
};

const INVOICE_SNAPSHOT: CustomerBilling = {
  name: 'NordWest Dachbau GmbH',
  contactPerson: 'Frau Nordmann',
  street: 'Hafenstraße 12',
  zip: '45356',
  city: 'Essen',
  email: 'kontakt@nordwest-dachbau.de',
  phone: '0201 4711',
};

/** Target of the next in-root router navigation; set right before the click. */
let navTarget = '';

function TestNavigator() {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="test-navigate" onClick={() => navigate(navTarget)}>
      go
    </button>
  );
}

/**
 * Renders the production toast exactly like AppShell does, plus a navigator that
 * performs a real router navigation inside the same React root.
 */
function TestHarness() {
  const { toast, clearToast, translate } = useApp();
  return (
    <>
      <Routes>
        <Route
          path="/kunden/customer/:customerId"
          element={<KundenDetailPage kind="customer" />}
        />
      </Routes>
      <TestNavigator />
      {toast && (
        <Toast message={toast} onClose={clearToast} closeLabel={translate('common.close')} />
      )}
    </>
  );
}

function mountAt(path: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
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

function mountCustomer(customerId: string) {
  return mountAt(`/kunden/customer/${customerId}`);
}

function seedCustomer(
  overrides: Partial<CustomerBilling> = {},
  options?: { createdFromInboxId?: string },
): Customer {
  const result = createCustomer({ ...SOURCE, ...overrides }, options);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('fixture');
  return result.customer;
}

const SUCCESS_TOAST = 'Kundenstammdaten gespeichert.';

function toastText(container: HTMLElement): string | null {
  return container.querySelector('.toast')?.textContent ?? null;
}

function typeInto(container: HTMLElement, testId: string, value: string): void {
  const input = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function fillAll(container: HTMLElement, values: CustomerBilling): void {
  typeInto(container, 'kunden-edit-name', values.name);
  typeInto(container, 'kunden-edit-contactPerson', values.contactPerson);
  typeInto(container, 'kunden-edit-street', values.street);
  typeInto(container, 'kunden-edit-zip', values.zip);
  typeInto(container, 'kunden-edit-city', values.city);
  typeInto(container, 'kunden-edit-email', values.email);
  typeInto(container, 'kunden-edit-phone', values.phone);
}

function click(container: HTMLElement, testId: string): void {
  const element = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
  expect(element).not.toBeNull();
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector(
    '[data-testid="kunden-edit-save"]',
  ) as HTMLButtonElement;
  expect(button).not.toBeNull();
  return button;
}

function cancelButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-testid="kunden-edit-cancel"]') as HTMLButtonElement;
}

/**
 * Triggers a save and awaits the release microtask the page schedules, inside
 * the same act — no timers, no arbitrary delay, no nested synchronous act.
 */
async function saveAndSettle(container: HTMLElement): Promise<void> {
  const button = saveButton(container);
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function openForm(container: HTMLElement): void {
  expect(container.querySelector('[data-testid="kunden-edit-action"]')).not.toBeNull();
  click(container, 'kunden-edit-action');
  expect(container.querySelector('[data-testid="kunden-edit-form"]')).not.toBeNull();
}

function customerFields(customer: Customer): CustomerBilling {
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
    id: 'inv-05a',
    number: 'R-2026-050',
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

function vorgangFixture(customer: Customer): Vorgang {
  return createTestVorgang({
    id: 'v-05a',
    title: 'Dachsanierung',
    customer: SOURCE.name,
    customerId: customer.id,
    customerBilling: { ...SOURCE },
    invoices: [invoiceFixture()],
  });
}

describe('CUSTOMER-FACHOBJEKT-05A', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCustomerStore([]);
    hydrateVorgangStore([]);
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
    navTarget = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Fall A — Customer mit Vorgang vollständig bearbeiten', async () => {
    const customer = seedCustomer({}, { createdFromInboxId: 'inbox-05a' });
    expect(customer.id).toBeTruthy();
    // Provenienz positiv gesetzt — kein Vergleich undefined gegen undefined.
    expect(customer.createdFromInboxId).toBe('inbox-05a');
    const vorgang = vorgangFixture(customer);
    hydrateVorgangStore([vorgang]);

    // Positive Vorbedingungen.
    const beforeVorgang = getVorgangById('v-05a')!;
    expect(beforeVorgang).toBeDefined();
    expect(beforeVorgang.customerBilling).toEqual(SOURCE);
    expect(beforeVorgang.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);

    const view = mountCustomer(customer.id);
    const { container } = view;
    expect(container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();
    expect(container.textContent).toContain(SOURCE.contactPerson);

    openForm(container);
    fillAll(container, NEXT);

    // Vor dem Speichern ist der Store unverändert und kein Erfolgstext sichtbar.
    expect(customerFields(getCustomerById(customer.id)!)).toEqual(SOURCE);
    expect(toastText(container)).toBeNull();

    await saveAndSettle(container);

    // Erfolgstoast erst nach erfolgreicher Persistierung.
    expect(toastText(container)).toContain(SUCCESS_TOAST);

    // Formular geschlossen, Lesemodus zeigt die neuen Werte.
    expect(container.querySelector('[data-testid="kunden-edit-form"]')).toBeNull();
    expect(container.querySelector('[data-testid="kunden-edit-error"]')).toBeNull();
    expect(container.querySelector('h1')!.textContent).toBe(NEXT.name);
    expect(container.textContent).toContain(NEXT.contactPerson);
    expect(container.textContent).toContain('Ruhrallee 5, 44787 Bochum');
    expect(container.textContent).not.toContain(customer.id);

    const saved = getCustomerById(customer.id)!;
    expect(customerFields(saved)).toEqual(NEXT);
    expect(saved.id).toBe(customer.id);
    expect(saved.createdAt).toBe(customer.createdAt);
    expect(saved.createdFromInboxId).toBe('inbox-05a');

    // Vorgang und Rechnung bleiben vollständig unverändert.
    const afterVorgang = getVorgangById('v-05a')!;
    expect(afterVorgang.customer).toBe(SOURCE.name);
    expect(afterVorgang.customerId).toBe(customer.id);
    expect(afterVorgang.customerBilling).toEqual(SOURCE);
    expect(afterVorgang.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);

    view.unmount();
  });

  it('Fall B — Customer ohne Vorgang bearbeiten', async () => {
    const customer = seedCustomer({ name: 'Ohne Vorgang GmbH' });
    hydrateVorgangStore([]);

    const view = mountCustomer(customer.id);
    const { container } = view;
    expect(container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-vorgang-v-05a"]')).toBeNull();

    openForm(container);
    typeInto(container, 'kunden-edit-city', 'Dortmund');
    await saveAndSettle(container);

    expect(container.querySelector('[data-testid="kunden-edit-form"]')).toBeNull();
    expect(getCustomerById(customer.id)!.city).toBe('Dortmund');
    // Es entsteht kein Vorgang, der leere Arbeitsbereich bleibt gültig.
    expect(getVorgangById('v-05a')).toBeUndefined();
    expect(container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();

    view.unmount();
  });

  it('Fall C — gleichnamige Customer bleiben getrennt', async () => {
    const a = seedCustomer();
    const b = seedCustomer({ street: 'Seeufer 9', zip: '88131', city: 'Lindau' });
    expect(a.id).not.toBe(b.id);
    const bBefore = getCustomerById(b.id)!;

    const view = mountCustomer(a.id);
    const { container } = view;
    openForm(container);
    fillAll(container, NEXT);
    await saveAndSettle(container);

    expect(customerFields(getCustomerById(a.id)!)).toEqual(NEXT);
    expect(getCustomerById(b.id)).toEqual(bBefore);
    expect(container.textContent).not.toContain(a.id);
    expect(container.textContent).not.toContain(b.id);

    view.unmount();
  });

  it('Fall D — Validierungsfehler blockieren ohne Persistenz', async () => {
    const customer = seedCustomer();
    const before = getCustomerById(customer.id)!;
    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    const view = mountCustomer(customer.id);
    const { container } = view;

    // Leerer Name.
    openForm(container);
    typeInto(container, 'kunden-edit-name', '   ');
    typeInto(container, 'kunden-edit-city', 'Bochum');
    await saveAndSettle(container);

    expect(container.querySelector('[data-testid="kunden-edit-form"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-edit-error"]')!.textContent).toBe(
      'Kundenname erforderlich.',
    );
    expect(
      (container.querySelector('[data-testid="kunden-edit-city"]') as HTMLInputElement).value,
    ).toBe('Bochum');
    expect(getCustomerById(customer.id)).toEqual(before);
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(toastText(container)).toBeNull();
    // Nach der Freigabe wieder bedienbar.
    expect(saveButton(container).disabled).toBe(false);
    expect(cancelButton(container).disabled).toBe(false);

    // Eigene Firma.
    typeInto(container, 'kunden-edit-name', OWN);
    await saveAndSettle(container);

    expect(container.querySelector('[data-testid="kunden-edit-form"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-edit-error"]')!.textContent).toBe(
      'Eigene Firma kann nicht als Kunde angelegt werden.',
    );
    expect(
      (container.querySelector('[data-testid="kunden-edit-name"]') as HTMLInputElement).value,
    ).toBe(OWN);
    expect(getCustomerById(customer.id)).toEqual(before);
    expect(setItemSpy).not.toHaveBeenCalled();
    // Kein Erfolgstoast in einem Validierungsfehler.
    expect(toastText(container)).toBeNull();

    view.unmount();
  });

  it('Fall E — Persistenzfehler rollt zurück und hält das Formular offen', async () => {
    const customer = seedCustomer();
    hydrateVorgangStore([vorgangFixture(customer)]);
    const before = getCustomerById(customer.id)!;
    const vorgangBefore = getVorgangById('v-05a')!;

    const view = mountCustomer(customer.id);
    const { container } = view;
    openForm(container);
    fillAll(container, NEXT);

    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    // Zwei Submits unmittelbar nacheinander — dazwischen kein await, kein Flush.
    const form = container.querySelector('[data-testid="kunden-edit-form"]') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      // Erst nach beiden Ereignissen die Freigabe-Microtask abwarten.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Der erste Versuch bricht beim ersten setItem ab — der zweite Submit lief nie.
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="kunden-edit-form"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-edit-error"]')!.textContent).toBe(
      'Speichern fehlgeschlagen. Es wurde nichts geändert.',
    );
    expect(
      (container.querySelector('[data-testid="kunden-edit-street"]') as HTMLInputElement).value,
    ).toBe(NEXT.street);
    expect(getCustomerById(customer.id)).toEqual(before);

    const vorgangAfter = getVorgangById('v-05a')!;
    expect(vorgangAfter.customerBilling).toEqual(vorgangBefore.customerBilling);
    expect(vorgangAfter.invoices[0]!.customerSnapshot).toEqual(INVOICE_SNAPSHOT);
    expect(toastText(container)).toBeNull();

    // Nach der Freigabe sind beide Schaltflächen wieder aktiv — keine Dauerverriegelung.
    expect(saveButton(container).disabled).toBe(false);
    expect(cancelButton(container).disabled).toBe(false);

    // Keine dauerhafte Verriegelung: nach Freigabe ist ein korrigierter Versuch möglich.
    setItemSpy.mockRestore();
    await saveAndSettle(container);
    expect(container.querySelector('[data-testid="kunden-edit-form"]')).toBeNull();
    expect(customerFields(getCustomerById(customer.id)!)).toEqual(NEXT);
    expect(toastText(container)).toContain(SUCCESS_TOAST);

    view.unmount();
  });

  it('Fall G — Wechsel der Customer-ID im selben React-Root setzt den Editierzustand zurück', async () => {
    const a = seedCustomer();
    const b = seedCustomer({
      name: 'Rheinbau Partner GmbH',
      contactPerson: 'Herr Rhein',
      street: 'Seeufer 9',
      zip: '88131',
      city: 'Lindau',
    });
    expect(a.id).not.toBe(b.id);
    const bBefore = getCustomerById(b.id)!;

    const view = mountCustomer(a.id);
    const { container } = view;
    expect(container.querySelector('h1')!.textContent).toBe(SOURCE.name);

    // A: Formular offen, abweichender Wert, sichtbarer Validierungsfehler.
    openForm(container);
    typeInto(container, 'kunden-edit-street', 'Nur bei A eingetippt');
    typeInto(container, 'kunden-edit-name', '   ');
    await saveAndSettle(container);
    expect(container.querySelector('[data-testid="kunden-edit-error"]')).not.toBeNull();

    // Echte Router-Navigation im selben React-Root.
    navTarget = `/kunden/customer/${b.id}`;
    click(container, 'test-navigate');

    expect(container.querySelector('h1')!.textContent).toBe('Rheinbau Partner GmbH');
    expect(container.textContent).toContain('Herr Rhein');
    expect(container.querySelector('[data-testid="kunden-edit-form"]')).toBeNull();
    expect(container.querySelector('[data-testid="kunden-edit-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="kunden-edit-action"]')).not.toBeNull();
    expect(container.textContent).not.toContain(a.id);
    expect(container.textContent).not.toContain(b.id);

    // B lädt die eigenen Stammwerte, nichts von A.
    openForm(container);
    expect(
      (container.querySelector('[data-testid="kunden-edit-name"]') as HTMLInputElement).value,
    ).toBe('Rheinbau Partner GmbH');
    expect(
      (container.querySelector('[data-testid="kunden-edit-street"]') as HTMLInputElement).value,
    ).toBe('Seeufer 9');
    expect(getCustomerById(b.id)).toEqual(bBefore);
    expect(getCustomerById(a.id)).toEqual(a);

    view.unmount();
  });

  it('Fall F — Abbrechen verwirft die Eingaben ohne Persistenz', () => {
    const customer = seedCustomer();
    const before = getCustomerById(customer.id)!;

    const view = mountCustomer(customer.id);
    const { container } = view;
    openForm(container);
    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    fillAll(container, NEXT);
    click(container, 'kunden-edit-cancel');

    expect(setItemSpy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="kunden-edit-form"]')).toBeNull();
    expect(getCustomerById(customer.id)).toEqual(before);
    expect(container.querySelector('h1')!.textContent).toBe(SOURCE.name);
    expect(container.textContent).toContain('Hafenstraße 12, 45356 Essen');

    view.unmount();
  });
});
