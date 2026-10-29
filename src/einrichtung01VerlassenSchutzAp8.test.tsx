/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.27) — Verlassen-Schutz und Wiederaufnahme.
 *
 *   X-01  ungespeicherte Änderungen: App-Link, Browser-Zurück, Abmelden/Betriebswechsel → Rückfrage „Bleiben“ (Fokus) /
 *         „Verlassen“; Neuladen/Schließen → beforeunload; Anker auf derselben Seite fragt nicht; nach Speichern keine
 *   X-02  Entwurf je Konto, Betrieb und Datensatz: bei Rückkehr „Fortsetzen“ oder „Verwerfen“ (ExpenseForm,
 *         CustomerEditForm, Nummernkreise)
 *   X-03  veralteter Entwurf (Daten inzwischen geändert) → verworfen mit Hinweis
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, Link, MemoryRouter, Route, RouterProvider, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { LeaveGuardHost } from './components/system/LeaveGuardHost';
import { useLeaveGuard } from './hooks/useLeaveGuard';
import { confirmLeaveIfDirty, hasDirtyLeaveGuard, resetLeaveGuardsForTests } from './services/navigation/leaveGuardRegistry';
import { ExpenseForm } from './components/expenses/ExpenseForm';
import { CustomerEditForm } from './components/customer/CustomerEditForm';
import { NumberRangeSettingsPage } from './pages/settings/NumberRangeSettingsPage';
import { resetTestStores } from './test/resetStores';
import * as supabaseLib from './lib/supabase';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { captureAndPersistUiSession } from './services/uiSession/uiSessionCapture';
import { resetUiSessionLiveState, setPendingUiSessionApply } from './services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot, loadUiSessionSnapshot } from './services/uiSession/uiSessionStore';
import { decideUiSessionRestore } from './services/uiSession/uiSessionRestore';
import { addExpense, getAllExpenses, updateExpense } from './services/expenseService';
import type { Customer } from './types/models';
import type { Expense } from './types/expense';

const setup = { ...DEFAULT_SETUP, setupComplete: true };
let root: Root | null = null;
let host: HTMLDivElement;

async function settle(rounds = 10): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function mount(): void {
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
  await settle();
}

async function type(element: Element | null, value: string): Promise<void> {
  expect(element).not.toBeNull();
  const input = element as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function Pfad() {
  const location = useLocation();
  return <div data-testid="pfad" data-path={location.pathname} data-hash={location.hash} />;
}

function Formular({ draftKept = false }: { draftKept?: boolean }) {
  const [wert, setWert] = useState('');
  const guard = useLeaveGuard(wert !== '', draftKept);
  return (
    <div>
      <input data-testid="feld" value={wert} onChange={(e) => setWert(e.target.value)} />
      <Link to="/anderswo" data-testid="link-weg">weg</Link>
      <Link to="#abschnitt" data-testid="link-anker">Anker</Link>
      <button
        type="button"
        data-testid="gespeichert-weg"
        onClick={() => {
          guard.release();
          void router?.navigate('/anderswo');
        }}
      >
        speichern
      </button>
    </div>
  );
}

let router: ReturnType<typeof createMemoryRouter> | null = null;

async function renderDatenRouter(draftKept = false): Promise<void> {
  mount();
  router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <AuthProvider>
            <AppProvider initialSetup={setup}>
              <LeaveGuardHost />
              <Routes>
                <Route path="/start" element={<div data-testid="start" />} />
                <Route path="/formular" element={<Formular draftKept={draftKept} />} />
                <Route path="/anderswo" element={<div data-testid="anderswo" />} />
              </Routes>
              <Pfad />
            </AppProvider>
          </AuthProvider>
        ),
      },
    ],
    { initialEntries: ['/start', '/formular'], initialIndex: 1 },
  );
  await act(async () => {
    root!.render(<RouterProvider router={router!} />);
  });
  await settle();
}

const pfad = () => q('pfad')?.getAttribute('data-path');

beforeEach(() => {
  resetTestStores();
  resetLeaveGuardsForTests();
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  setActiveStorageScope({ type: 'guest' });
  resetUiSessionLiveState();
  clearUiSessionSnapshot();
});

