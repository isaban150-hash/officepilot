/**
 * GLOBAL-WORKSPACE-CONTINUITY-01B — OfficePilot setzt den Arbeitskontext nicht
 * mehr auf Standardwerte zurück.
 *
 * Realbefund auf iPhone/Safari: Vorgang öffnen, Tab „Auftrag", App wechseln
 * oder neu laden — der Tab sprang auf „Übersicht".
 *
 * Zwei Ursachen lagen übereinander:
 *
 * 1. `VorgangDetailPage` trug den Bereich in `useState` und schützte ihn mit
 *    einem Ref-Wächter, der im Mount-Effekt verbraucht wurde. Unter StrictMode
 *    läuft dieser Effekt zweimal — der zweite Lauf zerstörte die gerade
 *    wiederhergestellte Auswahl. **Deshalb läuft dieser Test unter StrictMode:**
 *    ohne ihn wäre der Fehler unsichtbar geblieben.
 *
 * 2. Das UI-Sitzungssystem hielt genau **einen** Schnappschuss und entschied
 *    nur beim App-Start über eine Wiederaufnahme. Jede Navigation A → B → A war
 *    damit verlustbehaftet, unabhängig von Punkt 1.
 *
 * Geprüft wird über die produktive Kette: echter Router, echter
 * `UiSessionRecoveryHost` mit seinem Tracker, echte Klicks, echtes `pagehide`.
 * Nichts wird vorbereitet und kein React-Zustand von aussen gesetzt.
 *
 * Synthetische Daten, kein Netz, keine Fachaktionen.
 */
import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { UiSessionRecoveryHost } from './components/system/UiSessionRecoveryHost';
import { DEFAULT_SETUP } from './data/mockData';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { createTestVorgang } from './test/fixtures';
import { hydrateVorgangStore } from './services/vorgangService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import {
  UI_SESSION_MAX_ENTRIES,
  UI_SESSION_STORAGE_KEY,
  buildUiSessionEntryKey,
  loadUiSessionSnapshot,
  loadUiSessionSnapshotForRoute,
  saveUiSessionSnapshot,
} from './services/uiSession/uiSessionStore';
import { buildUiSessionRouteKey, routesMatch } from './services/uiSession/uiSessionRoute';
import { buildUiSessionSnapshot } from './services/uiSession/uiSessionCapture';
import { resetUiSessionLiveState } from './services/uiSession/uiSessionLiveState';
import { decideUiSessionRestore } from './services/uiSession/uiSessionRestore';
import { UI_SESSION_TTL_MS } from './types/uiSessionSnapshot';
import type { UiSessionSnapshot } from './types/uiSessionSnapshot';

const VORGANG_A = 'v-continuity-a';
const VORGANG_B = 'v-continuity-b';

let root: Root;
let host: HTMLDivElement;
let currentPath = '';
let currentSearch = '';
let navigateTo: (to: string | number) => void = () => {};

function RouteProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  currentPath = location.pathname;
  currentSearch = location.search;
  navigateTo = (to) => {
    if (typeof to === 'number') navigate(to);
    else navigate(to);
  };
  return null;
}

function createHost(): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'app-shell__main';
  document.body.appendChild(element);
  root = createRoot(element);
  return element;
}

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  resetUiSessionLiveState();
  hydrateVorgangStore([
    createTestVorgang({ id: VORGANG_A, title: 'Vorgang A' }),
    createTestVorgang({ id: VORGANG_B, title: 'Vorgang B' }),
  ]);
  currentPath = '';
  currentSearch = '';
  host = createHost();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  localStorage.clear();
  sessionStorage.clear();
  resetUiSessionLiveState();
  vi.restoreAllMocks();
});

async function settle(rounds = 12): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

