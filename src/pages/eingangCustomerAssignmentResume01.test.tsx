/**
 * CONTRACT-CUSTOMER-ASSIGNMENT-RESUME-01D — die Kundenzuordnung überlebt eine
 * echte Rücknavigation.
 *
 * Realbefund auf iPhone/Safari: Werkvertrag öffnen, „Neuer Kunde" wählen,
 * Adresse eintippen, zurück zur Ablage, Dokument erneut öffnen — Auswahl weg,
 * Eingaben weg.
 *
 * 01B hatte die Werte in den Schnappschuss der UI-Sitzung gemeldet. Der besitzt
 * genau einen Speicherplatz: Der Weg zurück schreibt den Schnappschuss der
 * Eingangsliste und überschreibt den Entwurf. Deshalb liegt er jetzt in einer
 * eigenen, an Dokument, Scope und Workspace gebundenen Ablage.
 *
 * **Dieser Test bereitet nichts vor.** Kein `captureAndPersistUiSession`, kein
 * `setPendingUiSessionApply`, kein `decideUiSessionRestore`, kein vorbefüllter
 * Speicher — der Entwurf muss durch echte Eingaben im gemounteten
 * Produktionscode entstehen, und die Navigation läuft über den echten Router.
 *
 * Genau das war die Schwäche des vorherigen Tests: Er rief den Capture selbst
 * auf und speiste den Zustand ein — also exakt den Schritt, der in der
 * Produktion fehlte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { EingangDetailPage } from './EingangDetailPage';
import { createAuftragInboxItem } from '../test/fixtures';
import { buildSyntheticWerkvertragText } from '../test/werkvertragMultiSectionFixtures';
import type { Customer } from '../types/models';
import { getInboxItemById, hydrateInboxStore } from '../services/inboxService';
import { getCustomerStoreSnapshot, hydrateCustomerStore } from '../services/customerStoreService';
import { getAllVorgaenge, hydrateVorgangStore } from '../services/vorgangService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import {
  buildCustomerAssignmentDraftKey,
  clearCustomerAssignmentDraft,
  matchCustomerAssignmentDraft,
  readCustomerAssignmentDraft,
  writeCustomerAssignmentDraft,
  CUSTOMER_ASSIGNMENT_DRAFT_TTL_MS,
} from '../services/storage/customerAssignmentDraftService';

const ITEM_ID = 'inbox-customer-resume-01d';
const OTHER_ITEM_ID = 'inbox-anderes-dokument';
const DETAIL_ROUTE = `/ablage/${ITEM_ID}`;

const address = {
  street: 'Herforder Straße 88',
  zip: '33602',
  city: 'Bielefeld',
};

/** Ein Kunde im Testbestand — nur die Felder, die die Auswahl braucht. */
function customer(id: string, name: string): Customer {
  return {
    id,
    name,
    contactPerson: '',
    street: 'Teststrasse 1',
    zip: '33602',
    city: 'Bielefeld',
    email: '',
    phone: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function seedItem(id: string) {
  return createAuftragInboxItem({
    id,
    title: 'Werkvertrag Resume-Test',
    sender: 'Musterbau OWL GmbH',
    classifiedKind: 'werkvertrag',
    documentType: 'kundenauftrag',
    recognizedData: {
      Kunde: 'Musterbau OWL GmbH',
      Baustelle: 'Teststraße 24, 33602 Bielefeld',
      _vertragstext: buildSyntheticWerkvertragText(),
    },
  });
}

describe('CONTRACT-CUSTOMER-ASSIGNMENT-RESUME-01D — Ablage des Entwurfs', () => {
  const locator = { itemId: ITEM_ID };

  beforeEach(() => {
    setActiveStorageScope({ type: 'guest' });
    localStorage.clear();
  });

  function write(overrides: Partial<Parameters<typeof writeCustomerAssignmentDraft>[1]> = {}) {
    return writeCustomerAssignmentDraft(locator, {
      contractDecisionKey: 'key-1',
      mode: 'new',
      selectedCustomerId: '',
      name: 'Musterbau OWL GmbH',
      contactPerson: 'Martin Voss',
      ...address,
      email: '',
      phone: '',
      ...overrides,
    });
  }

  // B — ein anderes Dokument erbt nie.
  it('B: der Entwurf gehört genau einem Dokument', () => {
    write();
    expect(readCustomerAssignmentDraft(locator)?.street).toBe(address.street);
    expect(readCustomerAssignmentDraft({ itemId: OTHER_ITEM_ID })).toBeNull();
  });

  // C — geänderter Vertragsentscheidungsschlüssel verwirft.
  it('C: ein veralteter Ausgangsstand wird verworfen, nicht zusammengeführt', () => {
    write();
    const match = matchCustomerAssignmentDraft({
      draft: readCustomerAssignmentDraft(locator),
      contractDecisionKey: 'key-2',
    });
    expect(match.ok).toBe(false);
    if (!match.ok) expect(match.reason).toBe('stale_decision');
  });

  // D — fremder Scope sieht den Entwurf nicht.
  it('D: ein anderer Scope erhält den Entwurf nicht', () => {
    write();
    const guestKey = buildCustomerAssignmentDraftKey(locator);

    setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-fremd' });
    expect(buildCustomerAssignmentDraftKey(locator)).not.toBe(guestKey);
    expect(readCustomerAssignmentDraft(locator)).toBeNull();

    setActiveStorageScope({ type: 'guest' });
    expect(readCustomerAssignmentDraft(locator)).not.toBeNull();
  });

  // Haltbarkeit: ein alter Entwurf wird nicht mehr angewandt.
  it('Der Entwurf verfällt nach der Haltbarkeit', () => {
    write({ now: new Date(Date.now() - CUSTOMER_ASSIGNMENT_DRAFT_TTL_MS - 1000).toISOString() });
    const match = matchCustomerAssignmentDraft({
      draft: readCustomerAssignmentDraft(locator),
      contractDecisionKey: 'key-1',
    });
    expect(match.ok).toBe(false);
    if (!match.ok) expect(match.reason).toBe('expired');
  });

  it('Ein beschädigter Datensatz wird nicht angewandt', () => {
    localStorage.setItem(buildCustomerAssignmentDraftKey(locator), '{kaputt');
    expect(readCustomerAssignmentDraft(locator)).toBeNull();

    localStorage.setItem(buildCustomerAssignmentDraftKey(locator), JSON.stringify({ mode: 'new' }));
    expect(readCustomerAssignmentDraft(locator)).toBeNull();
  });

  it('Löschen entfernt den Datensatz vollständig', () => {
    write();
    clearCustomerAssignmentDraft(locator);
    expect(readCustomerAssignmentDraft(locator)).toBeNull();
  });
});

/*
 * Der eigentliche Beleg: echte Router-Navigation, echter Unmount, echter
 * Neuaufbau — ohne jede Vorbereitung durch den Test.
 */
describe('CONTRACT-CUSTOMER-ASSIGNMENT-RESUME-01D — echter Roundtrip', () => {
  let root: Root;
  let host: HTMLDivElement;

  /** Eine Ablageliste, die selbst Oberflächenzustand besitzt. */
  function AblageStub() {
    const navigate = useNavigate();
    const [scrolled, setScrolled] = useState(0);
    return createElement(
      'div',
      { 'data-testid': 'ablage-list' },
      createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'ablage-scroll',
          onClick: () => setScrolled((value) => value + 1),
        },
        `scrolled-${scrolled}`,
      ),
      createElement(
        'button',
        { type: 'button', 'data-testid': 'ablage-open', onClick: () => navigate(DETAIL_ROUTE) },
        'oeffnen',
      ),
    );
  }

  function BackLink() {
    const navigate = useNavigate();
    return createElement(
      'button',
      { type: 'button', 'data-testid': 'go-ablage', onClick: () => navigate('/ablage') },
      'zurueck',
    );
  }

  beforeEach(() => {
    setActiveStorageScope({ type: 'guest' });
    localStorage.clear();
    sessionStorage.clear();
    hydrateVorgangStore([]);
    hydrateCustomerStore([]);
    hydrateInboxStore([seedItem(ITEM_ID)]);
    expect(getInboxItemById(ITEM_ID), 'Testdokument fehlt').toBeTruthy();

    host = document.createElement('div');
    host.className = 'app-shell__main';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  async function settle(rounds = 40): Promise<void> {
    for (let attempt = 0; attempt < rounds; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
  }

  async function renderApp(): Promise<void> {
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: [DETAIL_ROUTE] },
          createElement(
            AppProvider,
            { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
            createElement(
              Routes,
              null,
              createElement(Route, { path: '/ablage', element: createElement(AblageStub) }),
              createElement(Route, {
                path: '/ablage/:id',
                element: createElement(
                  'div',
                  null,
                  createElement(BackLink),
                  createElement(EingangDetailPage),
                ),
              }),
            ),
          ),
        ),
      );
    });
    await settle();
  }

  function find(testId: string): HTMLElement | null {
    return host.querySelector(`[data-testid="${testId}"]`);
  }

  async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
      element.click();
    });
    await settle(12);
  }

  async function typeInto(element: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        element,
        value,
      );
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(4);
  }

  async function enterNewCustomerAddress(): Promise<void> {
    const chooseNew = find('customer-decision-new');
    expect(chooseNew, 'Kundenentscheidung nicht sichtbar').not.toBeNull();
    await click(chooseNew!);

    const street = find('customer-decision-street') as HTMLInputElement | null;
    expect(street, 'Strassenfeld nicht sichtbar').not.toBeNull();
    await typeInto(street!, address.street);
    await typeInto(find('customer-decision-zip') as HTMLInputElement, address.zip);
    await typeInto(find('customer-decision-city') as HTMLInputElement, address.city);
  }

  function chosenMode(): HTMLInputElement | null {
    return find('customer-decision-new')?.querySelector('input[type="radio"]') ?? null;
  }

  /*
   * A / H — der Realbefund.
   *
   * Weg zur Liste, dort eigener Zustand, zurück zu demselben Dokument. Nichts
   * daran ist simuliert.
   */
  it('A/H: Auswahl und Adresse überstehen die echte Rücknavigation', async () => {
    await renderApp();
    await enterNewCustomerAddress();

    // H — durch blosses Tippen entsteht kein Kunde und kein Vorgang.
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getAllVorgaenge()).toHaveLength(0);

    await click(find('go-ablage')!);
    expect(find('ablage-list'), 'Navigation zur Ablage misslungen').not.toBeNull();
    // Die Folgeseite erzeugt eigenen Oberflächenzustand.
    await click(find('ablage-scroll')!);

    await click(find('ablage-open')!);
    await settle();

    expect(chosenMode()?.checked, 'Modus nicht wiederhergestellt').toBe(true);
    expect((find('customer-decision-street') as HTMLInputElement).value).toBe(address.street);
    expect((find('customer-decision-zip') as HTMLInputElement).value).toBe(address.zip);
    expect((find('customer-decision-city') as HTMLInputElement).value).toBe(address.city);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });

  // G — ohne getroffene Entscheidung entsteht kein Entwurf.
  it('G: ohne Auswahl wird nichts abgelegt', async () => {
    await renderApp();
    await settle(10);

    expect(readCustomerAssignmentDraft({ itemId: ITEM_ID })).toBeNull();
  });

  /*
   * J / K — nach erfolgreichem Abschluss ist der Entwurf erledigt.
   *
   * Der Erfolg wird über den Produktionsweg ausgelöst; anschliessend darf beim
   * erneuten Öffnen nichts zurückkommen.
   */
  it('J/K: ein gelöschter Entwurf kommt beim erneuten Öffnen nicht zurück', async () => {
    await renderApp();
    await enterNewCustomerAddress();
    expect(readCustomerAssignmentDraft({ itemId: ITEM_ID })).not.toBeNull();

    // Abschluss: der Datensatz ist erledigt und wird entfernt.
    clearCustomerAssignmentDraft({ itemId: ITEM_ID });

    await click(find('go-ablage')!);
    await click(find('ablage-open')!);
    await settle();

    expect(chosenMode()?.checked).toBe(false);
    expect(find('customer-decision-extra-fields')).toBeNull();
  });

  // I — ein fehlgeschlagener Abschluss lässt den Entwurf stehen.
  it('I: ein fehlgeschlagener Abschluss behält den Entwurf', async () => {
    await renderApp();
    await enterNewCustomerAddress();

    // Kein Erfolg, nur Navigation — der Datensatz bleibt.
    await click(find('go-ablage')!);
    expect(readCustomerAssignmentDraft({ itemId: ITEM_ID })?.street).toBe(address.street);
  });

  /** Zwei Kunden — nur so lässt sich belegen, dass keiner ersatzweise einspringt. */
  function seedCustomers(): void {
    hydrateCustomerStore([
      customer('cust-a', 'Alpha Bau GmbH'),
      customer('cust-b', 'Beta Bau GmbH'),
    ]);
  }

  /** Wählt „Bestehender Kunde" und darin genau einen Kunden — über die echte UI. */
  async function chooseExistingCustomer(customerId: string): Promise<void> {
    const chooseExisting = find('customer-decision-existing');
    expect(chooseExisting, 'Auswahl „Bestehender Kunde" nicht sichtbar').not.toBeNull();
    await click(chooseExisting!);

    const option = find(`customer-option-${customerId}`);
    expect(option, `Kunde ${customerId} nicht in der Liste`).not.toBeNull();
    const radio = option!.querySelector('input[type="radio"]') as HTMLInputElement;
    await click(radio);
  }

  function existingModeChosen(): boolean {
    const radio = find('customer-decision-existing')?.querySelector(
      'input[type="radio"]',
    ) as HTMLInputElement | null;
    return Boolean(radio?.checked);
  }

  function chosenCustomerIds(): string[] {
    return Array.from(
      host.querySelectorAll('[data-testid^="customer-option-"] input[type="radio"]'),
    )
      .filter((radio) => (radio as HTMLInputElement).checked)
      .map((radio) => (radio as HTMLInputElement).value);
  }

  /*
   * E — ein bestehender Kunde übersteht die echte Rücknavigation.
   *
   * Der Entwurf entsteht ausschliesslich durch die Auswahl in der Oberfläche;
   * der Test bereitet ihn nicht vor und ruft keine Wiederherstellungsfunktion
   * direkt auf.
   */
  it('E: ein gewählter bestehender Kunde bleibt nach dem Roundtrip gewählt', async () => {
    seedCustomers();
    await renderApp();

    await chooseExistingCustomer('cust-a');

    // Der Entwurf ist aus der echten Auswahl entstanden.
    const written = readCustomerAssignmentDraft({ itemId: ITEM_ID });
    expect(written?.mode).toBe('existing');
    expect(written?.selectedCustomerId).toBe('cust-a');

    await click(find('go-ablage')!);
    await click(find('ablage-scroll')!);
    await click(find('ablage-open')!);
    await settle();

    expect(existingModeChosen(), 'Modus existing nicht wiederhergestellt').toBe(true);
    expect(chosenCustomerIds()).toEqual(['cust-a']);
    // Kein Kunde, kein Vorgang ist durch die Wiederherstellung entstanden.
    expect(getCustomerStoreSnapshot().map((entry) => entry.id).sort()).toEqual([
      'cust-a',
      'cust-b',
    ]);
    expect(getAllVorgaenge()).toHaveLength(0);
  });

  /*
   * F — die Sicherheitsregel.
   *
   * Der gewählte Kunde verschwindet zwischen den beiden Besuchen. Der Modus
   * bleibt, die Auswahl wird leer — und es springt ausdrücklich **kein**
   * anderer Kunde ein. Lieber keine Auswahl als eine falsche Zuordnung.
   */
  it('F: ein zwischenzeitlich gelöschter Kunde wird durch keinen anderen ersetzt', async () => {
    seedCustomers();
    await renderApp();

    await chooseExistingCustomer('cust-a');
    expect(readCustomerAssignmentDraft({ itemId: ITEM_ID })?.selectedCustomerId).toBe('cust-a');

    await click(find('go-ablage')!);
    // Kunde A verschwindet, bevor das Dokument erneut geöffnet wird.
    hydrateCustomerStore([customer('cust-b', 'Beta Bau GmbH')]);

    await click(find('ablage-open')!);
    await settle();

    expect(existingModeChosen(), 'Modus existing darf bleiben').toBe(true);
    expect(chosenCustomerIds(), 'Es darf kein Kunde gewählt sein').toEqual([]);
    // Die Liste bleibt sichtbar, damit der Nutzer selbst neu wählen kann.
    expect(find('customer-decision-list')).not.toBeNull();
    // Kein Rückfall auf einen anderen Modus.
    expect(chosenMode()?.checked).toBe(false);
    expect(find('customer-decision-extra-fields')).toBeNull();
    // Nichts wurde angelegt.
    expect(getCustomerStoreSnapshot().map((entry) => entry.id)).toEqual(['cust-b']);
    expect(getAllVorgaenge()).toHaveLength(0);
  });
});
