/**
 * EINRICHTUNG-01 (AP9; Vertrag 1.32, Q-04.1–Q-04.3) — Barrierefreiheit der B2-Seiten, eigene Prüfungen (axe-core über
 * Playwright braucht eine neue Entwicklungsabhängigkeit und bleibt bis zur Freigabe offen, Z-F4).
 *
 *   B1 jede sichtbare Eingabe, Auswahl und Textfläche hat einen zugänglichen Namen (`label`, `aria-label`,
 *      `aria-labelledby`, umschließendes `label` oder `title`) — auch Datei-Eingaben; jeder Knopf hat einen Namen.
 *   B2 Umschaltknöpfe (Sprache, Kanal) tragen `aria-pressed` passend zur Auswahl.
 *   B3 Skip-Link „Zum Inhalt springen“ ist das erste fokussierbare Element und setzt den Fokus auf die Überschrift.
 *   B4 Seitenwechsel: der Fokus springt auf die Seitenüberschrift (`h1`, `tabindex="-1"`); mit Anker in der Adresse
 *      nicht.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import * as supabaseLib from './lib/supabase';
import { LocalRecoveryImportPage } from './pages/LocalRecoveryImportPage';
import { LocalRecoveryPage } from './pages/LocalRecoveryPage';
import { ReplyToConfirmPage } from './pages/ReplyToConfirmPage';
import { SETTINGS_TARGET_PATHS, settingsTargetTitleKey } from './pages/settings/settingsHubConfig';
import { ServerErrorPage } from './pages/system/ServerErrorPage';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { resetUiSessionLiveState } from './services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot } from './services/uiSession/uiSessionStore';
import { workspaceChangeDeps } from './services/workspace/workspaceMembershipChangeService';
import { hydrateWorkspaceStore, resetWorkspaceStore } from './services/workspace/workspaceStore';
import { loginAsDefaultAdmin, resetAuthForTests } from './test/authFixtures';
import { signOutUser } from './services/auth/supabaseAuthService';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { getMockCurrentSession } from './test/mockSupabaseAuth';
import { resetTestStores } from './test/resetStores';

const W1 = '00000000-0000-0000-0000-0000000e9b01';
const STAMP = '2026-10-01T08:00:00.000Z';
const complete = { ...DEFAULT_SETUP, companyName: 'AP9 GmbH', setupComplete: true, setupVersion: 1 };

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let navigateTo: ((path: string) => void) | null = null;

function NavigateProbe() {
  const navigate = useNavigate();
  navigateTo = (path: string) => navigate(path);
  return null;
}

async function settle(runden = 30): Promise<void> {
  for (let i = 0; i < runden; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function mount(ui: ReactNode): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(ui);
  });
  await settle();
  return host;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
}

function app(entry: string, setup = complete): ReactNode {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <AppProvider initialSetup={setup}>
          <App />
          <NavigateProbe />
        </AppProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

function ausgeblendet(element: Element): boolean {
  for (let el: Element | null = element; el; el = el.parentElement) {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    if ((el as HTMLElement).style?.display === 'none') return true;
  }
  return false;
}

/** Vereinfachte Berechnung des zugänglichen Namens (ausreichend für die Prüfregeln aus 1.32). */
function zugaenglicherName(element: Element): string {
  const aria = element.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (element.id) {
    const label = Array.from(document.querySelectorAll('label')).find((l) => l.htmlFor === element.id);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  const umschliessend = element.closest('label');
  if (umschliessend?.textContent?.trim()) return umschliessend.textContent.trim();
  const title = element.getAttribute('title')?.trim();
  if (title) return title;
  if (element.tagName === 'BUTTON' || element.tagName === 'A') return element.textContent?.trim() ?? '';
  if (element instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(element.type)) return element.value.trim();
  return '';
}

function unbeschriftet(bereich: ParentNode): string[] {
  const funde: string[] = [];
  bereich.querySelectorAll('input, select, textarea, button').forEach((element) => {
    if (element instanceof HTMLInputElement && element.type === 'hidden') return;
    if (ausgeblendet(element)) return;
    if (!zugaenglicherName(element)) {
      const kennung = element.getAttribute('data-testid') ?? element.id ?? '';
      funde.push(`${element.tagName.toLowerCase()}${element instanceof HTMLInputElement ? `[type=${element.type}]` : ''} ${kennung}`.trim());
    }
  });
  return funde;
}

function ersteFokussierbare(): HTMLElement | null {
  return (
    host?.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? null
  );
}

function teamServer(me: string): void {
  registerMockRpcHandler('list_own_memberships', () => [
    { workspace_id: W1, workspace_name: 'AP9 GmbH', role: 'owner', status: 'active', member_since: STAMP },
  ]);
  registerMockRpcHandler('team_list_members', () => [
    { user_id: me, name: 'Olga Eins', role: 'owner', status: 'active', member_since: STAMP, is_self: true, email: 'olga@example.invalid', transfer_eligible: false },
  ]);
  registerMockRpcHandler('team_list_invitations', () => []);
  registerMockRpcHandler('team_open_transfer', () => null);
  registerMockRpcHandler('team_list_events', () => []);
  registerMockRpcHandler('list_my_invitations', () => []);
  registerMockRpcHandler('list_my_transfers', () => []);
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  localStorage.clear();
  sessionStorage.clear();
  clearMockRpcHandlers();
  resetWorkspaceStore();
  resetUiSessionLiveState();
  clearUiSessionSnapshot();
  setActiveStorageScope({ type: 'guest' });
  vi.spyOn(workspaceChangeDeps, 'reloadTo').mockImplementation(() => undefined);
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  clearMockRpcHandlers();
  setActiveStorageScope({ type: 'guest' });
  resetTestStores();
});