afterEach(async () => {
  await unmount();
  router = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  resetLeaveGuardsForTests();
  clearUiSessionSnapshot();
  resetUiSessionLiveState();
  resetTestStores();
});

describe('EINRICHTUNG-01 AP8 — Verlassen-Schutz (1.27, X-01)', { timeout: 30_000 }, () => {
  it('App-Link bei ungespeicherter Eingabe: Rückfrage, „Bleiben“ hat den Fokus und bleibt; „Verlassen“ geht', async () => {
    await renderDatenRouter();
    await click(q('link-weg'));
    expect(pfad()).toBe('/anderswo');
    await act(async () => {
      await router!.navigate('/formular');
    });
    await settle();
    await type(q('feld'), 'Eingabe');
    await click(q('link-weg'));
    expect(q('leave-guard-dialog')).not.toBeNull();
    expect(q('leave-guard-dialog')?.textContent).toContain('gehen verloren');
    expect(document.activeElement).toBe(q('leave-guard-stay'));
    await click(q('leave-guard-stay'));
    expect(pfad()).toBe('/formular');
    expect(q('leave-guard-dialog')).toBeNull();
    await click(q('link-weg'));
    await click(q('leave-guard-leave'));
    expect(pfad()).toBe('/anderswo');
  });

  it('Browser-Zurück wird ebenso abgefangen; ein Anker auf derselben Seite fragt nicht', async () => {
    await renderDatenRouter(true);
    await type(q('feld'), 'Eingabe');
    await act(async () => {
      await router!.navigate(-1);
    });
    await settle();
    expect(q('leave-guard-dialog')).not.toBeNull();
    expect(q('leave-guard-dialog')?.textContent).toContain('als Entwurf erhalten');
    await click(q('leave-guard-stay'));
    expect(pfad()).toBe('/formular');
    // Ein Anker auf derselben Seite ist kein Verlassen.
    await click(q('link-anker'));
    expect(q('leave-guard-dialog')).toBeNull();
    expect(q('pfad')?.getAttribute('data-hash')).toBe('#abschnitt');
  });

  it('Neuladen/Schließen: beforeunload nur bei ungespeicherten Änderungen; nach dem Speichern keine Rückfrage', async () => {
    await renderDatenRouter();
    const sauber = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(sauber);
    expect(sauber.defaultPrevented).toBe(false);
    await type(q('feld'), 'Eingabe');
    const geaendert = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(geaendert);
    expect(geaendert.defaultPrevented).toBe(true);
    await click(q('gespeichert-weg'));
    expect(q('leave-guard-dialog')).toBeNull();
    expect(pfad()).toBe('/anderswo');
  });

  it('Abmelden und Betriebswechsel: dieselbe Rückfrage über confirmLeaveIfDirty', async () => {
    await renderDatenRouter();
    expect(await confirmLeaveIfDirty()).toBe(true);
    await type(q('feld'), 'Eingabe');
    let antwort: Promise<boolean> | null = null;
    await act(async () => {
      antwort = confirmLeaveIfDirty();
    });
    await settle();
    expect(q('leave-guard-dialog')).not.toBeNull();
    await click(q('leave-guard-stay'));
    expect(await antwort).toBe(false);
    await act(async () => {
      antwort = confirmLeaveIfDirty();
    });
    await settle();
    await click(q('leave-guard-leave'));
    expect(await antwort).toBe(true);
    expect(hasDirtyLeaveGuard()).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Wiederaufnahme                                                       */
/* ------------------------------------------------------------------ */

const AUSGABE_ROUTE = '/ausgaben/neu';

async function renderAusgabe(props: { expense?: Expense } = {}, onSaved = vi.fn()): Promise<void> {
  mount();
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[AUSGABE_ROUTE]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            <Routes>
              <Route path={AUSGABE_ROUTE} element={<ExpenseForm mode={props.expense ? 'edit' : 'add'} expense={props.expense} onSaved={onSaved} onCancel={() => undefined} />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

function sichern(route: string): void {
  captureAndPersistUiSession({ pathname: route, search: '', hash: '', historyKey: 'k1', mainScrollTop: 0, userId: null, source: 'auto' });
}

function wiederaufnahmeVorbereiten(route: string): void {
  const decision = decideUiSessionRestore({ userId: null, currentPathname: route, currentSearch: '' });
  if (decision.snapshot) setPendingUiSessionApply(decision.snapshot);
}

const titelFeld = () => host.querySelector('.expense-form input') as HTMLInputElement | null;

describe('EINRICHTUNG-01 AP8 — Wiederaufnahme (1.27, X-02/X-03)', { timeout: 30_000 }, () => {
  it('X-02 ExpenseForm: Entwurf bleibt, bei Rückkehr angeboten; „Fortsetzen“ setzt die Eingaben ein', async () => {
    await renderAusgabe();
    await type(titelFeld(), 'Material Baustelle');
    sichern(AUSGABE_ROUTE);
    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(true);
    await unmount();
    wiederaufnahmeVorbereiten(AUSGABE_ROUTE);
    await renderAusgabe();
    expect(q('expense-form-resume')?.getAttribute('data-state')).toBe('offer');
    expect(titelFeld()?.value).toBe('');
    await click(q('expense-form-resume-continue'));
    expect(titelFeld()?.value).toBe('Material Baustelle');
    expect(q('expense-form-resume')).toBeNull();
  });

  it('X-02 ExpenseForm: „Verwerfen“ entfernt den Entwurf; nach dem Speichern kein Entwurf', async () => {
    await renderAusgabe();
    await type(titelFeld(), 'Verwerfen bitte');
    sichern(AUSGABE_ROUTE);
    await unmount();
    wiederaufnahmeVorbereiten(AUSGABE_ROUTE);
    await renderAusgabe();
    await click(q('expense-form-resume-discard'));
    expect(titelFeld()?.value).toBe('');
    sichern(AUSGABE_ROUTE);
    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(false);
  });

  it('X-03 ExpenseForm: Beleg inzwischen geändert → Entwurf verworfen, mit Hinweis', async () => {
    const angelegt = addExpense({ title: 'Alt', category: 'material', supplierName: 'L', invoiceNumber: 'R-1', description: '', issueDate: '2026-10-01', paymentDueDate: null, grossAmount: 10, taxStatus: 'regelbesteuert' } as never);
    expect(angelegt.success).toBe(true);
    const expense = getAllExpenses()[0];
    await renderAusgabe({ expense });
    await type(titelFeld(), 'Entwurfstitel');
    sichern(AUSGABE_ROUTE);
    await unmount();
    expect(updateExpense(expense.id, { title: 'Anderswo geändert' } as never).success).toBe(true);
    wiederaufnahmeVorbereiten(AUSGABE_ROUTE);
    await renderAusgabe({ expense: getAllExpenses()[0] });
    expect(q('expense-form-resume')?.getAttribute('data-state')).toBe('stale');
    expect(q('expense-form-resume')?.textContent).toContain('älterer Entwurf wurde verworfen');
    expect(titelFeld()?.value).toBe('Anderswo geändert');
  });

  it('X-02 (App-Eigenprüfung, N-08) ExpenseForm: eigene Eingabe bei offenem Angebot wird der Entwurf — die Zusage der Rückfrage hält', async () => {
    const entwurfsWerte = () => Object.values(loadUiSessionSnapshot()?.drafts.values ?? {});
    await renderAusgabe();
    await type(titelFeld(), 'Entwurf A');
    sichern(AUSGABE_ROUTE);
    await unmount();
    wiederaufnahmeVorbereiten(AUSGABE_ROUTE);
    await renderAusgabe();
    expect(q('expense-form-resume')?.getAttribute('data-state')).toBe('offer');
    // Unberührt bleibt der angebotene Entwurf gemeldet.
    sichern(AUSGABE_ROUTE);
    expect(entwurfsWerte()).toContain('Entwurf A');
    // Neue Eingabe bei offenem Angebot: ab jetzt ist sie der Entwurf; das Angebot bleibt sichtbar.
    await type(titelFeld(), 'Eingabe B');
    sichern(AUSGABE_ROUTE);
    expect(entwurfsWerte()).toContain('Eingabe B');
    expect(entwurfsWerte()).not.toContain('Entwurf A');
    expect(q('expense-form-resume')?.getAttribute('data-state')).toBe('offer');
    // Rückkehr: angeboten und eingesetzt wird die letzte Eingabe.
    await unmount();
    wiederaufnahmeVorbereiten(AUSGABE_ROUTE);
    await renderAusgabe();
    await click(q('expense-form-resume-continue'));
    expect(titelFeld()?.value).toBe('Eingabe B');
  });

  it('X-02 (App-Eigenprüfung, N-08) ExpenseForm: zurückgenommene Eingabe lässt den Entwurf stehen; „Fortsetzen“ holt ihn ausdrücklich zurück', async () => {
    const entwurfsWerte = () => Object.values(loadUiSessionSnapshot()?.drafts.values ?? {});
    await renderAusgabe();
    await type(titelFeld(), 'Entwurf A');
    sichern(AUSGABE_ROUTE);
    await unmount();
    wiederaufnahmeVorbereiten(AUSGABE_ROUTE);
    await renderAusgabe();
    await type(titelFeld(), 'Eingabe B');
    await type(titelFeld(), '');
    sichern(AUSGABE_ROUTE);
    expect(entwurfsWerte()).toContain('Entwurf A');
    await type(titelFeld(), 'Eingabe B');
    await click(q('expense-form-resume-continue'));
    expect(titelFeld()?.value).toBe('Entwurf A');
    expect(q('expense-form-resume')).toBeNull();
  });

  it('X-02 CustomerEditForm: Entwurf je Kunde mit Fortsetzen', async () => {
    const kunde = { id: 'kunde-ap8', name: 'Kunde Eins', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '', createdAt: '', updatedAt: '' } as Customer;
    const ROUTE = '/kunden/customer/kunde-ap8';
    const render = async () => {
      mount();
      await act(async () => {
        root!.render(
          <MemoryRouter initialEntries={[ROUTE]}>
            <AuthProvider>
              <AppProvider initialSetup={setup}>
                <Routes>
                  <Route path={ROUTE} element={<CustomerEditForm customer={kunde} busy={false} error={null} onSave={() => undefined} onCancel={() => undefined} />} />
                </Routes>
              </AppProvider>
            </AuthProvider>
          </MemoryRouter>,
        );
      });
      await settle();
    };
    await render();
    const name = () => host.querySelector('[data-testid="kunden-edit-form"] input') as HTMLInputElement;
    await type(name(), 'Kunde Eins GmbH');
    sichern(ROUTE);
    await unmount();
    wiederaufnahmeVorbereiten(ROUTE);
    await render();
    expect(q('kunden-edit-resume')?.getAttribute('data-state')).toBe('offer');
    expect(name().value).toBe('Kunde Eins');
    await click(q('kunden-edit-resume-continue'));
    expect(name().value).toBe('Kunde Eins GmbH');
  });

  it('X-02 Nummernkreise: Entwurf der Startnummer mit Fortsetzen', async () => {
    const ROUTE = '/einstellungen/nummernkreise';
    const render = async () => {
      mount();
      await act(async () => {
        root!.render(
          <MemoryRouter initialEntries={[ROUTE]}>
            <AuthProvider>
              <AppProvider initialSetup={setup}>
                <Routes>
                  <Route path={ROUTE} element={<NumberRangeSettingsPage />} />
                </Routes>
              </AppProvider>
            </AuthProvider>
          </MemoryRouter>,
        );
      });
      await settle();
    };
    await render();
    await type(q('settings-number-ranges-start'), '120');
    sichern(ROUTE);
    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(true);
    await unmount();
    wiederaufnahmeVorbereiten(ROUTE);
    await render();
    expect(q('settings-number-ranges-resume')?.getAttribute('data-state')).toBe('offer');
    expect((q('settings-number-ranges-start') as HTMLInputElement).value).toBe('');
    await click(q('settings-number-ranges-resume-continue'));
    expect((q('settings-number-ranges-start') as HTMLInputElement).value).toBe('120');
  });
});
