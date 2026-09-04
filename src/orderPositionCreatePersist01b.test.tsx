/**
 * ORDER-POSITION-CREATE-PERSIST-01B — eine manuell angelegte Leistungsposition
 * gilt erst als gespeichert, wenn sie wirklich dauerhaft gespeichert ist.
 *
 * Realbefund auf iPhone/Safari: „Testposition Skonto" eingetragen, gespeichert,
 * Modal schloss, und nach vollstaendigem Safari-Reload stand im Vorgang wieder
 * „Erste Position anlegen". Die Position war weg.
 *
 * Ursache war der Persistenzvertrag: `addOrderPosition` schrieb ueber
 * `updateVorgangInStore`, das `persistAll()` aufruft, **dessen Ergebnis aber
 * nicht prueft** und in jedem Fall Erfolg meldet. Das Formular schloss daraufhin
 * das Modal, bevor ueberhaupt feststand, ob dauerhaft geschrieben wurde.
 *
 * Geprueft wird deshalb nicht `result.vorgang`, sondern der Zustand **nach**
 * erneutem Lesen und nach echter Re-Hydrierung aus dem Speicher. Der Fehlerfall
 * wird nicht simuliert, sondern durch ein scheiterndes `localStorage.setItem`
 * erzeugt — genau die Klemme, die ein iPhone unter Speicherdruck liefert.
 *
 * Synthetische Daten, kein Netz, keine Cloud, keine echten Testdaten.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toast } from './components/ui/Card';
import { AppProvider, useApp } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { OrderPositionForm } from './components/vorgang/OrderPositionForm';
import { createTestVorgang } from './test/fixtures';
import {
  addOrderPosition,
  getVorgangById,
  hydrateVorgangStore,
} from './services/vorgangService';
import { hydrateStoresFromStorage, persistAll } from './services/persistenceService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { t } from './i18n';
import type { Vorgang } from './types/models';

const VORGANG_ID = 'v-position-persist-01b';

const SUCCESS_TOAST = t('position.saved', 'de');
const PERSIST_ERROR = t('order_amendment_local_persist_failed', 'de');

/** Genau die Eingaben des Realtests. */
const INPUT = {
  description: 'Testposition Skonto',
  plannedQuantity: '1',
  unit: 'Pauschal',
  unitPrice: '100',
  category: 'arbeit',
} as const;

let root: Root;
let host: HTMLDivElement;
let savedVorgaenge: Vorgang[];

function seedVorgang(): Vorgang {
  const vorgang = createTestVorgang({ id: VORGANG_ID, orderPositions: [] });
  // Ein noch nicht bestaetigter Auftrag — genau der Zustand am Geraet.
  delete (vorgang as Partial<Vorgang>).contractConfirmation;
  return vorgang;
}

