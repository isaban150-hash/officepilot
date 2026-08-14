/**
 * CUSTOMER-FACHOBJEKT-04B — explicit customer decision in the Vorgang dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { InboxVorgangPanel } from './InboxVorgangPanel';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { createCustomer } from '../../services/customerService';
import {
  getCustomerStoreSnapshot,
  hydrateCustomerStore,
} from '../../services/customerStoreService';
import { getInboxItemById, hydrateInboxStore } from '../../services/inboxService';
import * as intakeWorkflowService from '../../services/intakeWorkflowService';
import {
  getAllVorgaenge,
  getVorgangCardMode,
  hydrateVorgangStore,
} from '../../services/vorgangService';
import { createAuftragInboxItem, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { InboxItem, Vorgang } from '../../types/models';

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
const RHEINBAU = 'Rheinbau Partner GmbH';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

type Mount = { container: HTMLDivElement; root: Root };

function seedItem(overrides: Partial<InboxItem> = {}): InboxItem {
  const item = createAuftragInboxItem({
    id: 'inbox-04b',
    sender: RHEINBAU,
    recognizedData: { Kunde: RHEINBAU },
    ...overrides,
  });
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

async function mountPanel(item: InboxItem): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(InboxVorgangPanel, {
            item,
            materialDefault: 'betrieb' as const,
            onLinked: () => {},
          }),
        ),
      ),
    );
  });
  return { container, root };
}

function unmount(mount: Mount) {
  act(() => mount.root.unmount());
  mount.container.remove();
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error('element missing');
  await act(async () => {
    (element as HTMLElement).click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** Opens the dialog via the panel's primary button. */
async function openDialog(mount: Mount): Promise<void> {
  const button = mount.container.querySelector('.vorgang-panel button');
  await click(button);
}

function createButton(mount: Mount): HTMLButtonElement {
  const button = mount.container.querySelector(
    '[data-testid="vorgang-dialog-create"]',
  ) as HTMLButtonElement | null;
  if (!button) throw new Error('create button missing');
  return button;
}

function selectMode(mount: Mount, mode: 'new' | 'existing' | 'none'): Promise<void> {
  const input = mount.container.querySelector(
    `[data-testid="customer-decision-${mode}"] input`,
  );
  return click(input);
}

const EXTRA_FIELDS = ['contactPerson', 'street', 'zip', 'city', 'email', 'phone'] as const;

/** Types into a controlled input like a user would. */
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

function customerPreview(mount: Mount): string {
  const rows = Array.from(mount.container.querySelectorAll('.vorgang-dialog__preview .data-row'));
  return rows[1]?.textContent ?? '';
}