/** Die produktive Kette — ausdrücklich unter StrictMode. */
async function renderApp(entry: string): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [entry] },
          createElement(
            AuthProvider,
            null,
            createElement(
              AppProvider,
              { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
              createElement(UiSessionRecoveryHost),
              createElement(RouteProbe),
              createElement(
                Routes,
                null,
                createElement(Route, {
                  path: '/vorgaenge/:id',
                  element: createElement(VorgangDetailPage),
                }),
                createElement(Route, {
                  path: '/vorgaenge/:id/rechnung',
                  element: createElement('div', { 'data-testid': 'rechnung-stub' }),
                }),
              ),
            ),
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
  await settle(8);
}

async function go(to: string | number): Promise<void> {
  await act(async () => {
    navigateTo(to);
  });
  await settle(10);
}

/** Welcher Bereich ist sichtbar? Gelesen am produktiven `aria-selected`. */
function selectedSection(): string | null {
  const tab = host.querySelector('[role="tab"][aria-selected="true"]');
  return tab?.getAttribute('data-testid')?.replace('vorgang-section-tab-', '') ?? null;
}

async function openTab(section: string): Promise<void> {
  await click(find(`vorgang-section-tab-${section}`)!);
}

/** Der Appwechsel: genau das Ereignis, auf das der produktive Tracker hört. */
async function leaveToOtherApp(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
  });
  await settle(4);
}

/** Safari verwirft den Tab und baut dieselbe Adresse neu auf. */
async function rebuild(): Promise<void> {
  const entry = `${currentPath}${currentSearch}`;
  await act(async () => root.unmount());
  host.remove();
  host = createHost();
  resetUiSessionLiveState();
  await renderApp(entry);
}

describe('GLOBAL-WORKSPACE-CONTINUITY-01B — Oberfläche unter StrictMode', () => {
  // R1 + R20 — der Realbefund, unter StrictMode.
  it('R1/R20: Tab Auftrag überlebt Appwechsel und Neuaufbau', async () => {
    await renderApp(`/vorgaenge/${VORGANG_A}`);
    await openTab('order');
    expect(selectedSection()).toBe('order');

    await leaveToOtherApp();
    await rebuild();

    expect(selectedSection(), 'Rücksprung auf die Übersicht').toBe('order');
  });

  // R2 — derselbe Weg für einen anderen Bereich.
  it('R2: Tab Rechnungen überlebt den Neuaufbau', async () => {
    await renderApp(`/vorgaenge/${VORGANG_A}`);
    await openTab('invoices');
    await leaveToOtherApp();
    await rebuild();

    expect(selectedSection()).toBe('invoices');
  });

  // R3 + R4 — zwei Vorgänge, zwei Arbeitsstände.
  it('R3/R4: Vorgang A → B → zurück zu A hält beide Bereiche getrennt', async () => {
    await renderApp(`/vorgaenge/${VORGANG_A}`);
    await openTab('order');

    await go(`/vorgaenge/${VORGANG_B}`);
    expect(selectedSection(), 'B erbt den Bereich von A').toBe('overview');
    await openTab('amendments');

    /*
     * Bewusst ohne `vtab` in der Adresse: Geprüft wird der Sitzungs-Fallback,
     * also genau das, was der alte Ein-Platz-Speicher nicht konnte.
     */
    await go(`/vorgaenge/${VORGANG_A}`);
    expect(selectedSection(), 'A verlor seinen Bereich').toBe('order');

    await go(`/vorgaenge/${VORGANG_B}`);
    expect(`${currentPath}${currentSearch}`).toBe(`/vorgaenge/${VORGANG_B}`);
    expect(selectedSection(), 'B verlor seinen Bereich').toBe('amendments');
  });

  // R5 + R19 — der Umweg über die Rechnung.
  it('R5/R19: Vorgang → Rechnung → zurück behält den Vorgangs-Bereich', async () => {
    await renderApp(`/vorgaenge/${VORGANG_A}`);
    await openTab('order');

    await go(`/vorgaenge/${VORGANG_A}/rechnung`);
    expect(find('rechnung-stub')).not.toBeNull();

    await go(-1);
    expect(selectedSection()).toBe('order');
  });

  // R6 — ein ausdrücklicher Tab in der Adresse gewinnt.
  it('R6: die Adresse gewinnt gegen einen älteren Sitzungswert', async () => {
    await renderApp(`/vorgaenge/${VORGANG_A}`);
    await openTab('order');
    await leaveToOtherApp();

    await act(async () => root.unmount());
    host.remove();
    host = createHost();
    resetUiSessionLiveState();
    await renderApp(`/vorgaenge/${VORGANG_A}?vtab=invoices`);

    expect(selectedSection(), 'Die Sitzung hat die Adresse überstimmt').toBe('invoices');
  });

  // R7 — ein unbekannter Wert ist kein Fehler.
  it('R7: ein ungültiger Tab fällt sicher auf die Übersicht', async () => {
    await renderApp(`/vorgaenge/${VORGANG_A}?vtab=phantasie`);
    expect(selectedSection()).toBe('overview');
    expect(find('vorgang-section-panel-overview')).not.toBeNull();
  });

  // R8 — der bestehende Deep-Link bleibt gültig.
  it('R8: ein Deep-Link ohne Tab öffnet die Übersicht', async () => {
    await renderApp(`/vorgaenge/${VORGANG_A}`);
    expect(selectedSection()).toBe('overview');
  });

  // R15 — Zurück und Vorwärts folgen der Adresse.
  it('R15: Zurück und Vorwärts führen durch die Bereiche', async () => {
    await renderApp(`/vorgaenge/${VORGANG_A}`);
    await openTab('order');
    await openTab('invoices');
    expect(currentSearch).toContain('vtab=invoices');

    await go(-1);
    expect(selectedSection()).toBe('order');
    await go(1);
    expect(selectedSection()).toBe('invoices');
  });

  // R9 — die Sitzung eines anderen Vorgangs wird nie übernommen.
  it('R9: der Arbeitsstand eines anderen Vorgangs landet nie hier', async () => {
    await renderApp(`/vorgaenge/${VORGANG_A}`);
    await openTab('amendments');
    await leaveToOtherApp();

    await act(async () => root.unmount());
    host.remove();
    host = createHost();
    resetUiSessionLiveState();
    await renderApp(`/vorgaenge/${VORGANG_B}`);

    expect(selectedSection(), 'B übernahm den Bereich von A').toBe('overview');
  });
});

