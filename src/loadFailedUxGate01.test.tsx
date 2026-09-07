/**
 * LOAD_FAILED-UX-GUARD-01B — eine stumm leere App ist keine sichere App.
 *
 * Nach einem Ladefehler bewahrt der Persistenz-Guard den gespeicherten Rohwert,
 * die Fachspeicher bleiben aber leer. Ohne sichtbare Blockade sähe der Nutzer
 * ein ganz normales, leeres OfficePilot — und würde beginnen, seine Daten neu
 * zu erfassen. Genau das ist die Handlung, die den geretteten Bestand am Ende
 * doch zerstört.
 *
 * Geprüft wird deshalb nicht nur, dass eine Meldung erscheint, sondern dass die
 * normale Oberfläche **nicht** erscheint.
 *
 * Synthetische Daten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { BusinessStateGate } from './components/system/BusinessStateGate';
import { useApp } from './context/AppContext';
import { createSeedState, savePersistedStateToKey } from './services/persistenceService';
import { buildStorageKey, setActiveStorageScope } from './services/storage/storageScopeService';
import { resetTestStores } from './test/resetStores';
import { createTestVorgang } from './test/fixtures';

const GUEST_KEY = buildStorageKey({ type: 'guest' });

/** Kein angemeldeter Nutzer — der Gastpfad ist der kürzeste Weg zum Bootstrap. */
vi.mock('./context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    session: null,
    isAuthenticated: false,
    isAllowed: false,
    isAdmin: false,
    isAuthReady: true,
    profileError: false,
    login: async () => ({ success: false }),
    logout: async () => undefined,
    register: async () => ({ success: false }),
    refreshAuth: async () => undefined,
    approveUser: async () => ({ success: false }),
    blockUser: async () => ({ success: false }),
    extendLicense: async () => ({ success: false }),
    expireLicense: async () => ({ success: false }),
    grantBetaLicense: async () => ({ success: false }),
  }),
}));

/** Steht diese Sonde im Baum, ist die normale Business-Oberfläche freigegeben. */
function BusinessProbe() {
  const { setup } = useApp();
  return createElement('div', { 'data-testid': 'business-ui' }, setup.companyName);
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderGate(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        null,
        createElement(BusinessStateGate, null, createElement(BusinessProbe)),
      ),
    );
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function find(testId: string): HTMLElement | null {
  return host?.querySelector(`[data-testid="${testId}"]`) ?? null;
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  setActiveStorageScope({ type: 'guest' });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('LOAD_FAILED-UX-GUARD-01B — sichtbare Blockade', () => {
  it('R8: ein Ladefehler zeigt die Schutzansicht statt der normalen Oberfläche', async () => {
    const rawBefore = '{beschädigt';
    localStorage.setItem(GUEST_KEY, rawBefore);

    await renderGate();

    expect(find('local-state-load-failure'), 'Keine Schutzansicht').not.toBeNull();
    expect(find('business-ui'), 'Die normale Oberfläche war bedienbar').toBeNull();
    expect(localStorage.getItem(GUEST_KEY), 'Der Bestand wurde berührt').toBe(rawBefore);
  });

  it('R8b: die Ansicht erklärt, dass nichts überschrieben wurde', async () => {
    localStorage.setItem(GUEST_KEY, '{beschädigt');

    await renderGate();

    const text = find('local-state-load-failure')?.textContent ?? '';
    expect(text).toContain('nicht sicher geladen');
    expect(text, 'Kein Hinweis auf die Datensicherheit').toContain('keine Daten überschrieben');
    expect(text, 'Kein Hinweis auf die Sperre').toContain('gesperrt');
    // Kein Weg, der zum Weiterarbeiten oder Neuanfangen einlädt.
    expect(text.toLowerCase()).not.toContain('neu einrichten');
  });

  it('R9: ein gültiger Bestand gibt die normale Oberfläche frei', async () => {
    savePersistedStateToKey(
      { type: 'guest' },
      { ...createSeedState(), vorgaenge: [createTestVorgang({ id: 'v-bestand' })] },
    );

    await renderGate();

    expect(find('business-ui'), 'Die normale Oberfläche fehlte').not.toBeNull();
    expect(find('local-state-load-failure')).toBeNull();
  });

  it('R10: ein echter Erststart bleibt unverändert', async () => {
    await renderGate();

    expect(find('business-ui'), 'Der Erststart wurde blockiert').not.toBeNull();
    expect(find('local-state-load-failure')).toBeNull();
  });
});
