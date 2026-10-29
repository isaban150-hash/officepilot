/**
 * EINRICHTUNG-01 (AP1, Z-08.1; Vertrag 1.3) — Vorgangsdetail im Nur-Lesen-Betrieb.
 *
 * Der Vorgang bleibt vollständig lesbar (Kopf, Status, Positionen, Rechnungsliste, Navigation zwischen den
 * Abschnitten). Gesperrt sind die Schreibbereiche: Erfassen (Foto, Nachricht, Brief), Kunde zuordnen, Status,
 * Auftrag und Positionen, Nachträge, Kosten und Abrechnung, Notizen, KI. Ein Klick auf ein gesperrtes
 * Bedienelement bewirkt nichts. Gegenprobe: mit wirksamer Lizenz ist nichts davon gesperrt.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { VorgangDetailPage } from './VorgangDetailPage';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { loginAsDefaultAdmin, resetAuthForTests } from '../test/authFixtures';
import { getMockCurrentSession } from '../test/mockSupabaseAuth';
import { resetTestStores } from '../test/resetStores';
import * as supabaseLib from '../lib/supabase';
import { hydrateVorgangStore } from '../services/vorgangService';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { refreshWorkspaceAccess, resetWorkspaceAccessForTests } from '../services/workspace/workspaceAccessService';
import { t } from '../i18n';
import type { Vorgang } from '../types/models';

const WS = '00000000-0000-4000-8000-00000000e802';
const VORGANG_ID = 'v-ein01-nur-lesen';

let host: HTMLDivElement;
let root: Root;
let userId = '';

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function lizenz(state: 'effective' | 'expired'): Promise<void> {
  const client = {
    rpc: () =>
      Promise.resolve({
        data: { workspace_id: WS, role: 'owner', license_state: state, license_effective: state === 'effective' },
        error: null,
      }),
  } as never;
  const r = await refreshWorkspaceAccess(client);
  expect(r.ok).toBe(true);
}

async function render(node: ReactNode): Promise<void> {
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/${VORGANG_ID}`]}>
        <AuthProvider>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
            <Routes>
              <Route path="/vorgaenge/:id" element={node} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

function knopf(bereich: Element | null, text: string): HTMLButtonElement | undefined {
  return Array.from(bereich?.querySelectorAll('button') ?? []).find((b) => (b.textContent ?? '').trim() === text);
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  resetWorkspaceAccessForTests();
  localStorage.clear();
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  await loginAsDefaultAdmin();
  userId = getMockCurrentSession()?.user.id ?? '';
  expect(userId).not.toBe('');
  setActiveStorageScope({ type: 'workspace', workspaceId: WS, account: { userId, access: 'full' } });
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'Betrieb', ownerUserId: userId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WS, userId, role: 'owner', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
  const vorgang = createTestVorgang({ id: VORGANG_ID, orderPositions: [createOrderPosition({ id: 'op-ein01', description: 'Leistung A' })] });
  delete (vorgang as Partial<Vorgang>).contractConfirmation;
  hydrateVorgangStore([vorgang]);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  resetWorkspaceAccessForTests();
  resetTestStores();
  localStorage.clear();
});

describe('EINRICHTUNG-01 AP1 — Vorgangsdetail im Nur-Lesen-Betrieb (Z-08.1)', () => {
  it('lesbar, aber die Schreibbereiche sind gesperrt; ein Klick bewirkt nichts', async () => {
    await lizenz('expired');
    await render(<VorgangDetailPage />);

    // Lesen: Kopf, Positionen und Abschnittsnavigation bleiben.
    expect(q('vorgang-detail-header')).not.toBeNull();
    expect(host.textContent).toContain('Leistung A');
    const tab = q('vorgang-section-tab-order') as HTMLButtonElement;
    expect(tab.closest('fieldset[disabled]')).toBeNull();

    for (const bereich of ['vorgang-read-only-actions', 'vorgang-read-only-overview', 'vorgang-read-only-order', 'vorgang-read-only-amendments', 'vorgang-read-only-billing']) {
      const feld = q(bereich);
      expect(feld, bereich).not.toBeNull();
      expect(feld?.tagName, bereich).toBe('FIELDSET');
      expect((feld as HTMLFieldSetElement).disabled, bereich).toBe(true);
    }
    // Status ist eine Auswahl im gesperrten Bereich.
    const status = q('vorgang-status-select');
    if (status) expect(status.closest('fieldset[disabled]')).not.toBeNull();

    // Position bearbeiten: Der Knopf liegt im gesperrten Bereich, ein Klick öffnet kein Formular.
    await act(async () => {
      tab.click();
    });
    const bearbeiten = knopf(q('vorgang-read-only-order'), t('position.edit', 'de'));
    expect(bearbeiten, 'Bearbeiten-Knopf').toBeDefined();
    await act(async () => {
      bearbeiten!.click();
    });
    await settle(4);
    expect(host.querySelector('.order-position-form')).toBeNull();
    // Keine neue Rechnung aus dem Vorgang heraus.
    expect(q('vorgang-prepare-invoice')).toBeNull();
  });

  it('Gegenprobe: mit wirksamer Lizenz ist nichts gesperrt', async () => {
    await lizenz('effective');
    await render(<VorgangDetailPage />);
    expect(host.querySelector('fieldset[disabled]')).toBeNull();
    expect(q('vorgang-read-only-order')).toBeNull();
    const tab = q('vorgang-section-tab-order') as HTMLButtonElement;
    await act(async () => {
      tab.click();
    });
    const bearbeiten = knopf(host.querySelector('[data-testid="vorgang-section-panel-order"]'), t('position.edit', 'de'));
    expect(bearbeiten).toBeDefined();
    await act(async () => {
      bearbeiten!.click();
    });
    await settle(4);
    expect(host.querySelector('.order-position-form')).not.toBeNull();
  });
});