describe('GLOBAL-WORKSPACE-CONTINUITY-01B — Sitzungsspeicher', () => {
  function snapshotFor(pathname: string, search = '', overrides: Partial<UiSessionSnapshot> = {}) {
    return {
      ...buildUiSessionSnapshot({ pathname, search, userId: null }),
      ...overrides,
    };
  }

  // R4 (Dienstebene) — getrennte Einträge je Arbeitsplatz.
  it('R4: zwei Vorgänge belegen zwei Einträge', () => {
    saveUiSessionSnapshot(snapshotFor(`/vorgaenge/${VORGANG_A}`));
    saveUiSessionSnapshot(snapshotFor(`/vorgaenge/${VORGANG_B}`));

    expect(loadUiSessionSnapshotForRoute(`/vorgaenge/${VORGANG_A}`)?.entityId).toBe(VORGANG_A);
    expect(loadUiSessionSnapshotForRoute(`/vorgaenge/${VORGANG_B}`)?.entityId).toBe(VORGANG_B);
  });

  // R12 — die Liste bleibt klein, der aktuelle Eintrag bleibt vorn.
  it('R12: mehr Arbeitsplätze als erlaubt verdrängen die ältesten', () => {
    for (let index = 0; index < UI_SESSION_MAX_ENTRIES + 3; index += 1) {
      saveUiSessionSnapshot(snapshotFor(`/vorgaenge/v-${index}`));
    }
    const raw = JSON.parse(sessionStorage.getItem(UI_SESSION_STORAGE_KEY)!);

    expect(raw.entries).toHaveLength(UI_SESSION_MAX_ENTRIES);
    const newest = `/vorgaenge/v-${UI_SESSION_MAX_ENTRIES + 2}`;
    expect(loadUiSessionSnapshot()?.route.pathname).toBe(newest);
    expect(loadUiSessionSnapshotForRoute(newest)).not.toBeNull();
    expect(loadUiSessionSnapshotForRoute('/vorgaenge/v-0'), 'Ältester nicht verdrängt').toBeNull();
  });

  // R13 — ein alter Einzelschnappschuss wird übernommen.
  it('R13: das alte Einzelformat wird migriert', () => {
    const legacy = snapshotFor(`/vorgaenge/${VORGANG_A}`);
    sessionStorage.setItem(UI_SESSION_STORAGE_KEY, JSON.stringify(legacy));

    expect(loadUiSessionSnapshotForRoute(`/vorgaenge/${VORGANG_A}`)?.id).toBe(legacy.id);
    expect(loadUiSessionSnapshot()?.id).toBe(legacy.id);
  });

  // R14 — Unbekanntes wird verworfen, nicht halb übernommen.
  it('R14: ein unbekanntes Format wird sicher verworfen', () => {
    sessionStorage.setItem(UI_SESSION_STORAGE_KEY, '{"nonsense":true}');
    expect(loadUiSessionSnapshot()).toBeNull();

    sessionStorage.setItem(UI_SESSION_STORAGE_KEY, 'kein json');
    expect(loadUiSessionSnapshot()).toBeNull();
  });

  // R11 — abgelaufene Arbeitsstände werden nicht wiederaufgenommen.
  it('R11: ein abgelaufener Arbeitsstand wird nicht übernommen', () => {
    const stale = snapshotFor(`/vorgaenge/${VORGANG_A}`, '', {
      savedAt: new Date(Date.now() - UI_SESSION_TTL_MS - 60_000).toISOString(),
    });
    saveUiSessionSnapshot(stale);

    const decision = decideUiSessionRestore({
      userId: null,
      currentPathname: `/vorgaenge/${VORGANG_A}`,
      currentSearch: '',
    });

    expect(decision.intent).toBe('ignore');
    expect(decision.reason).toBe('ttl');
  });

  // R10 — fremder Scope wird nie übernommen.
  it('R10: ein Arbeitsstand aus einem anderen Scope wird nicht übernommen', () => {
    saveUiSessionSnapshot(
      snapshotFor(`/vorgaenge/${VORGANG_A}`, '', { scopeKey: 'workspace:fremd' }),
    );

    const decision = decideUiSessionRestore({
      userId: null,
      currentPathname: `/vorgaenge/${VORGANG_A}`,
      currentSearch: '',
    });

    expect(decision.intent).toBe('ignore');
    expect(decision.reason).toBe('scope');
  });

  /*
   * Die Schlüsselsemantik: Navigationsparameter trennen keine Arbeitsplätze,
   * identitätsstiftende schon. Sonst bekäme jeder Tab derselben Vorgangsseite
   * einen eigenen Arbeitsstand — und die Scrollposition des Nachbartabs
   * tauchte beim Zurückwechseln wieder auf.
   */
  it('Schlüssel: vtab und step trennen nicht, type trennt', () => {
    expect(buildUiSessionRouteKey('/vorgaenge/a', '?vtab=order')).toBe('/vorgaenge/a');
    expect(buildUiSessionRouteKey('/vorgaenge/a/rechnung', '?type=rechnung&step=preview')).toBe(
      '/vorgaenge/a/rechnung?type=rechnung',
    );
    expect(
      routesMatch(
        { pathname: '/vorgaenge/a', search: '' },
        { pathname: '/vorgaenge/a', search: '?vtab=order' },
      ),
    ).toBe(true);
    expect(
      routesMatch(
        { pathname: '/vorgaenge/a/rechnung', search: '?type=rechnung' },
        { pathname: '/vorgaenge/a/rechnung', search: '?type=abschlag' },
      ),
    ).toBe(false);
  });

  it('Schlüssel: Scope, Workspace und Entität stehen im Eintragsschlüssel', () => {
    const snapshot = snapshotFor(`/vorgaenge/${VORGANG_A}`);
    const key = buildUiSessionEntryKey(snapshot);

    expect(key).toContain(snapshot.scopeKey);
    expect(key).toContain(`vorgang:${VORGANG_A}`);
  });
});
