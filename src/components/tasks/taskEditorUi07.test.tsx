/**
 * TAGESARBEIT-V1 — Oberfläche der Aufgabenseite.
 *
 *  U1  „Neue Aufgabe": Dialog, Anlegen, Liste aktualisiert
 *  U2  Frist setzen und sichtbar entfernen
 *  U3  Bearbeiten über die Zeile; Erledigt bleibt direkt erreichbar
 *  U4  Manuelle Aufgabe löschen — mit Bestätigung
 *  U5  Automatische Aufgabe: kein Löschknopf, Hinweis, Frist änderbar
 *  U6  Fehler werden angezeigt statt verschluckt
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { createTestVorgang } from '../../test/fixtures';
import { AufgabenPage } from '../../pages/AufgabenPage';
import { createManualTask, createTaskFromProposal } from '../../services/taskEngineService';
import { getAllTasksFromStore, setTaskStoreForTests } from '../../services/taskStore';
import { hydrateVorgangStore } from '../../services/vorgangService';
import * as persistenceService from '../../services/persistenceService';
import { de } from '../../i18n';
import type { Task, TaskProposal } from '../../types/models';

const V1 = 'v-ui-task';
let root: Root;
let host: HTMLDivElement;

function q(id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${id}"]`);
}

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
          <AufgabenPage />
        </AppProvider>
      </MemoryRouter>,
    );
  });
}

async function click(id: string): Promise<void> {
  const element = q(id);
  if (!element) throw new Error(`fehlt: ${id}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function type(id: string, value: string): Promise<void> {
  const field = q(id) as HTMLInputElement | HTMLTextAreaElement;
  const prototype =
    field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(id: string, value: string): Promise<void> {
  const field = q(id) as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function autoProposal(): TaskProposal {
  return {
    title: 'Zahlung prüfen: Rechnung 2026-0001',
    description: 'Überfällige Ausgangsrechnung',
    priority: 'hoch',
    category: 'zahlungen',
    sourceType: 'invoice',
    sourceId: 'inv-0001',
    taskKind: 'payment_overdue',
    dueDate: '2026-10-20',
    autoCreated: true,
  };
}

function stored(id: string): Task | undefined {
  return getAllTasksFromStore().find((task) => task.id === id);
}

beforeEach(() => {
  localStorage.clear();
  setTaskStoreForTests([]);
  hydrateVorgangStore([createTestVorgang({ id: V1, title: 'Bad Sanierung', customer: 'Kunde A' })]);
  vi.restoreAllMocks();
  vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: true } as never);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('U1 — Neue Aufgabe', () => {
  it('U1.1: der Knopf steht in der vorhandenen Werkzeugleiste', async () => {
    await mount();
    expect(q('aufgaben-new')).not.toBeNull();
    expect(q('aufgaben-new')!.textContent).toBe(de['aufgaben.new']);
  });

  it('U1.2: anlegen mit Titel, Notiz, Frist und Auftrag', async () => {
    await mount();
    await click('aufgaben-new');

    expect(q('task-editor-dialog')).not.toBeNull();
    // Kein Löschknopf bei einer Aufgabe, die es noch nicht gibt.
    expect(q('task-editor-delete')).toBeNull();

    await type('task-editor-title', 'Kunde Meier anrufen');
    await type('task-editor-description', 'Wegen Nachtrag Bad');
    await type('task-editor-duedate', '2026-11-02');
    await choose('task-editor-vorgang', V1);
    await click('task-editor-save');

    expect(q('task-editor-dialog')).toBeNull();
    const task = getAllTasksFromStore()[0]!;
    expect(task.title).toBe('Kunde Meier anrufen');
    expect(task.description).toBe('Wegen Nachtrag Bad');
    expect(task.dueDate).toBe('2026-11-02');
    expect(task.linkedVorgangId).toBe(V1);
    expect(task.linkedVorgangTitle).toBe('Bad Sanierung');
    expect(task.autoCreated).toBe(false);
    // Und sie steht sofort in der Liste.
    expect(q(`aufgaben-row-${task.id}`)).not.toBeNull();
  });

  it('U1.3: zwei gleichlautende Aufgaben bleiben zwei Zeilen', async () => {
    await mount();
    for (let i = 0; i < 2; i += 1) {
      await click('aufgaben-new');
      await type('task-editor-title', 'Kunde anrufen');
      await click('task-editor-save');
    }
    expect(getAllTasksFromStore()).toHaveLength(2);
    expect(host.querySelectorAll('[data-testid^="aufgaben-row-"]')).toHaveLength(2);
  });

  it('U1.4: ohne Frist und ohne Auftrag geht es auch', async () => {
    await mount();
    await click('aufgaben-new');
    await type('task-editor-title', 'Material bestellen');
    await click('task-editor-save');

    const task = getAllTasksFromStore()[0]!;
    expect(task.dueDate).toBeUndefined();
    expect(task.linkedVorgangId).toBeUndefined();
  });
});

describe('U2 — Frist', () => {
  it('U2.1: die Frist lässt sich sichtbar entfernen', async () => {
    const task = (() => {
      const result = createManualTask({ title: 'Angebot', dueDate: '2026-11-02' });
      if (!result.success) throw new Error(result.errorKey);
      return result.task;
    })();
    await mount();

    await click(`aufgaben-edit-${task.id}`);
    expect((q('task-editor-duedate') as HTMLInputElement).value).toBe('2026-11-02');

    await click('task-editor-duedate-clear');
    expect((q('task-editor-duedate') as HTMLInputElement).value).toBe('');
    // Der Knopf verschwindet, sobald es nichts mehr zu entfernen gibt.
    expect(q('task-editor-duedate-clear')).toBeNull();

    await click('task-editor-save');
    expect(stored(task.id)!.dueDate).toBeUndefined();
  });

  it('U2.2: eine Frist nachträglich setzen', async () => {
    const result = createManualTask({ title: 'Angebot' });
    if (!result.success) throw new Error(result.errorKey);
    await mount();

    await click(`aufgaben-edit-${result.task.id}`);
    await type('task-editor-duedate', '2026-12-01');
    await click('task-editor-save');

    expect(stored(result.task.id)!.dueDate).toBe('2026-12-01');
  });
});

describe('U3 — Bearbeiten und Erledigen', () => {
  it('U3.1: die Zeile lässt sich bearbeiten, die Erledigt-Aktion bleibt direkt erreichbar', async () => {
    const result = createManualTask({ title: 'Kunde anrufen' });
    if (!result.success) throw new Error(result.errorKey);
    const id = result.task.id;
    await mount();

    expect(q(`aufgaben-toggle-${id}`)).not.toBeNull();
    expect(q(`aufgaben-edit-${id}`)).not.toBeNull();

    await click(`aufgaben-edit-${id}`);
    await type('task-editor-title', 'Kunde zurückrufen');
    await click('task-editor-save');
    expect(stored(id)!.title).toBe('Kunde zurückrufen');

    // Erledigen funktioniert unverändert mit einem Klick.
    await act(async () => {
      (q(`aufgaben-toggle-${id}`) as HTMLInputElement).click();
    });
    expect(stored(id)!.status).toBe('done');
  });
});

describe('U4 — Löschen', () => {
  it('U4.1: löschen erst nach Bestätigung', async () => {
    const result = createManualTask({ title: 'Kunde anrufen' });
    if (!result.success) throw new Error(result.errorKey);
    const id = result.task.id;
    await mount();

    await click(`aufgaben-edit-${id}`);
    await click('task-editor-delete');

    expect(q('task-editor-delete-confirm')).not.toBeNull();
    // Abbrechen löscht nichts.
    await click('task-editor-delete-no');
    expect(stored(id)).toBeDefined();

    await click('task-editor-delete');
    await click('task-editor-delete-yes');

    expect(stored(id)).toBeUndefined();
    expect(q(`aufgaben-row-${id}`)).toBeNull();
  });
});

describe('U5 — Automatische Aufgabe', () => {
  it('U5.1: kein Löschknopf, dafür ein verständlicher Hinweis', async () => {
    const auto = createTaskFromProposal(autoProposal())!;
    await mount();

    await click(`aufgaben-edit-${auto.id}`);

    expect(q('task-editor-delete')).toBeNull();
    expect(q('task-editor-auto-hint')!.textContent).toBe(de['aufgaben.auto.hint']);
    expect(q('task-editor-auto-hint')!.textContent).not.toMatch(/autoCreated|sourceType|dedupe/);
  });

  it('U5.2: die Frist einer automatischen Aufgabe bleibt bearbeitbar', async () => {
    const auto = createTaskFromProposal(autoProposal())!;
    await mount();

    await click(`aufgaben-edit-${auto.id}`);
    await click('task-editor-duedate-clear');
    await click('task-editor-save');

    expect(stored(auto.id)!.dueDate).toBeUndefined();
    expect(stored(auto.id)).toBeDefined();
  });
});

describe('U6 — Fehler', () => {
  it('U6.1: ein leerer Titel wird im Dialog gemeldet, nicht verschluckt', async () => {
    await mount();
    await click('aufgaben-new');
    await type('task-editor-title', '   ');
    await click('task-editor-save');

    expect(q('task-editor-error')!.textContent).toBe(de['task.error.titleInvalid']);
    // Der Dialog bleibt offen, die Eingabe bleibt erhalten.
    expect(q('task-editor-dialog')).not.toBeNull();
    expect(getAllTasksFromStore()).toHaveLength(0);
  });

  it('U6.2: ein Persistenzfehler wird gemeldet statt als Erfolg gezeigt', async () => {
    await mount();
    await click('aufgaben-new');
    await type('task-editor-title', 'Kunde anrufen');

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: {},
    } as never);
    await click('task-editor-save');

    expect(q('task-editor-error')!.textContent).toBe(de['task.persistFailed']);
    expect(q('task-editor-dialog')).not.toBeNull();
    expect(getAllTasksFromStore()).toHaveLength(0);
  });
});
