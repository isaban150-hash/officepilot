/**
 * ORDER-POSITION-EDIT-DELETE-PERSISTENCE-01B — Ändern und Löschen einer
 * Leistungsposition gelten erst als erfolgt, wenn sie dauerhaft gespeichert sind.
 *
 * Der Add-Pfad wurde in ORDER-POSITION-CREATE-PERSIST-01B repariert; Ändern und
 * Löschen liefen weiterhin über `updateVorgangInStore`, das `persistAll()`
 * aufruft, **dessen Ergebnis aber nicht prüft** und in jedem Fall Erfolg meldet.
 * Damit konnte die Oberfläche eine Änderung als gespeichert zeigen, während im
 * Speicher der alte Stand blieb — nach dem Reload war die Arbeit weg.
 *
 * Geprüft wird deshalb nicht `result.vorgang`, sondern der Zustand nach
 * erneutem Lesen und nach echter Re-Hydrierung aus dem Speicher. Der Fehlerfall
 * wird nicht simuliert, sondern durch ein werfendes `localStorage.setItem`
 * erzeugt — dieselbe Klemme wie im Add-Block.
 *
 * Synthetische Daten, kein Netz, keine echten Testdaten.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { Toast } from './components/ui/Card';
import { AppProvider, useApp } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { OrderPositionForm } from './components/vorgang/OrderPositionForm';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { createTestVorgang } from './test/fixtures';
import {
  getVorgangById,
  hydrateVorgangStore,
  removeOrderPosition,
  updateOrderPosition,
} from './services/vorgangService';
import { hydrateStoresFromStorage, persistAll } from './services/persistenceService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { t } from './i18n';
import type { Vorgang } from './types/models';

const VORGANG_ID = 'v-position-edit-delete-01b';
const POSITION_ID = 'op-test-1';
const ORIGINAL_DESCRIPTION = 'Ursprüngliche Leistung';
const EDITED_DESCRIPTION = 'Geänderte Leistung';

const PERSIST_ERROR = t('order_amendment_local_persist_failed', 'de');
const SAVED_TOAST = t('position.saved', 'de');
const DELETED_TOAST = t('position.deleted', 'de');

let root: Root;
let host: HTMLDivElement;
let savedVorgaenge: Vorgang[];
let closed = false;

function seedVorgang(): Vorgang {
  const vorgang = createTestVorgang({ id: VORGANG_ID });
  delete (vorgang as Partial<Vorgang>).contractConfirmation;
  vorgang.orderPositions = vorgang.orderPositions.map((position) => ({
    ...position,
    id: POSITION_ID,
    description: ORIGINAL_DESCRIPTION,
  }));
  return vorgang;
}

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  savedVorgaenge = [];
  closed = false;
  hydrateVorgangStore([seedVorgang()]);
  expect(persistAll().success, 'Ausgangsstand liess sich nicht speichern').toBe(true);
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  localStorage.clear();
});

async function settle(rounds = 10): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function failLocalStorage(): void {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('QuotaExceededError', 'QuotaExceededError');
  });
}

/** Der Neustart der App: derselbe Weg, den auch der Seitenaufbau geht. */
function reloadFromStorage(): void {
  hydrateVorgangStore([]);
  expect(getVorgangById(VORGANG_ID), 'Vorbedingung: Store wirklich geleert').toBeUndefined();
  hydrateStoresFromStorage();
}

function positionOf(vorgang: Vorgang | undefined) {
  return vorgang?.orderPositions.find((entry) => entry.id === POSITION_ID);
}

// ————— Formular-Oberfläche (Bearbeiten / Löschen im Modal) —————

function EditHarness({ vorgang }: { vorgang: Vorgang }) {
  const { toast, clearToast, translate } = useApp();
  return createElement(
    'div',
    null,
    createElement(OrderPositionForm, {
      mode: 'edit' as const,
      vorgang,
      position: positionOf(vorgang),
      onSaved: (updated: Vorgang) => {
        savedVorgaenge.push(updated);
      },
      onClose: () => {
        closed = true;
      },
    }),
    createElement(Toast, { message: toast, onDone: clearToast, translate }),
  );
}

