/**
 * EINRICHTUNG-01 (AP1; Z-08.1, Z-08.2, Z-08.4, Z-03.1; Vertrag 1.3, E5) — Nur-Lesen und „keine Lizenz“ im echten
 * Stapel AuthProvider → BusinessStateGate → App. Gestubbt sind nur die RPC-Antworten; kein Netzwerk.
 *
 *   N1 (Z-08.1) Inhaber, Betriebslizenz abgelaufen: Nur-Lesen-Hinweis auf jeder Seite; Einstellungen ohne Speichern,
 *      mit Lizenzhinweis; reine Schreibseiten (Rechnungseditor, Scan, Upload, neue Ausgabe) öffnen sich nicht.
 *   N2 (Z-08.2) Sicherung bleibt für den Inhaber erreichbar, das Mitglied bekommt sie nicht.
 *   N3 (Z-08.4) keine Sperrseite: Benutzermenü mit Abmelden bleibt, Abmelden funktioniert.
 *   N4 (Vertrag 1.7) Verlängerung: die nächste Abfrage hebt Nur-Lesen ohne Neustart auf.
 *   N5 je Rolle der passende Hinweis (Inhaber, Admin, Mitglied).
 *   N6 (Z-03.1) freigegeben, aber ohne Betrieb und ohne Lizenz: Hinweis mit nächstem Schritt, kein Assistent, nichts
 *      gesendet; „Erneut prüfen“ fragt wirklich erneut; „Abmelden“ meldet ab.
 *   N7 (Z-08.1, F-04.2; WEISS S011 §4, Z1) Kontenrahmen: wählen nur Inhaber und Admin bei wirksamer Betriebslizenz;
 *      Mitglied und Nur-Lesen sehen den Wert, die Auswahl ist gesperrt, mit Hinweis; nichts geändert, nichts gesendet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import { resetWorkspaceCloudBootstrapForTests } from './services/workspace/workspaceCloudBootstrapService';
import { resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { refreshWorkspaceAccess, resetWorkspaceAccessForTests } from './services/workspace/workspaceAccessService';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { loginAsDefaultAdmin } from './test/authFixtures';
import { getMockCurrentSession } from './test/mockSupabaseAuth';
import { hasChosenChartOfAccounts } from './services/accounting/accountingSettingsService';
import type { WorkspaceRole } from './types/workspace';

const WORKSPACE_ID = '00000000-0000-4000-8000-00000000e801';
const OWNER_ELSEWHERE = 'konto-inhaber-anderswo';
const COMPANY_NAME = 'Nur-Lesen Beispiel GmbH';

let userId = '';
let rolle: WorkspaceRole = 'owner';
let lizenz: 'effective' | 'expired' | 'inactive' = 'expired';
let ensureNoLicense = false;
/** Betriebseinstellungen im Abzug (N7); sonst keine. */
let settingsRow: Record<string, unknown> | null = null;
const rpcLog: string[] = [];

function workspaceRow() {
  return {
    id: WORKSPACE_ID,
    name: COMPANY_NAME,
    owner_user_id: rolle === 'owner' ? userId : OWNER_ELSEWHERE,
    created_at: '2026-01-05T08:00:00.000Z',
    updated_at: '2026-05-05T08:00:00.000Z',
    version: 3,
  };
}

function memberRow() {
  return {
    workspace_id: WORKSPACE_ID,
    user_id: userId,
    role: rolle,
    status: 'active',
    created_at: '2026-01-05T08:00:00.000Z',
    updated_at: '2026-01-05T08:00:00.000Z',
  };
}