async function alsInhaber(): Promise<string> {
  await loginAsDefaultAdmin();
  const me = getMockCurrentSession()?.user.id ?? '';
  setActiveStorageScope({ type: 'workspace', workspaceId: W1, account: { userId: me, access: 'full' } });
  hydrateWorkspaceStore({
    workspace: { id: W1, name: 'AP9 GmbH', ownerUserId: me, createdAt: STAMP, updatedAt: STAMP, version: 1 },
    workspaceMembers: [{ workspaceId: W1, userId: me, role: 'owner', status: 'active', createdAt: STAMP, updatedAt: STAMP }],
  } as never);
  teamServer(me);
  return me;
}

const EINSTELLUNGSSEITEN = [
  '/einstellungen',
  ...Object.values(SETTINGS_TARGET_PATHS).filter((pfad) => pfad.startsWith('/einstellungen')),
];

describe('EINRICHTUNG-01 AP9 — Barrierefreiheit (1.32)', { timeout: 120_000 }, () => {
  it('B1/B3: Einstellungsseiten — alles beschriftet, Skip-Link zuerst und mit Sprung auf die Überschrift', async () => {
    await alsInhaber();
    const funde: string[] = [];
    for (const pfad of EINSTELLUNGSSEITEN) {
      await mount(app(pfad));
      const main = host!.querySelector('#app-main');
      expect(main, pfad).not.toBeNull();
      funde.push(...unbeschriftet(host!).map((fund) => `${pfad}: ${fund}`));
      const erste = ersteFokussierbare();
      expect(erste?.getAttribute('data-testid'), pfad).toBe('skip-link');
      expect(erste?.textContent, pfad).toBe(t('a11y.skipToContent', 'de'));
      await act(async () => {
        erste!.click();
      });
      const h1 = main!.querySelector('h1');
      expect(h1, pfad).not.toBeNull();
      expect(document.activeElement, pfad).toBe(h1);
      await unmount();
    }
    expect(funde).toEqual([]);
  });

  it('B1: Sicherung im lokalen Betrieb — auch die Datei-Eingabe der Wiederherstellung ist beschriftet', async () => {
    await loginAsDefaultAdmin();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    await mount(app(SETTINGS_TARGET_PATHS.backup));
    const datei = host!.querySelector<HTMLInputElement>('[data-testid="backup-validate-file-input"]');
    expect(datei).not.toBeNull();
    expect(datei?.getAttribute('aria-label')).toBe(t('backup.validate.chooseFile', 'de'));
    expect(unbeschriftet(host!)).toEqual([]);
  });

  it('B1/B3: Anmelde-, Registrier- und Passwortseite — alles beschriftet, Skip-Link zuerst', async () => {
    await signOutUser();
    const funde: string[] = [];
    for (const pfad of ['/login', '/register', '/forgot-password']) {
      await mount(app(pfad, { ...DEFAULT_SETUP, setupComplete: true }));
      expect(host!.querySelector('.auth-card'), pfad).not.toBeNull();
      funde.push(...unbeschriftet(host!).map((fund) => `${pfad}: ${fund}`));
      const erste = ersteFokussierbare();
      expect(erste?.getAttribute('data-testid'), pfad).toBe('skip-link');
      await act(async () => {
        erste!.click();
      });
      expect(document.activeElement, pfad).toBe(host!.querySelector('.auth-card h1'));
      await unmount();
    }
    expect(funde).toEqual([]);
  });

  it('B1/B2/B3: Einrichtungsassistent — beschriftet, Kanal- und Sprachwahl mit aria-pressed, Skip-Link zuerst', async () => {
    await alsInhaber();
    await mount(app('/setup', { ...DEFAULT_SETUP, setupComplete: false }));
    const wizard = host!.querySelector('[data-testid="first-run-wizard"]');
    expect(wizard).not.toBeNull();
    expect(unbeschriftet(host!)).toEqual([]);
    expect(ersteFokussierbare()?.getAttribute('data-testid')).toBe('skip-link');
    const sprachen = Array.from(host!.querySelectorAll<HTMLButtonElement>('.setup-lang-chip'));
    expect(sprachen.length).toBeGreaterThan(1);
    expect(sprachen.filter((knopf) => knopf.getAttribute('aria-pressed') === 'true').length).toBe(1);
    for (const knopf of sprachen) expect(knopf.hasAttribute('aria-pressed')).toBe(true);
  });

  it('B2: Sprachwahl im Konto — genau eine Sprache aria-pressed="true", Wechsel setzt es um', async () => {
    await alsInhaber();
    await mount(app(SETTINGS_TARGET_PATHS['account-language']));
    const knoepfe = () => Array.from(host!.querySelectorAll<HTMLButtonElement>('.language-switcher__chips button'));
    expect(knoepfe().length).toBeGreaterThan(1);
    expect(knoepfe().every((knopf) => knopf.hasAttribute('aria-pressed'))).toBe(true);
    const aktiv = () => knoepfe().filter((knopf) => knopf.getAttribute('aria-pressed') === 'true').map((knopf) => knopf.dataset.testid);
    expect(aktiv()).toEqual(['language-option-de']);
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="language-option-tr"]')!.click();
    });
    await settle();
    expect(aktiv()).toEqual(['language-option-tr']);
  });

  // Nacharbeit AP5–AP10: die B2-Seiten vor dem App-Rahmen (1.14) hatten keinen Skip-Link (Tastaturmatrix im Browser).
  it('B1/B3: Antwortadresse, Notfallseite, Importseite und Fehlergrenze — beschriftet, Skip-Link zuerst, Sprung auf die Überschrift', async () => {
    const seiten: Array<[string, ReactNode]> = [
      ['/antwortadresse-bestaetigen', <ReplyToConfirmPage />],
      ['/local-recovery', <LocalRecoveryPage />],
      ['/local-recovery/import', <LocalRecoveryImportPage />],
      ['Fehlergrenze', <ServerErrorPage />],
    ];
    for (const [name, seite] of seiten) {
      await mount(<MemoryRouter initialEntries={[name.startsWith('/') ? name : '/']}>{seite}</MemoryRouter>);
      expect(unbeschriftet(host!), name).toEqual([]);
      // Die versteckte Datei-Eingabe der Importseite ist kein unsichtbarer Tabulatorstopp (bedient über den Knopf).
      const datei = host!.querySelector<HTMLInputElement>('input[type="file"]');
      if (datei) expect(datei.tabIndex, name).toBe(-1);
      const erste = ersteFokussierbare();
      expect(erste?.getAttribute('data-testid'), name).toBe('skip-link');
      expect(erste?.textContent, name).toBe(t('a11y.skipToContent', 'de'));
      await act(async () => {
        erste!.click();
      });
      const h1 = host!.querySelector('h1');
      expect(h1, name).not.toBeNull();
      expect(document.activeElement, name).toBe(h1);
      await unmount();
    }
  });

  it('B4: Seitenwechsel setzt den Fokus auf die neue Überschrift; mit Anker nicht', async () => {
    await alsInhaber();
    await mount(app('/einstellungen'));
    await act(async () => {
      navigateTo!(SETTINGS_TARGET_PATHS['company-profile']);
    });
    await settle();
    const h1 = host!.querySelector('#app-main h1');
    expect(h1?.textContent).toBe(t(settingsTargetTitleKey('company-profile'), 'de'));
    expect(document.activeElement).toBe(h1);
    expect(h1?.getAttribute('tabindex')).toBe('-1');

    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      navigateTo!(`${SETTINGS_TARGET_PATHS.invoices}#settings-invoices-defaultPaymentDays`);
    });
    await settle();
    expect(document.activeElement).not.toBe(host!.querySelector('#app-main h1'));
  });
});