describe('CUSTOMER-FACHOBJEKT-04B', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
  });

  afterEach(() => {
    resetTestStores();
    localStorage.clear();
  });

  it('Fall A — ohne Auswahl ist Erstellen gesperrt', async () => {
    const mount = await mountPanel(seedItem());
    await openDialog(mount);

    expect(mount.container.querySelector('[data-testid="customer-decision-choice"]')).toBeTruthy();
    expect(createButton(mount).disabled).toBe(true);
    expect(getAllVorgaenge()).toHaveLength(0);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    unmount(mount);
  });

  it('Fall B — neuer Customer entsteht genau einmal', async () => {
    const item = seedItem({ sender: NORDWEST.name, recognizedData: { Kunde: NORDWEST.name } });
    const mount = await mountPanel(item);
    await openDialog(mount);
    await selectMode(mount, 'new');

    expect(createButton(mount).disabled).toBe(false);
    await click(createButton(mount));

    const customers = getCustomerStoreSnapshot();
    const vorgaenge = getAllVorgaenge();
    expect(customers).toHaveLength(1);
    expect(vorgaenge).toHaveLength(1);
    expect(customers[0]!.name).toBe(NORDWEST.name);
    expect(vorgaenge[0]!.customerId).toBe(customers[0]!.id);
    expect(vorgaenge[0]!.customer).toBe(NORDWEST.name);
    unmount(mount);
  });

  it('Fall C — bestehender Customer per ID, kein zweiter Customer', async () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;

    const mount = await mountPanel(seedItem());
    await openDialog(mount);
    await selectMode(mount, 'existing');
    expect(createButton(mount).disabled).toBe(true);

    await click(
      mount.container.querySelector(`[data-testid="customer-option-${created.customer.id}"] input`),
    );
    expect(createButton(mount).disabled).toBe(false);
    await click(createButton(mount));

    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    const vorgang = getAllVorgaenge()[0]!;
    expect(vorgang.customerId).toBe(created.customer.id);
    expect(vorgang.customer).toBe(NORDWEST.name);
    unmount(mount);
  });

  it('Fall D — gleichnamige Customers werden getrennt dargestellt', async () => {
    const first = createCustomer({ ...NORDWEST, street: 'Hafenstraße 12', city: 'Essen' });
    const second = createCustomer({ ...NORDWEST, street: 'Ruhrallee 5', city: 'Bochum' });
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;

    const mount = await mountPanel(seedItem());
    await openDialog(mount);
    await selectMode(mount, 'existing');

    const options = mount.container.querySelectorAll('[data-testid^="customer-option-"]');
    expect(options).toHaveLength(2);
    const listText = mount.container.querySelector(
      '[data-testid="customer-decision-list"]',
    )!.textContent!;
    expect(listText).toContain('Hafenstraße 12, 45356 Essen');
    expect(listText).toContain('Ruhrallee 5, 45356 Bochum');
    // Technische IDs bleiben unsichtbar.
    expect(listText).not.toContain(first.customer.id);
    expect(listText).not.toContain(second.customer.id);

    await click(
      mount.container.querySelector(`[data-testid="customer-option-${second.customer.id}"] input`),
    );
    await click(createButton(mount));

    const vorgang = getAllVorgaenge()[0]!;
    expect(vorgang.customerId).toBe(second.customer.id);
    expect(vorgang.customerBilling?.city).toBe('Bochum');
    unmount(mount);
  });

  it('Fall E — Vorschau zeigt den gewählten Customer, nicht den Dokumentnamen', async () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;

    const mount = await mountPanel(seedItem());
    await openDialog(mount);
    expect(customerPreview(mount)).toContain(RHEINBAU);

    await selectMode(mount, 'existing');
    await click(
      mount.container.querySelector(`[data-testid="customer-option-${created.customer.id}"] input`),
    );

    expect(customerPreview(mount)).toContain(NORDWEST.name);
    expect(customerPreview(mount)).not.toContain(RHEINBAU);

    await click(createButton(mount));
    expect(getAllVorgaenge()[0]!.customer).toBe(NORDWEST.name);
    unmount(mount);
  });

  it('Fall F — none speichert den Dokumentnamen nicht', async () => {
    const mount = await mountPanel(seedItem());
    await openDialog(mount);
    await selectMode(mount, 'none');

    expect(customerPreview(mount)).toContain('Kunde noch nicht bekannt');
    const input = mount.container.querySelector(
      '[data-testid="vorgang-dialog-customer-input"]',
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);

    await click(createButton(mount));

    const vorgang = getAllVorgaenge()[0]!;
    expect(vorgang.customer).toBe('');
    expect(vorgang.customerId).toBeUndefined();
    expect(vorgang.customerExplicitlyUnknown).toBe(true);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    unmount(mount);
  });

  it('Fall G — eigene Firma sperrt den Erstellen-Button', async () => {
    const item = seedItem({ sender: OWN, recognizedData: { Kunde: OWN } });
    const mount = await mountPanel(item);
    await openDialog(mount);
    await selectMode(mount, 'new');

    const input = mount.container.querySelector(
      '[data-testid="vorgang-dialog-customer-input"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, OWN);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(createButton(mount).disabled).toBe(true);
    await click(createButton(mount));
    expect(
      mount.container.querySelector('[data-testid="customer-decision-hint"]')?.textContent,
    ).toContain('Eigene Firma kann nicht als Kunde angelegt werden');
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getAllVorgaenge()).toHaveLength(0);
    unmount(mount);
  });

  it('Fall H — leerer Name sperrt den Erstellen-Button', async () => {
    const mount = await mountPanel(seedItem());
    await openDialog(mount);
    await selectMode(mount, 'new');

    const input = mount.container.querySelector(
      '[data-testid="vorgang-dialog-customer-input"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, '   ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(createButton(mount).disabled).toBe(true);
    await click(createButton(mount));
    expect(
      mount.container.querySelector('[data-testid="customer-decision-hint"]')?.textContent,
    ).toContain('Kundenname erforderlich');
    expect(getAllVorgaenge()).toHaveLength(0);
    unmount(mount);
  });

  it('Fall I — verschwundener Customer erzeugt keinen Vorgang', async () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;

    const mount = await mountPanel(seedItem());
    await openDialog(mount);
    await selectMode(mount, 'existing');
    await click(
      mount.container.querySelector(`[data-testid="customer-option-${created.customer.id}"] input`),
    );

    // Der Customer verschwindet nach der Auswahl, vor dem Klick.
    hydrateCustomerStore([]);
    await click(createButton(mount));

    expect(getAllVorgaenge()).toHaveLength(0);
    expect(getInboxItemById('inbox-04b')?.vorgangId).toBeUndefined();
    const hint = mount.container.querySelector('[data-testid="customer-decision-hint"]');
    expect(hint?.textContent).toContain('nicht mehr vorhanden');
    // Dialog bleibt offen.
    expect(mount.container.querySelector('[data-testid="customer-decision-choice"]')).toBeTruthy();
    unmount(mount);
  });

  it('Fall J — erneutes Öffnen setzt die Auswahl zurück', async () => {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;

    const mount = await mountPanel(seedItem());
    await openDialog(mount);
    await selectMode(mount, 'existing');
    await click(
      mount.container.querySelector(`[data-testid="customer-option-${created.customer.id}"] input`),
    );
    expect(createButton(mount).disabled).toBe(false);

    // Schließen über den Backdrop, danach erneut öffnen.
    await click(mount.container.querySelector('.vorgang-dialog-backdrop'));
    await openDialog(mount);

    expect(createButton(mount).disabled).toBe(true);
    for (const mode of ['new', 'existing', 'none']) {
      const radio = mount.container.querySelector(
        `[data-testid="customer-decision-${mode}"] input`,
      ) as HTMLInputElement;
      expect(radio.checked, mode).toBe(false);
    }
    expect(mount.container.querySelector('[data-testid="customer-decision-list"]')).toBeNull();
    unmount(mount);
  });

  it('Fall K — Link-Modus zeigt keine Customer-Auswahl', async () => {
    const existing: Vorgang = createTestVorgang({
      id: 'v-04b',
      customer: NORDWEST.name,
      customerId: 'cust-04b-fixed',
    });
    hydrateVorgangStore([existing]);
    // 'eingangsrechnung' → primaryTarget 'expense', zusammen mit 'zuordnen' ergibt das
    // den link-Modus (der create-Zweig prüft primaryTarget 'vorgang' bzw. 'auftrag_annehmen').
    const item = seedItem({
      documentType: 'eingangsrechnung',
      recommendedAction: 'zuordnen',
    });
    expect(getVorgangCardMode(item)).toBe('link');

    const mount = await mountPanel(item);
    await openDialog(mount);

    expect(mount.container.querySelector('[data-testid="customer-decision-choice"]')).toBeNull();
    expect(mount.container.querySelector('[data-testid="vorgang-dialog-create"]')).toBeNull();

    const linkButton = Array.from(mount.container.querySelectorAll('.vorgang-dialog__actions button'))
      .find((b) => b.textContent?.includes('bestehendem'));
    await click(linkButton!);

    const after = getAllVorgaenge().find((v) => v.id === 'v-04b')!;
    expect(after.customer).toBe(NORDWEST.name);
    expect(after.customerId).toBe('cust-04b-fixed');
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    unmount(mount);
  });

  it('Fall L — 05C: Neuanlage mit allen sieben Feldern', async () => {
    const item = seedItem({ sender: NORDWEST.name, recognizedData: { Kunde: NORDWEST.name } });
    const mount = await mountPanel(item);
    await openDialog(mount);
    await selectMode(mount, 'new');

    // Alle sechs Zusatzfelder sind direkt sichtbar und starten leer.
    for (const field of EXTRA_FIELDS) {
      expect(extraFieldValue(mount, field), field).toBe('');
    }
    expect(
      mount.container.querySelector('[data-testid="customer-decision-optional-hint"]')!.textContent,
    ).toBe('Nur der Kundenname ist erforderlich. Die übrigen Angaben sind optional.');

    await fillExtraFields(mount);
    // Tippen persistiert nichts.
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getAllVorgaenge()).toHaveLength(0);

    await click(createButton(mount));

    const customers = getCustomerStoreSnapshot();
    expect(customers).toHaveLength(1);
    const customer = customers[0]!;
    expect(customer.name).toBe(NORDWEST.name);
    expect(customer.contactPerson).toBe(NORDWEST.contactPerson);
    expect(customer.street).toBe(NORDWEST.street);
    expect(customer.zip).toBe(NORDWEST.zip);
    expect(customer.city).toBe(NORDWEST.city);
    expect(customer.email).toBe(NORDWEST.email);
    expect(customer.phone).toBe(NORDWEST.phone);
    // Provenienz positiv auf die konkrete Inbox-ID.
    expect(customer.createdFromInboxId).toBe('inbox-04b');

    const vorgang = getAllVorgaenge()[0]!;
    expect(vorgang.customerId).toBe(customer.id);
    expect(vorgang.customer).toBe(NORDWEST.name);
    expect(vorgang.customerBilling).toEqual({
      name: NORDWEST.name,
      contactPerson: NORDWEST.contactPerson,
      street: NORDWEST.street,
      zip: NORDWEST.zip,
      city: NORDWEST.city,
      email: NORDWEST.email,
      phone: NORDWEST.phone,
    });
    expect(mount.container.textContent).not.toContain(customer.id);
    unmount(mount);
  });

  it('Fall M — 05C: nur Name bleibt möglich, existing und none ignorieren die Felder', async () => {
    const item = seedItem({ sender: NORDWEST.name, recognizedData: { Kunde: NORDWEST.name } });
    const mount = await mountPanel(item);
    await openDialog(mount);
    await selectMode(mount, 'new');
    await click(createButton(mount));

    const onlyName = getCustomerStoreSnapshot()[0]!;
    expect(onlyName.name).toBe(NORDWEST.name);
    expect(onlyName.street).toBe('');
    expect(onlyName.city).toBe('');
    expect(onlyName.phone).toBe('');
    expect(getAllVorgaenge()[0]!.customerBilling).toEqual({
      name: NORDWEST.name,
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    });
    unmount(mount);

    // Zweites Item: lokale Felder ausfüllen, dann auf existing wechseln.
    resetTestStores();
    localStorage.clear();
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
    const existing = createCustomer({ ...NORDWEST, name: RHEINBAU, city: 'Köln' });
    expect(existing.success).toBe(true);
    if (!existing.success) return;

    const mount2 = await mountPanel(seedItem());
    await openDialog(mount2);
    await selectMode(mount2, 'new');
    await fillExtraFields(mount2);
    await selectMode(mount2, 'existing');
    await click(
      mount2.container.querySelector(`[data-testid="customer-option-${existing.customer.id}"] input`),
    );
    await click(createButton(mount2));

    // Kein zweiter Customer, Snapshot stammt aus dem gewählten Stamm.
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    const vorgangExisting = getAllVorgaenge()[0]!;
    expect(vorgangExisting.customerId).toBe(existing.customer.id);
    expect(vorgangExisting.customerBilling!.city).toBe('Köln');
    expect(vorgangExisting.customerBilling!.street).toBe(NORDWEST.street);
    expect(vorgangExisting.customer).toBe(RHEINBAU);
    unmount(mount2);

    // Drittes Item: none erzeugt keinen Customer aus den lokalen Feldern.
    resetTestStores();
    localStorage.clear();
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
    const mount3 = await mountPanel(seedItem());
    await openDialog(mount3);
    await selectMode(mount3, 'new');
    await fillExtraFields(mount3);
    await selectMode(mount3, 'none');
    await click(createButton(mount3));

    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    const vorgangNone = getAllVorgaenge()[0]!;
    expect(vorgangNone.customer).toBe('');
    expect(vorgangNone.customerExplicitlyUnknown).toBe(true);
    expect(vorgangNone.customerBilling).toEqual({
      name: '',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    });
    unmount(mount3);
  });

  it('Fall N — 05C: erneutes Öffnen leert die Zusatzfelder', async () => {
    const mount = await mountPanel(seedItem());
    await openDialog(mount);
    await selectMode(mount, 'new');
    await fillExtraFields(mount);
    expect(extraFieldValue(mount, 'street')).toBe(NORDWEST.street);

    await click(mount.container.querySelector('.vorgang-dialog-backdrop'));
    await openDialog(mount);
    await selectMode(mount, 'new');

    for (const field of EXTRA_FIELDS) {
      expect(extraFieldValue(mount, field), field).toBe('');
    }
    expect(mount.container.querySelector('[data-testid="customer-decision-hint"]')).toBeNull();
    unmount(mount);
  });

  it('Fall O — 05C: zwei unmittelbare Klicks erzeugen genau einen Serviceaufruf', async () => {
    const spy = vi.spyOn(intakeWorkflowService, 'createVorgangFromInboxWithContract');
    const item = seedItem({ sender: NORDWEST.name, recognizedData: { Kunde: NORDWEST.name } });
    const mount = await mountPanel(item);
    await openDialog(mount);
    await selectMode(mount, 'new');
    await fillExtraFields(mount);

    const button = createButton(mount);
    // Zwei Ereignisse im selben Turn, dazwischen kein Await und kein Flush.
    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
    expect(getAllVorgaenge()).toHaveLength(1);
    spy.mockRestore();
    unmount(mount);
  });

  it('Fall P — 05C: nach einem Fehler bleibt der Retry möglich', async () => {
    const item = seedItem({ sender: NORDWEST.name, recognizedData: { Kunde: NORDWEST.name } });
    const mount = await mountPanel(item);
    await openDialog(mount);
    await selectMode(mount, 'new');
    await fillExtraFields(mount);

    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    await click(createButton(mount));
    setItemSpy.mockRestore();

    // Sperre ist nach der Microtask wieder frei; Eingaben stehen weiterhin.
    const button = createButton(mount);
    expect(button.disabled).toBe(false);
    expect(extraFieldValue(mount, 'street')).toBe(NORDWEST.street);
    unmount(mount);
  });
});