function registerHandlers(): void {
  registerMockRpcHandler('ensure_personal_workspace', () => {
    rpcLog.push('ensure_personal_workspace');
    if (ensureNoLicense) return { workspace: null, member: null, created: false, reason: 'no_license' };
    return { workspace: workspaceRow(), member: memberRow(), created: false };
  });
  registerMockRpcHandler('pull_workspace_sync_state', () => {
    rpcLog.push('pull_workspace_sync_state');
    return {
      workspace: workspaceRow(),
      members: [memberRow()],
      settings: settingsRow,
      vorgaenge: [],
      setup: {
        workspace_id: WORKSPACE_ID,
        payload: { ...DEFAULT_SETUP, companyName: COMPANY_NAME, setupComplete: true, setupVersion: 1 },
        row_version: 7,
        updated_at: '2026-05-05T08:00:00.000Z',
      },
      company_profile: {
        workspace_id: WORKSPACE_ID,
        payload: { ...DEFAULT_COMPANY_PROFILE, companyName: COMPANY_NAME },
        row_version: 7,
        updated_at: '2026-05-05T08:00:00.000Z',
      },
    };
  });
  registerMockRpcHandler('get_workspace_access', (args) => {
    rpcLog.push('get_workspace_access');
    return {
      workspace_id: args.p_workspace_id,
      role: rolle,
      license_state: lizenz,
      license_effective: lizenz === 'effective',
    };
  });
  registerMockRpcHandler('pull_workspace_invoices', () => []);
  registerMockRpcHandler('pull_workspace_order_amendments', () => []);
  registerMockRpcHandler('upsert_workspace_sync_entity', (args) => {
    rpcLog.push(`upsert:${String(args.p_entity_type ?? '')}`);
    return { row_version: 8, payload: args.p_payload ?? {} };
  });
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountApp(initialEntry = '/'): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <BusinessStateGate>
            <App />
          </BusinessStateGate>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  return host;
}

async function unmountApp(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
}

const q = (container: HTMLElement, id: string) => container.querySelector(`[data-testid="${id}"]`);

async function click(container: HTMLElement, testId: string): Promise<void> {
  const element = q(container, testId) as HTMLButtonElement | null;
  expect(element, `Schaltfläche ${testId} fehlt`).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await settle();
}