function Harness({ vorgang }: { vorgang: Vorgang }) {
  const { toast, clearToast, translate } = useApp();
  return createElement(
    'div',
    null,
    createElement(OrderPositionForm, {
      mode: 'add' as const,
      vorgang,
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

let closed = false;

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  savedVorgaenge = [];
  closed = false;
  hydrateVorgangStore([seedVorgang()]);
  // Ein sauberer Ausgangsstand im Speicher — sonst prueft die Re-Hydrierung nichts.
  expect(persistAll().success, 'Ausgangsstand liess sich nicht speichern').toBe(true);
  host = document.createElement('div');
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

async function settle(rounds = 8): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderForm(): Promise<void> {
  const vorgang = getVorgangById(VORGANG_ID)!;
  await act(async () => {
    root.render(
      createElement(
        AppProvider,
        { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
        createElement(Harness, { vorgang }),
      ),
    );
  });
  await settle();
}

/** React-kontrollierte Felder brauchen den nativen Setter. */
function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype =
    element instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function textInputs(): HTMLInputElement[] {
  return Array.from(host.querySelectorAll<HTMLInputElement>('.edit-field input.input'));
}

function buttonWithText(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find(
    (button) => (button.textContent ?? '').trim() === label,
  );
}

/** Die Eingaben des Realtests, ueber die echten Bedienelemente. */
async function fillForm(): Promise<void> {
  await act(async () => {
    const [description, planned, unitPrice] = textInputs();
    setValue(description!, INPUT.description);
    setValue(planned!, INPUT.plannedQuantity);
    setValue(unitPrice!, INPUT.unitPrice);
    setValue(host.querySelector('select.input')!, INPUT.unit);
  });
  await act(async () => {
    buttonWithText(t('position.category.arbeit', 'de'))!.click();
  });
  await settle(2);
}

async function save(): Promise<void> {
  await act(async () => {
    buttonWithText(t('common.save', 'de'))!.click();
  });
  await settle();
}

function failLocalStorage(): void {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('QuotaExceededError', 'QuotaExceededError');
  });
}

function formText(): string {
  return host.textContent ?? '';
}

describe('ORDER-POSITION-CREATE-PERSIST-01B', () => {
  /*
   * R1 — der belegte Erfolgsfall, aber nicht am Rueckgabewert geprueft.
   *
   * Genau diese Stufe hat der bisherige Store-Test uebersprungen: Er sah nur
   * `result.vorgang`, nie den Store danach.
   */
  it('R1: nach erfolgreichem Speichern steht die Position im erneut gelesenen Vorgang', async () => {
    await renderForm();
    await fillForm();
    await save();

    const stored = getVorgangById(VORGANG_ID)!;
    expect(stored.orderPositions).toHaveLength(1);
    const position = stored.orderPositions[0]!;
    expect(position.description).toBe(INPUT.description);
    expect(position.plannedQuantity).toBe(1);
    expect(position.unit).toBe('Pauschal');
    expect(position.unitPrice).toBe(100);
    expect(position.category).toBe('arbeit');
  });

  /*
   * R2 — der eigentliche Realbefund: der Reload.
   *
   * `hydrateStoresFromStorage` ist derselbe Weg, den die App beim Start geht.
   * Ueberlebt die Position ihn nicht, hilft jeder Speicher im Arbeitsspeicher
   * nichts.
   */
  it('R2: die Position überlebt eine echte Re-Hydrierung aus dem Speicher', async () => {
    await renderForm();
    await fillForm();
    await save();

    hydrateVorgangStore([]);
    expect(getVorgangById(VORGANG_ID), 'Vorbedingung: Store wirklich geleert').toBeUndefined();
    hydrateStoresFromStorage();

    const reloaded = getVorgangById(VORGANG_ID);
    expect(reloaded, 'Vorgang nach Reload verschwunden').toBeDefined();
    expect(reloaded!.orderPositions.map((entry) => entry.description)).toEqual([
      INPUT.description,
    ]);
  });

  /*
   * R3 — der Dienst selbst: kein Phantomstand.
   *
   * Scheitert die Persistenz, darf der Arbeitsspeicher nicht behaupten, es sei
   * etwas gespeichert worden. Sonst zeigt die Oberflaeche eine Position, die
   * beim naechsten Start weg ist — genau der iPhone-Fall.
   */
  it('R3: bei Persistenzfehler bleibt der vorherige Vorgangszustand erhalten', () => {
    failLocalStorage();

    const result = addOrderPosition(VORGANG_ID, {
      description: INPUT.description,
      plannedQuantity: 1,
      unit: 'Pauschal',
      unitPrice: 100,
      category: 'arbeit',
    });

    expect(result.success, 'Erfolg trotz fehlgeschlagener Persistenz').toBe(false);
    expect(getVorgangById(VORGANG_ID)!.orderPositions, 'Phantomposition im Store').toHaveLength(0);
  });

  /*
   * R4 / R5 / R6 — der Fehlerfall an der Oberflaeche.
   *
   * Das Modal darf sich nicht schliessen, die Eingaben duerfen nicht verloren
   * gehen, und es darf keine Erfolgsmeldung erscheinen. Der Nutzer muss
   * korrigieren oder erneut versuchen koennen.
   */
  it('R4/R5/R6: bei Persistenzfehler bleibt das Formular offen, gefüllt und meldet den Fehler', async () => {
    await renderForm();
    await fillForm();
    failLocalStorage();
    await save();

    expect(closed, 'Modal wurde trotz Persistenzfehler geschlossen').toBe(false);
    expect(savedVorgaenge, 'Parent bekam einen Phantomstand').toEqual([]);

    const [description, planned, unitPrice] = textInputs();
    expect(description!.value).toBe(INPUT.description);
    expect(planned!.value).toBe(INPUT.plannedQuantity);
    expect(unitPrice!.value).toBe(INPUT.unitPrice);
    expect(host.querySelector<HTMLSelectElement>('select.input')!.value).toBe(INPUT.unit);

    expect(formText(), 'Kein sichtbarer Fehlertext').toContain(PERSIST_ERROR);
    expect(formText(), 'Erfolgsmeldung trotz Fehler').not.toContain(SUCCESS_TOAST);
    expect(getVorgangById(VORGANG_ID)!.orderPositions).toHaveLength(0);
  });

  /*
   * R7 — der Erfolgsfall an der Oberflaeche: der Parent bekommt genau den
   * Stand, der auch im Speicher steht.
   */
  it('R7: bei Erfolg schließt das Modal und der Parent erhält den persistierten Vorgang', async () => {
    await renderForm();
    await fillForm();
    await save();

    expect(closed, 'Modal blieb trotz Erfolg offen').toBe(true);
    expect(savedVorgaenge).toHaveLength(1);
    expect(savedVorgaenge[0]!.orderPositions.map((entry) => entry.description)).toEqual([
      INPUT.description,
    ]);
    expect(savedVorgaenge[0]!.orderPositions).toEqual(
      getVorgangById(VORGANG_ID)!.orderPositions,
    );
    expect(formText()).toContain(SUCCESS_TOAST);
  });

  /*
   * R8 / R9 — die Bestaetigung bleibt aussen vor.
   *
   * Ein noch nicht bestaetigter Auftrag darf Positionen bekommen, und das
   * Speichern darf ihn nicht stillschweigend bestaetigen.
   */
  it('R8/R9: ein unbestätigter Auftrag nimmt Positionen an, ohne bestätigt zu werden', async () => {
    expect(getVorgangById(VORGANG_ID)!.contractConfirmation).toBeUndefined();

    await renderForm();
    await fillForm();
    await save();

    const stored = getVorgangById(VORGANG_ID)!;
    expect(stored.orderPositions).toHaveLength(1);
    expect(stored.contractConfirmation, 'Auftrag wurde still bestätigt').toBeUndefined();
  });
});
