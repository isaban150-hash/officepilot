// EINRICHTUNG-01 (Eigenprüfung, B-2; AP2 A-01, A-12) — Startwettlauf im AuthContext. Ein Auth-Ereignis (etwa
// SIGNED_IN) während des Startlaufs macht dessen Profilabruf veraltet. Die App darf dann nicht „bereit, aber abgemeldet“
// werden (Umweg einer angemeldeten Person über /login), sondern wartet, bis der neuere Lauf angewendet ist — und bleibt
// in keinem Zweig im Ladezustand hängen.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../App';
import { DEFAULT_SETUP } from '../data/mockData';
import { loginAsDefaultAdmin } from '../test/authFixtures';
import {
  emitMockAuthEvent,
  getMockProfileFetchCount,
  releaseMockProfileFetches,
  releaseOldestMockProfileFetch,
  setMockProfileFetchMode,
} from '../test/mockSupabaseAuth';
import { AppProvider } from './AppContext';
import { AuthProvider } from './AuthContext';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

type Mount = { container: HTMLDivElement; root: Root };

/** Schreibt jede angezeigte Adresse mit (auch einen kurzen Umweg). */
function Adressen({ protokoll }: { protokoll: string[] }) {
  const ort = useLocation();
  useEffect(() => {
    protokoll.push(`${ort.pathname}${ort.search}`);
  }, [ort, protokoll]);
  return null;
}

async function mount(path: string, protokoll: string[]): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Adressen protokoll={protokoll} />
        <AuthProvider>
          <AppProvider initialSetup={completeSetup}>
            <App />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  return { container, root };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const sichtbar = (m: Mount, id: string) => m.container.querySelector(`[data-testid="${id}"]`) !== null;

describe('EINRICHTUNG-01 B-2 — Startwettlauf im AuthContext', () => {
  let mounted: Mount | undefined;

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = undefined;
    }
  });

  it('Ereignis während des Startlaufs: kein Umweg über /login, Ladezustand bis der neuere Lauf gilt', async () => {
    await loginAsDefaultAdmin();
    const basis = getMockProfileFetchCount();
    setMockProfileFetchMode('hold');
    const protokoll: string[] = [];
    mounted = await mount('/', protokoll);
    await flush();
    expect(getMockProfileFetchCount()).toBe(basis + 1); // der Startlauf wartet auf das Profil

    await act(async () => {
      emitMockAuthEvent('SIGNED_IN');
      await Promise.resolve();
    });
    await flush();
    expect(getMockProfileFetchCount()).toBe(basis + 2); // der neuere Lauf ebenfalls

    // Zuerst kommt die Antwort des (jetzt veralteten) Startlaufs.
    await act(async () => {
      releaseOldestMockProfileFetch();
      await Promise.resolve();
    });
    await flush();
    expect(sichtbar(mounted, 'login-page')).toBe(false);
    expect(sichtbar(mounted, 'auth-loading')).toBe(true);

    await act(async () => {
      releaseMockProfileFetches();
      await Promise.resolve();
    });
    await flush();
    expect(sichtbar(mounted, 'heute-page')).toBe(true);
    expect(protokoll.filter((a) => a.startsWith('/login'))).toEqual([]);
  });

  it('ohne Ereignis unverändert: der Startlauf allein setzt „bereit“', async () => {
    await loginAsDefaultAdmin();
    setMockProfileFetchMode('hold');
    const protokoll: string[] = [];
    mounted = await mount('/', protokoll);
    await flush();
    expect(sichtbar(mounted, 'auth-loading')).toBe(true);

    await act(async () => {
      releaseMockProfileFetches();
      await Promise.resolve();
    });
    await flush();
    expect(sichtbar(mounted, 'heute-page')).toBe(true);
    expect(protokoll.filter((a) => a.startsWith('/login'))).toEqual([]);
  });

  it('Abmeldung während des Startlaufs: sofort bereit mit Anmeldeseite, der veraltete Startlauf holt niemanden zurück', async () => {
    await loginAsDefaultAdmin();
    setMockProfileFetchMode('hold');
    const protokoll: string[] = [];
    mounted = await mount('/', protokoll);
    await flush();

    await act(async () => {
      emitMockAuthEvent('SIGNED_OUT');
      await Promise.resolve();
    });
    await flush();
    expect(sichtbar(mounted, 'auth-loading')).toBe(false);
    expect(sichtbar(mounted, 'login-page')).toBe(true);

    await act(async () => {
      releaseMockProfileFetches();
      await Promise.resolve();
    });
    await flush();
    expect(sichtbar(mounted, 'login-page')).toBe(true);
    expect(sichtbar(mounted, 'heute-page')).toBe(false);
  });

  it('der Server weist die Sitzung im neueren Lauf ab: Abmeldung und bereit, kein Hängen im Ladezustand', async () => {
    await loginAsDefaultAdmin();
    setMockProfileFetchMode('hold');
    const protokoll: string[] = [];
    mounted = await mount('/', protokoll);
    await flush();
    await act(async () => {
      emitMockAuthEvent('SIGNED_IN');
      await Promise.resolve();
    });
    await flush();

    setMockProfileFetchMode('unauthorized');
    await act(async () => {
      releaseMockProfileFetches();
      await Promise.resolve();
    });
    await flush();
    expect(sichtbar(mounted, 'auth-loading')).toBe(false);
    expect(sichtbar(mounted, 'login-page')).toBe(true);
    expect(sichtbar(mounted, 'heute-page')).toBe(false);
  });
});