describe('EINRICHTUNG-01 AP1 — Nur-Lesen im echten Stapel', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    rpcLog.length = 0;
    rolle = 'owner';
    lizenz = 'expired';
    ensureNoLicense = false;
    settingsRow = null;
    clearMockRpcHandlers();
    registerHandlers();
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    resetWorkspaceAccessForTests();
    await loginAsDefaultAdmin();
    userId = getMockCurrentSession()?.user.id ?? '';
    expect(userId, 'Testanmeldung fehlgeschlagen').not.toBe('');
    localStorage.clear();
  });

  afterEach(async () => {
    await unmountApp();
    clearMockRpcHandlers();
    resetTestStores();
    resetWorkspaceCloudBootstrapForTests();
    resetWorkspaceAccessForTests();
    localStorage.clear();
  });

  it('N1/N3 (Z-08.1, Z-08.4) Inhaber mit abgelaufener Betriebslizenz: Hinweis, Einstellungen gesperrt, Schreibseiten zu, Abmelden bleibt', async () => {
    const container = await mountApp('/');
    expect(q(container, 'app-shell'), 'App nicht geöffnet').not.toBeNull();
    expect(rpcLog).toContain('get_workspace_access');
    const banner = q(container, 'workspace-read-only-banner');
    expect(banner, 'Nur-Lesen-Hinweis fehlt').not.toBeNull();
    expect(banner?.getAttribute('data-role')).toBe('owner');
    expect(banner?.textContent).toContain('Die Lizenz Ihres Betriebs ist nicht wirksam');
    // Keine Sperrseite (Z-08.4): kein Lizenzablauf-Bildschirm, Benutzermenü mit Abmelden vorhanden.
    expect(q(container, 'license-expired-page')).toBeNull();
    expect(q(container, 'user-menu')).not.toBeNull();
    await unmountApp();

    const einstellungen = await mountApp('/einstellungen/firma');
    expect(q(einstellungen, 'settings-company-readonly')?.textContent).toContain('Die Einstellungen lassen sich ansehen');
    expect(q(einstellungen, 'settings-company-save')).toBeNull();
    await unmountApp();

    for (const route of [
      `/vorgaenge/v-nur-lesen/rechnung`,
      '/rechnungen/neu',
      '/scan',
      '/dokumente/upload',
      '/ausgaben/neu',
      '/schreiben/neu',
      '/angebote/neu',
      '/kommunikation/email/neu',
    ]) {
      const seite = await mountApp(route);
      expect(q(seite, 'read-only-route-blocked'), route).not.toBeNull();
      expect(q(seite, 'workspace-read-only-banner'), route).not.toBeNull();
      await unmountApp();
    }
    // Nichts wurde gesendet.
    expect(rpcLog.filter((name) => name.startsWith('upsert:'))).toEqual([]);

    // Abmelden aus dem Benutzermenü funktioniert auch im Nur-Lesen-Betrieb.
    const abmelden = await mountApp('/');
    await click(abmelden, 'user-menu-dropdown-trigger');
    await click(abmelden, 'logout-button');
    expect(q(abmelden, 'app-shell')).toBeNull();
    expect(abmelden.querySelector('form')).not.toBeNull();
  });

  it('N2 (Z-08.2) Sicherung: Inhaber erreicht sie im Nur-Lesen-Betrieb, das Mitglied nicht', async () => {
    // EINRICHTUNG-01 (AP5; 1.15) — die Sicherung hat eine eigene Seite („Daten › Sicherung“).
    const inhaber = await mountApp('/einstellungen/daten/sicherung');
    expect(q(inhaber, 'workspace-read-only-banner')).not.toBeNull();
    expect(q(inhaber, 'backup-export-download'), 'Sicherung für den Inhaber').not.toBeNull();
    expect(q(inhaber, 'backup-export-not-allowed')).toBeNull();
    await unmountApp();

    rolle = 'member';
    resetWorkspaceCloudBootstrapForTests();
    resetWorkspaceAccessForTests();
    localStorage.clear();
    const mitglied = await mountApp('/einstellungen/daten/sicherung');
    expect(q(mitglied, 'workspace-read-only-banner')?.getAttribute('data-role')).toBe('member');
    expect(q(mitglied, 'backup-export-not-allowed'), 'Mitglied ohne Sicherung').not.toBeNull();
    expect(q(mitglied, 'backup-export-download')).toBeNull();
  });

  it('N4 (Vertrag 1.7) Verlängerung: die nächste Abfrage hebt Nur-Lesen ohne Neustart auf', async () => {
    const container = await mountApp('/einstellungen/firma');
    expect(q(container, 'workspace-read-only-banner')).not.toBeNull();
    expect(q(container, 'settings-company-save')).toBeNull();

    lizenz = 'effective';
    await act(async () => {
      await refreshWorkspaceAccess();
    });
    await settle();
    expect(q(container, 'workspace-read-only-banner')).toBeNull();
    expect(q(container, 'settings-company-readonly')).toBeNull();
    expect(q(container, 'settings-company-save')).not.toBeNull();
  });

  it('N5 je Rolle der passende Hinweis', async () => {
    const texte: Record<WorkspaceRole, string> = {
      owner: 'Die Lizenz Ihres Betriebs ist nicht wirksam',
      admin: 'sobald der Inhaber die Lizenz verlängert hat',
      member: 'Sie können alles ansehen und gespeicherte Dateien herunterladen und drucken',
    };
    for (const r of ['owner', 'admin', 'member'] as const) {
      rolle = r;
      resetWorkspaceCloudBootstrapForTests();
      resetWorkspaceAccessForTests();
      localStorage.clear();
      const container = await mountApp('/');
      const banner = q(container, 'workspace-read-only-banner');
      expect(banner?.getAttribute('data-role'), r).toBe(r);
      expect(banner?.textContent, r).toContain(texte[r]);
      await unmountApp();
    }
    // Wirksame Lizenz: kein Hinweis.
    lizenz = 'effective';
    rolle = 'admin';
    resetWorkspaceCloudBootstrapForTests();
    resetWorkspaceAccessForTests();
    localStorage.clear();
    const normal = await mountApp('/');
    expect(q(normal, 'app-shell')).not.toBeNull();
    expect(q(normal, 'workspace-read-only-banner')).toBeNull();
  });

  it('N6 (Z-03.1) ohne Betrieb und ohne Lizenz: Hinweis mit nächstem Schritt, kein Assistent, nichts gesendet', async () => {
    ensureNoLicense = true;
    const container = await mountApp('/');
    expect(q(container, 'workspace-no-license'), 'Hinweis fehlt').not.toBeNull();
    expect(q(container, 'workspace-no-license-next')?.textContent).toContain('Nächster Schritt');
    expect(q(container, 'first-run-wizard')).toBeNull();
    expect(q(container, 'app-shell')).toBeNull();
    expect(q(container, 'workspace-restore-failure')).toBeNull();
    expect(rpcLog.filter((name) => name.startsWith('upsert:'))).toEqual([]);
    expect(rpcLog).not.toContain('pull_workspace_sync_state');

    const vorher = rpcLog.filter((name) => name === 'ensure_personal_workspace').length;
    await click(container, 'workspace-no-license-recheck');
    expect(rpcLog.filter((name) => name === 'ensure_personal_workspace').length).toBe(vorher + 1);
    expect(q(container, 'workspace-no-license')).not.toBeNull();

    await click(container, 'workspace-no-license-logout');
    expect(q(container, 'workspace-no-license')).toBeNull();
    expect(container.querySelector('form')).not.toBeNull();
  });

  /** Wie eine Auswahl im Browser: Wert setzen, `change` auslösen. */
  async function kontenrahmenWaehlen(container: HTMLElement, wert: string): Promise<void> {
    const select = q(container, 'settings-chart-of-accounts-select') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, wert);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
  }

  it('N7a (Z-08.1, F-04.2; Z1) Kontenrahmen gesperrt: Mitglied und Nur-Lesen sehen den Wert mit Hinweis; nichts geändert, nichts gesendet', async () => {
    settingsRow = { workspace_id: WORKSPACE_ID, settings: {}, version: 2, updated_at: '2026-05-05T08:00:00.000Z' };
    const faelle: Array<[WorkspaceRole, 'effective' | 'expired', string]> = [
      ['owner', 'expired', 'Die Einstellungen lassen sich ansehen'],
      ['admin', 'expired', 'Die Einstellungen lassen sich ansehen'],
      ['member', 'expired', 'Die Einstellungen lassen sich ansehen'],
      // EINRICHTUNG-01 (AP5; 1.16) — der einheitliche Rollenhinweis.
      ['member', 'effective', 'nur Inhaber und Administratoren ändern'],
    ];
    for (const [r, l, hinweis] of faelle) {
      const fall = `${r}/${l}`;
      rolle = r;
      lizenz = l;
      resetWorkspaceCloudBootstrapForTests();
      resetWorkspaceAccessForTests();
      localStorage.clear();
      rpcLog.length = 0;
      const container = await mountApp('/einstellungen/kontenrahmen'); // EINRICHTUNG-01 (AP5; 1.15)
      const select = q(container, 'settings-chart-of-accounts-select') as HTMLSelectElement | null;
      expect(select, fall).not.toBeNull();
      expect(select!.value, fall).toBe('SKR03');
      expect(select!.disabled, fall).toBe(true);
      expect(q(container, 'settings-chart-of-accounts-readonly')?.textContent, fall).toContain(hinweis);
      await kontenrahmenWaehlen(container, 'SKR04');
      expect(hasChosenChartOfAccounts(), fall).toBe(false);
      expect(q(container, 'settings-chart-of-accounts-unset'), fall).not.toBeNull();
      expect(rpcLog.filter((name) => name.startsWith('upsert:')), fall).toEqual([]);
      await unmountApp();
    }
  });

  for (const r of ['owner', 'admin'] as const) {
    it(`N7b (Z1) Kontenrahmen bedienbar: ${r} bei wirksamer Betriebslizenz wählt, ohne Sperrhinweis`, async () => {
      settingsRow = { workspace_id: WORKSPACE_ID, settings: {}, version: 2, updated_at: '2026-05-05T08:00:00.000Z' };
      rolle = r;
      lizenz = 'effective';
      const container = await mountApp('/einstellungen/kontenrahmen'); // EINRICHTUNG-01 (AP5; 1.15)
      const select = q(container, 'settings-chart-of-accounts-select') as HTMLSelectElement;
      expect(select.disabled).toBe(false);
      expect(q(container, 'settings-chart-of-accounts-readonly')).toBeNull();
      await kontenrahmenWaehlen(container, 'SKR04');
      expect((q(container, 'settings-chart-of-accounts-select') as HTMLSelectElement).value).toBe('SKR04');
      expect(hasChosenChartOfAccounts()).toBe(true);
      expect(q(container, 'settings-chart-of-accounts-unset')).toBeNull();
    });
  }
});