async function renderEditForm(): Promise<void> {
  const vorgang = getVorgangById(VORGANG_ID)!;
  await act(async () => {
    root.render(
      createElement(
        AppProvider,
        { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
        createElement(EditHarness, { vorgang }),
      ),
    );
  });
  await settle();
}

function textInputs(): HTMLInputElement[] {
  return Array.from(host.querySelectorAll<HTMLInputElement>('.edit-field input.input'));
}

function setValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function buttonWithText(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find(
    (button) => (button.textContent ?? '').trim() === label,
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

function pageText(): string {
  return host.textContent ?? '';
}

/**
 * `VorgangDetailPage` rendert den Toast nicht selbst — das tut in Produktion
 * `AppShell`. Damit der Test die Meldung sehen kann, steht dieselbe Komponente
 * hier neben der Seite. Ausgelöst wird sie ausschliesslich vom echten Handler.
 */
function ToastProbe() {
  const { toast, clearToast, translate } = useApp();
  return createElement(Toast, { message: toast, onDone: clearToast, translate });
}

describe('ORDER-POSITION-EDIT-DELETE-PERSISTENCE-01B — Dienst', () => {
  /*
   * R1 — Ändern bei Persistenzfehler.
   *
   * Kein Phantomupdate: Weder im Arbeitsspeicher noch nach dem Neustart darf
   * der geänderte Wert auftauchen, wenn er nie gespeichert wurde.
   */
  it('R1: ein fehlgeschlagenes Speichern lässt den alten Positionswert stehen', () => {
    failLocalStorage();

    const result = updateOrderPosition(VORGANG_ID, POSITION_ID, {
      description: EDITED_DESCRIPTION,
    });

    expect(result.success, 'Erfolg trotz fehlgeschlagener Persistenz').toBe(false);
    if (!result.success) expect(result.errorKey).toBe('order_amendment_local_persist_failed');
    expect(positionOf(getVorgangById(VORGANG_ID))?.description, 'Phantomupdate im Speicher')
      .toBe(ORIGINAL_DESCRIPTION);

    vi.restoreAllMocks();
    reloadFromStorage();
    expect(positionOf(getVorgangById(VORGANG_ID))?.description).toBe(ORIGINAL_DESCRIPTION);
  });

  /*
   * R2 — Löschen bei Persistenzfehler.
   *
   * Der gefährlichere Fall: Eine Position, die aus der Anzeige verschwindet und
   * nach dem Neustart zurückkommt, lässt den Nutzer glauben, er habe bereits
   * aufgeräumt.
   */
  it('R2: ein fehlgeschlagenes Löschen lässt die Position bestehen', () => {
    failLocalStorage();

    const result = removeOrderPosition(VORGANG_ID, POSITION_ID);

    expect(result.success, 'Erfolg trotz fehlgeschlagener Persistenz').toBe(false);
    if (!result.success) expect(result.errorKey).toBe('order_amendment_local_persist_failed');
    expect(positionOf(getVorgangById(VORGANG_ID)), 'Position im Speicher verschwunden')
      .toBeDefined();

    vi.restoreAllMocks();
    reloadFromStorage();
    expect(positionOf(getVorgangById(VORGANG_ID))).toBeDefined();
  });

  // R5 — der Erfolgsfall überlebt den Neustart.
  it('R5: eine gespeicherte Änderung überlebt die Re-Hydrierung', () => {
    const result = updateOrderPosition(VORGANG_ID, POSITION_ID, {
      description: EDITED_DESCRIPTION,
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    reloadFromStorage();
    expect(positionOf(getVorgangById(VORGANG_ID))?.description).toBe(EDITED_DESCRIPTION);
  });

  // R6 — eine gelöschte Position bleibt gelöscht.
  it('R6: eine gelöschte Position ist nach der Re-Hydrierung fort', () => {
    const result = removeOrderPosition(VORGANG_ID, POSITION_ID);

    expect(result.success, JSON.stringify(result)).toBe(true);
    reloadFromStorage();
    expect(positionOf(getVorgangById(VORGANG_ID))).toBeUndefined();
  });
});

describe('ORDER-POSITION-EDIT-DELETE-PERSISTENCE-01B — Oberfläche', () => {
  /*
   * R3 — Bearbeiten über den echten Handler.
   *
   * Das Modal darf sich nicht schliessen, die Eingabe darf nicht verloren
   * gehen, der Elternzustand darf keinen Phantomwert bekommen, und es darf
   * keine Erfolgsmeldung erscheinen.
   */
  it('R3: bei Persistenzfehler bleibt das Bearbeiten-Modal offen und gefüllt', async () => {
    await renderEditForm();
    const [description] = textInputs();
    await act(async () => {
      setValue(description!, EDITED_DESCRIPTION);
    });
    await settle(2);

    failLocalStorage();
    await click(buttonWithText(t('common.save', 'de'))!);

    expect(closed, 'Modal wurde trotz Persistenzfehler geschlossen').toBe(false);
    expect(savedVorgaenge, 'Der Elternzustand bekam einen Phantomstand').toEqual([]);
    expect(textInputs()[0]!.value, 'Die Eingabe ging verloren').toBe(EDITED_DESCRIPTION);
    expect(pageText(), 'Kein sichtbarer Fehlertext').toContain(PERSIST_ERROR);
    expect(pageText(), 'Erfolgsmeldung trotz Fehler').not.toContain(SAVED_TOAST);
    expect(positionOf(getVorgangById(VORGANG_ID))?.description).toBe(ORIGINAL_DESCRIPTION);
  });

  /*
   * R3b — Löschen über den echten Handler des Modals.
   */
  it('R3b: bei Persistenzfehler meldet das Löschen im Modal den Fehler', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderEditForm();

    failLocalStorage();
    await click(buttonWithText(t('position.delete', 'de'))!);

    expect(closed, 'Modal wurde trotz Persistenzfehler geschlossen').toBe(false);
    expect(savedVorgaenge).toEqual([]);
    expect(pageText()).toContain(PERSIST_ERROR);
    expect(pageText(), 'Erfolgsmeldung trotz Fehler').not.toContain(DELETED_TOAST);
    expect(positionOf(getVorgangById(VORGANG_ID))).toBeDefined();
  });

  /*
   * R4 — der direkte Löschweg auf der Vorgangsseite.
   *
   * Er war bisher vollständig stumm: kein Toast, keine Prüfung. Die Position
   * verschwand aus der Anzeige und kam nach dem Neustart zurück.
   */
  it('R4: der Karten-Löschweg meldet einen Persistenzfehler sichtbar', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: [`/vorgaenge/${VORGANG_ID}`] },
          createElement(
            AppProvider,
            { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: '/vorgaenge/:id',
                element: createElement(
                  'div',
                  null,
                  createElement(VorgangDetailPage),
                  // Die Hülle rendert den Toast; hier steht er ersatzweise.
                  createElement(ToastProbe),
                ),
              }),
            ),
          ),
        ),
      );
    });
    await settle();

    // Zum Auftragsbereich wechseln — dort steht die Positionskarte.
    await click(host.querySelector<HTMLElement>('[data-testid="vorgang-section-tab-order"]')!);
    const remove = buttonWithText(t('position.delete', 'de'));
    expect(remove, 'Kein Löschen-Knopf auf der Positionskarte').toBeDefined();

    failLocalStorage();
    await click(remove!);

    expect(
      host.querySelector(`[data-testid="order-position-card-${POSITION_ID}"]`),
      'Die Position verschwand trotz Persistenzfehler',
    ).not.toBeNull();
    expect(pageText(), 'Der Löschfehler blieb stumm').toContain(PERSIST_ERROR);
    expect(positionOf(getVorgangById(VORGANG_ID))).toBeDefined();
  });
});
