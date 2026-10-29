/**
 * EINRICHTUNG-01 (AP5; Verträge 1.15–1.17) — Hub und Navigation nach Katalog Teil 2, Gruppe N (Vitest-Anteile, V).
 *
 *   N-01.1 Gruppen und Ziele genau nach 1.15, in dieser Reihenfolge, je Ziel ein Eintrag und ein Name
 *   N-01.2 jedes Ziel aus dem Hub erreichbar; Titel = Eintragsname; „Zurück“ führt zum Hub
 *   N-01.3 alte Adressen landen am Ziel nach 1.15, ohne Schleife
 *   N-02.1 Inventar der Einstiege: je Ziel genau ein Einstieg; Synchronisation nur unter „Hilfe und Rechtliches“
 *   N-02.2/N-02.3 Plattform-Verwaltung nur im Benutzermenü; Menü ohne zweiten Weg zu einem Hub-Ziel
 *   N-03.1–N-03.6 Sichtbarkeit je Rolle, Lizenz, lokalem Betrieb und unbestätigten Rechten; einheitlicher Hinweis
 *   N-04.1/N-04.2 Hauptnavigation unverändert; „Mehr“ ohne „System“ und ohne Einstellungsziel
 *   N-05.2 (V-Anteil) Speicherleiste erscheint mit „Speichern“ und „Verwerfen“, sobald das Formular geändert ist
 *   N-06.1 Version und Rechtsseiten; N-06.2 (R-Anteil) eine Grenze von 1024 px, Doppeldefinitionen entfernt
 *
 * Echter Stapel AuthProvider → BusinessStateGate → App; gestubbt sind nur die RPC-Antworten. Kein Netzwerk.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { AppProvider } from './context/AppContext';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { EinstellungenPage } from './pages/EinstellungenPage';
import {
  LEGACY_OPERATING_SETTINGS_ROUTE,
  SETTINGS_HUB_GROUPS,
  SETTINGS_TARGETS,
  SETTINGS_TARGET_PATHS,
  isSettingsTargetVisible,
  resolveSettingsHubGroups,
  type SettingsTargetId,
} from './pages/settings/settingsHubConfig';
import { resolveFirmendatenLegacyTarget } from './pages/settings/FirmendatenLegacyRoute';
import { SETTINGS_BACKUP_HREF } from './services/backupSectionNavigation';
import {
  DESKTOP_NAV_ITEMS,
  MOBILE_BOTTOM_NAV_ITEMS,
  PRIMARY_NAV,
  SECONDARY_NAV_GROUPS,
} from './components/layout/navConfig';
import { APP_VERSION, resolveAppBuildId } from './config/appVersion';
import { resetWorkspaceCloudBootstrapForTests } from './services/workspace/workspaceCloudBootstrapService';
import { resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { resetWorkspaceAccessForTests } from './services/workspace/workspaceAccessService';
import { hydrateWorkspaceStore } from './services/workspace/workspaceStore';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { loginAsDefaultAdmin, resetAuthForTests } from './test/authFixtures';
import { getMockCurrentSession } from './test/mockSupabaseAuth';
import * as supabaseLib from './lib/supabase';
import { getCachedSetup } from './services/persistenceService';
import { t } from './i18n';
import type { WorkspaceRole } from './types/workspace';

const WORKSPACE_ID = '00000000-0000-4000-8000-00000000a501';
const OWNER_ELSEWHERE = 'konto-inhaber-anderswo';
const COMPANY_NAME = 'Hub Beispiel GmbH';

/** Zielstruktur 1.15 in Reihenfolge, mit den Namen aus dem Vertrag (Rechtliches als vier Einträge, A5-3). */
const ERWARTET: Array<[string, string, Array<[SettingsTargetId, string, string]>]> = [
  ['account', 'Mein Konto', [
    ['account', 'Profil', '/einstellungen/konto'],
    ['account-security', 'Anmeldung und Sicherheit', '/einstellungen/konto/sicherheit'],
    ['account-language', 'Sprache', '/einstellungen/konto/sprache'],
    ['account-sessions', 'Sitzungen', '/einstellungen/konto/sitzungen'],
    ['account-delete', 'Konto löschen', '/einstellungen/konto/loeschen'],
  ]],
  ['workspace', 'Betrieb', [
    ['company-profile', 'Firmendaten', '/einstellungen/firma'],
    ['logo', 'Logo und Design', '/einstellungen/design'],
    ['team-members', 'Team und Rollen', '/einstellungen/team'],
    ['workspace-delete', 'Betrieb löschen', '/einstellungen/betrieb/loeschen'],
  ]],
  ['documents', 'Dokumente und Zahlungen', [
    ['invoices', 'Rechnungen und Zahlungen', '/einstellungen/rechnungen'],
    ['offers', 'Angebote und Aufträge', '/einstellungen/angebote'],
    ['letters', 'Briefe', '/einstellungen/briefe'],
    ['number-ranges', 'Nummernkreise', '/einstellungen/nummernkreise'],
  ]],
  ['communication', 'Kommunikation', [
    ['communication', 'E-Mail-Absender und Vorlagen', '/einstellungen/kommunikation'],
    ['mailbox', 'Postfach', '/einstellungen/postfach'],
  ]],
  ['accounting', 'Buchhaltung', [['chart-of-accounts', 'Kontenrahmen', '/einstellungen/kontenrahmen']]],
  ['data', 'Daten', [
    ['backup', 'Sicherung', '/einstellungen/daten/sicherung'],
    ['export', 'Export', '/einstellungen/daten/export'],
    ['device', 'Daten auf diesem Gerät', '/einstellungen/daten/geraet'],
  ]],
  ['help', 'Hilfe und Rechtliches', [
    ['sync', 'Synchronisation', '/synchronisation'],
    ['imprint', 'Impressum', '/impressum'],
    ['privacy', 'Datenschutzerklärung', '/datenschutz'],
    ['terms', 'Allgemeine Geschäftsbedingungen', '/agb'],
    ['license', 'Lizenzbedingungen', '/lizenzbedingungen'],
    ['version', 'Version', '/einstellungen/version'],
  ]],
];

const MITGLIED_ZIELE: SettingsTargetId[] = [
  'account', 'account-security', 'account-language', 'account-sessions', 'account-delete',
  'team-members', 'device', 'sync', 'imprint', 'privacy', 'terms', 'license', 'version',
];

let userId = '';
let rolle: WorkspaceRole = 'owner';
let lizenz: 'effective' | 'expired' | 'inactive' = 'effective';
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
    return { workspace: workspaceRow(), member: memberRow(), created: false };
  });
  registerMockRpcHandler('pull_workspace_sync_state', () => ({
    workspace: workspaceRow(),
    members: [memberRow()],
    settings: null,
    vorgaenge: [],
    setup: {
      workspace_id: WORKSPACE_ID,
      payload: { ...DEFAULT_SETUP, companyName: COMPANY_NAME, setupComplete: true, setupVersion: 1 },
      row_version: 7,
      updated_at: '2026-05-05T08:00:00.000Z',
    },
    company_profile: {
      workspace_id: WORKSPACE_ID,
      payload: { ...DEFAULT_COMPANY_PROFILE, companyName: COMPANY_NAME, email: 'info@example.invalid' },
      row_version: 7,
      updated_at: '2026-05-05T08:00:00.000Z',
    },
  }));
  registerMockRpcHandler('get_workspace_access', (args) => ({
    workspace_id: args.p_workspace_id,
    role: rolle,
    license_state: lizenz,
    license_effective: lizenz === 'effective',
  }));
  registerMockRpcHandler('pull_workspace_invoices', () => []);
  registerMockRpcHandler('pull_workspace_order_amendments', () => []);
  registerMockRpcHandler('list_own_memberships', () => [
    { workspace_id: WORKSPACE_ID, workspace_name: COMPANY_NAME, role: rolle, status: 'active' },
  ]);
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

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-path={location.pathname} data-search={location.search} />;
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
            <LocationProbe />
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

const q = (container: ParentNode, id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const pfad = (container: ParentNode) => q(container, 'location')?.getAttribute('data-path') ?? '';

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

function hubEintraege(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="settings-entry-"]')).map((el) =>
    (el.getAttribute('data-testid') ?? '').replace('settings-entry-', ''),
  );
}

describe('EINRICHTUNG-01 AP5 — Zielstruktur (Konfiguration)', () => {
  it('N-01.1 Gruppen, Ziele, Adressen und Namen genau nach 1.15, in dieser Reihenfolge', () => {
    expect(SETTINGS_HUB_GROUPS.map((group) => group.id)).toEqual(ERWARTET.map(([id]) => id));
    for (const [groupId, groupName, targets] of ERWARTET) {
      const group = SETTINGS_HUB_GROUPS.find((item) => item.id === groupId)!;
      expect(t(group.titleKey, 'de'), groupId).toBe(groupName);
      expect(group.targets.map((item) => item.id), groupId).toEqual(targets.map(([id]) => id));
      for (const [id, name, path] of targets) {
        const target = group.targets.find((item) => item.id === id)!;
        expect(t(target.titleKey, 'de'), id).toBe(name);
        expect(target.path, id).toBe(path);
        expect(t(target.descriptionKey, 'de'), `${id} Kurzbeschreibung`).not.toBe(target.descriptionKey);
      }
    }
    // Ein Einstieg, ein Name: keine Adresse und kein Name doppelt.
    const paths = SETTINGS_TARGETS.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
    const names = SETTINGS_TARGETS.map((item) => t(item.titleKey, 'de'));
    expect(new Set(names).size).toBe(names.length);
    expect(SETTINGS_TARGETS).toHaveLength(25);
  });

  it('N-03.1/N-03.3/N-03.5 Sichtbarkeit je Rolle und im lokalen Betrieb (1.16)', () => {
    const ids = (viewer: Parameters<typeof resolveSettingsHubGroups>[0]) =>
      resolveSettingsHubGroups(viewer).flatMap((group) => group.targets.map((item) => item.id));
    const alle = SETTINGS_TARGETS.map((item) => item.id);
    expect(ids({ cloud: true, role: 'owner' })).toEqual(alle);
    expect(ids({ cloud: true, role: 'admin' })).toEqual(alle.filter((id) => id !== 'workspace-delete'));
    expect(ids({ cloud: true, role: 'member' })).toEqual(MITGLIED_ZIELE);
    // Rolle unbekannt zählt fail-closed wie ein Mitglied.
    expect(ids({ cloud: true, role: null })).toEqual(MITGLIED_ZIELE);
    // Lokaler Betrieb ohne Cloud: ohne Mein Konto (außer Sprache, A5-2), Team, Betrieb löschen, Postfach, Synchronisation.
    expect(ids({ cloud: false, role: null })).toEqual(
      alle.filter(
        (id) => !['account', 'account-security', 'account-sessions', 'account-delete', 'team-members', 'workspace-delete', 'mailbox', 'sync'].includes(id),
      ),
    );
    expect(isSettingsTargetVisible('owner', { cloud: true, role: 'admin' })).toBe(false);
  });

  it('N-01.3 alte Adressen: Betrieb → Hub, #datensicherung → Sicherung, übrige wie bisher', () => {
    expect(LEGACY_OPERATING_SETTINGS_ROUTE).toBe('/einstellungen/betrieb');
    expect(resolveFirmendatenLegacyTarget('#datensicherung')).toBe('/einstellungen/daten/sicherung');
    expect(SETTINGS_BACKUP_HREF).toBe(SETTINGS_TARGET_PATHS.backup);
    expect(resolveFirmendatenLegacyTarget('')).toBe('/einstellungen/firma');
    expect(resolveFirmendatenLegacyTarget('#logo')).toBe('/einstellungen/design');
    expect(resolveFirmendatenLegacyTarget('#zahlungsbedingungen')).toBe('/einstellungen/rechnungen');
    expect(resolveFirmendatenLegacyTarget('#rechnungstexte')).toBe('/einstellungen/rechnungen');
    expect(resolveFirmendatenLegacyTarget('#unbekannt')).toBe('/einstellungen/firma');
  });

  it('N-02.1/N-04.1/N-04.2 Inventar: Hauptnavigation unverändert, „Mehr“ ohne System und ohne Einstellungsziel', () => {
    expect(PRIMARY_NAV.map((item) => item.to)).toEqual(['/', '/ablage', '/vorgaenge', '/rechnungen/offen', '/finanzen', '/dokumente']);
    expect(DESKTOP_NAV_ITEMS).toHaveLength(6);
    expect(MOBILE_BOTTOM_NAV_ITEMS.map((item) => item.to)).toEqual(['/', '/ablage', '/vorgaenge', '/rechnungen/offen', '/mehr']);
    expect(SECONDARY_NAV_GROUPS.map((group) => group.id)).not.toContain('system');
    const hubZiele = new Set<string>(SETTINGS_TARGETS.map((item) => item.path));
    const navZiele = [...PRIMARY_NAV, ...MOBILE_BOTTOM_NAV_ITEMS, ...SECONDARY_NAV_GROUPS.flatMap((group) => group.items)].map((item) => item.to);
    expect(navZiele.filter((to) => hubZiele.has(to) || to.startsWith('/einstellungen'))).toEqual([]);
    expect(navZiele).not.toContain('/synchronisation');
  });

  it('N-06.1 Version folgt package.json; eine Build-Kennung wird nur in sicherer Form gezeigt', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    expect(resolveAppBuildId('a1b2c3d')).toBe('a1b2c3d');
    expect(resolveAppBuildId('<script>')).toBeNull();
    expect(resolveAppBuildId('')).toBeNull();
    expect(resolveAppBuildId(undefined)).toBeNull();
  });

  it('N-07 (App-Eigenprüfung, 1.33) Kopfzeilensuche: Vorschau auf dem Desktop am Suchfeld, mobil am Kopf ausgerichtet', () => {
    const shellCss = readFileSync(resolve(__dirname, 'styles/shell.css'), 'utf8').replace(/\r\n/g, '\n');
    // Ohne positioniertes Suchfeld richtete sich die absolute Vorschau am ganzen Kopf aus und lag unter der Seitenleiste.
    expect(shellCss).toMatch(/\.app-shell__top \.global-search:not\(\.global-search--mobile-collapsible\)\s*\{\s*position:\s*relative;\s*\}/);
    expect(shellCss).toMatch(/\.app-shell__top \.global-search__preview\s*\{[^}]*position:\s*absolute;[^}]*left:\s*0;[^}]*right:\s*0;/);
    // Das mobile, ausklappende Feld bleibt am Kopf ausgerichtet (volle Breite unter der Kopfzeile).
    expect(shellCss).toMatch(/\.app-shell__top \.global-search--mobile-collapsible \.global-search__panel\s*\{[^}]*position:\s*absolute;[^}]*left:\s*0;[^}]*right:\s*0;/);
  });

  it('N-06.2 (EIN-37) eine Grenze von 1024 px für die Seitenleiste; die Doppeldefinitionen sind entfernt', () => {
    const indexCss = readFileSync(resolve(__dirname, 'index.css'), 'utf8');
    const shellCss = readFileSync(resolve(__dirname, 'styles/shell.css'), 'utf8');
    const layoutCss = readFileSync(resolve(__dirname, 'styles/layout.css'), 'utf8');
    // shell.css hebt keine 480-px-Regel aus index.css mehr auf.
    expect(shellCss).not.toMatch(/^\.app-shell\s*\{/m);
    expect(shellCss).not.toMatch(/^\.bottom-nav\s*\{[^}]*max-width/m);
    // index.css: App-Rahmen und Bottom-Navigation in genau einer Fassung mit voller Breite.
    const regel = (css: string, selector: string) =>
      [...css.matchAll(new RegExp(`^${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'gm'))].map((m) => m[1]);
    expect(regel(indexCss, '.app-shell')).toHaveLength(1);
    expect(regel(indexCss, '.app-shell')[0]).toMatch(/max-width:\s*none/);
    expect(regel(indexCss, '.bottom-nav')).toHaveLength(1);
    expect(regel(indexCss, '.bottom-nav')[0]).not.toMatch(/max-width:\s*480px/);
    expect(regel(indexCss, '.bottom-nav')[0]).not.toMatch(/translateX/);
    // Jede Medienabfrage, die Seitenleiste oder Bottom-Navigation umschaltet, nutzt 1024 px.
    for (const css of [indexCss, shellCss, layoutCss]) {
      const re = /@media([^{]*)\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(css))) {
        let depth = 1;
        let i = re.lastIndex;
        while (depth > 0 && i < css.length) {
          if (css[i] === '{') depth += 1;
          else if (css[i] === '}') depth -= 1;
          i += 1;
        }
        const body = css.slice(re.lastIndex, i);
        if (/\.(sidebar-nav|bottom-nav)\s*\{/.test(body) && /display\s*:/.test(body)) {
          expect(m[1], 'Grenze der Seitenleiste').toMatch(/1024px/);
        }
      }
    }
  });
});

describe('EINRICHTUNG-01 AP5 — Hub im echten Stapel', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    rpcLog.length = 0;
    rolle = 'owner';
    lizenz = 'effective';
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

  it('N-01.1 O1: der Hub zeigt sieben Gruppen und alle Ziele in der Reihenfolge von 1.15', async () => {
    const container = await mountApp('/einstellungen');
    expect(q(container, 'einstellungen-page'), 'Hub fehlt').not.toBeNull();
    const gruppen = Array.from(container.querySelectorAll('[data-testid^="settings-group-"]')).map((el) => el.getAttribute('data-testid'));
    expect(gruppen).toEqual(ERWARTET.map(([id]) => `settings-group-${id}`));
    expect(hubEintraege(container)).toEqual(SETTINGS_TARGETS.map((item) => item.id));
    for (const [, , targets] of ERWARTET) {
      for (const [id, name, path] of targets) {
        const link = q(container, `settings-entry-${id}`)!;
        expect(link.getAttribute('href'), id).toBe(path);
        expect(link.querySelector('.settings-row__title')?.textContent, id).toBe(name);
      }
    }
    // N-02.2 — die Plattform-Verwaltung steht nicht im Hub.
    expect(container.querySelector('a[href="/admin/users"], a[href^="/plattform"]')).toBeNull();
  });

  // Zeitbudget: alle 26 Ziele werden im echten Stapel geöffnet (unter Last deutlich über den 5 s des Standards).
  it('N-01.2 O1: jedes Ziel ist erreichbar, der Titel ist der Eintragsname, „Zurück“ führt zum Hub', { timeout: 90_000 }, async () => {
    const container = await mountApp('/einstellungen');
    for (const target of SETTINGS_TARGETS) {
      const name = t(target.titleKey, 'de');
      const link = q(container, `settings-entry-${target.id}`);
      expect(link, `Eintrag ${target.id}`).not.toBeNull();
      await click(link!);
      expect(pfad(container), target.id).toBe(target.path);
      expect(q(container, 'not-found-page'), `${target.id}: 404`).toBeNull();
      const heading = container.querySelector('h1.page-header__title, h1.legal-page__title');
      expect(heading?.textContent, `${target.id}: Titel`).toBe(name);
      const back = container.querySelector('a.page-header__back, a.legal-page__back') as HTMLAnchorElement | null;
      expect(back?.getAttribute('href'), `${target.id}: Rückweg`).toBe('/einstellungen');
      await click(back!);
      expect(pfad(container), `${target.id}: zurück im Hub`).toBe('/einstellungen');
    }
  });

  it('N-01.3 alte Adressen im Router: /einstellungen/betrieb → Hub; /firmendaten#datensicherung → Sicherung', async () => {
    const hub = await mountApp(LEGACY_OPERATING_SETTINGS_ROUTE);
    expect(pfad(hub)).toBe('/einstellungen');
    expect(q(hub, 'einstellungen-page')).not.toBeNull();
    await settle();
    expect(pfad(hub), 'keine Schleife').toBe('/einstellungen');
    await unmountApp();

    const sicherung = await mountApp('/firmendaten#datensicherung');
    expect(pfad(sicherung)).toBe('/einstellungen/daten/sicherung');
    expect(q(sicherung, 'backup-export-panel')).not.toBeNull();
    await unmountApp();

    // Z-F11 — der OAuth-Rückweg der Edge Function wird mit allen Parametern zum Postfach weitergeleitet.
    const postfach = await mountApp('/einstellungen/kommunikation?postfach=fehler&grund=state_invalid');
    expect(pfad(postfach)).toBe('/einstellungen/postfach');
    expect(q(postfach, 'settings-mailbox-page')).not.toBeNull();
  });

  it('N-02.3 Benutzermenü: Einstellungen, Abmelden, auf allen Geräten abmelden — kein zweiter Weg zu einem Hub-Ziel', async () => {
    const container = await mountApp('/');
    const trigger = q(container, 'user-menu-dropdown-trigger');
    expect(trigger).not.toBeNull();
    await click(trigger!);
    const links = Array.from(container.querySelectorAll('[data-testid="user-menu-dropdown"] a')).map((a) => a.getAttribute('href'));
    expect(links).toContain('/einstellungen');
    const hubZiele = new Set<string>(SETTINGS_TARGETS.map((item) => item.path));
    expect(links.filter((href) => href && hubZiele.has(href))).toEqual([]);
    expect(q(container, 'logout-button')).not.toBeNull();
    expect(q(container, 'logout-everywhere-button')).not.toBeNull();
  });

  it('N-03.1/N-03.2 M1: nur die Mitgliederziele; Firmendaten und Rechnungen nur lesbar ohne Speicherleiste; Sicherung nur Hinweis', async () => {
    rolle = 'member';
    const hub = await mountApp('/einstellungen');
    expect(hubEintraege(hub)).toEqual(MITGLIED_ZIELE);
    await unmountApp();

    for (const [route, notice, saveBar] of [
      ['/einstellungen/firma', 'settings-company-readonly', 'settings-company-save-bar'],
      ['/einstellungen/rechnungen', 'settings-invoices-readonly', 'settings-invoices-save-bar'],
      ['/einstellungen/kommunikation', 'settings-communication-readonly', 'settings-communication-save-bar'],
      ['/einstellungen/kontenrahmen', 'settings-chart-of-accounts-readonly', ''],
    ] as const) {
      const seite = await mountApp(route);
      const hinweis = q(seite, notice);
      expect(hinweis, `${route}: Hinweis`).not.toBeNull();
      expect(hinweis?.getAttribute('data-variant'), route).toBe('role');
      if (saveBar) expect(q(seite, saveBar), `${route}: keine Speicherleiste`).toBeNull();
      await unmountApp();
    }

    const sicherung = await mountApp('/einstellungen/daten/sicherung');
    expect(q(sicherung, 'backup-export-not-allowed')?.getAttribute('data-variant')).toBe('role');
    expect(q(sicherung, 'backup-export-panel'), 'kein Inhalt').toBeNull();
    expect(q(sicherung, 'backup-export-download'), 'keine Aktion').toBeNull();
    expect(rpcLog.filter((name) => name.startsWith('upsert:'))).toEqual([]);
  });

  it('N-03.3 A1: wie O1 ohne „Betrieb löschen“', async () => {
    rolle = 'admin';
    const hub = await mountApp('/einstellungen');
    expect(hubEintraege(hub)).toEqual(SETTINGS_TARGETS.map((item) => item.id).filter((id) => id !== 'workspace-delete'));
  });

  it('N-03.4 Nur-Lesen (Lizenz): je Rolle genau ihre Ziele; Betriebsseiten mit Grund „Lizenz“, ohne Speicherleiste; Sicherung bleibt', async () => {
    lizenz = 'expired';
    for (const [r, erwartet] of [
      ['owner', SETTINGS_TARGETS.map((item) => item.id)],
      ['admin', SETTINGS_TARGETS.map((item) => item.id).filter((id) => id !== 'workspace-delete')],
      ['member', MITGLIED_ZIELE],
    ] as const) {
      rolle = r;
      resetWorkspaceCloudBootstrapForTests();
      resetWorkspaceAccessForTests();
      localStorage.clear();
      const hub = await mountApp('/einstellungen');
      expect(hubEintraege(hub), r).toEqual(erwartet);
      await unmountApp();
    }

    rolle = 'owner';
    resetWorkspaceCloudBootstrapForTests();
    resetWorkspaceAccessForTests();
    localStorage.clear();
    for (const [route, notice, saveBar] of [
      ['/einstellungen/firma', 'settings-company-readonly', 'settings-company-save-bar'],
      ['/einstellungen/design', 'settings-design-readonly', 'settings-design-save'],
      ['/einstellungen/rechnungen', 'settings-invoices-readonly', 'settings-invoices-save-bar'],
      ['/einstellungen/kommunikation', 'settings-communication-readonly', 'settings-communication-save-bar'],
      ['/einstellungen/nummernkreise', 'settings-number-ranges-readonly', 'settings-invoices-number-save'],
      ['/einstellungen/kontenrahmen', 'settings-chart-of-accounts-readonly', ''],
    ] as const) {
      const seite = await mountApp(route);
      expect(q(seite, notice)?.getAttribute('data-variant'), route).toBe('license');
      if (saveBar) expect(q(seite, saveBar), `${route}: keine Speicherleiste`).toBeNull();
      await unmountApp();
    }
    // Ausnahme 1.16: Sicherung für Inhaber und Admins.
    const sicherung = await mountApp('/einstellungen/daten/sicherung');
    expect(q(sicherung, 'backup-export-download')).not.toBeNull();
    expect(q(sicherung, 'backup-export-not-allowed')).toBeNull();
    expect(rpcLog.filter((name) => name.startsWith('upsert:'))).toEqual([]);
  });

  it('N-05.2 (V) Speicherleiste: erscheint geändert mit „Speichern“ und „Verwerfen“; „Verwerfen“ stellt den gespeicherten Stand her', async () => {
    const container = await mountApp('/einstellungen/firma');
    const bar = q(container, 'settings-company-save-bar')!;
    expect(bar).not.toBeNull();
    expect(bar.className).not.toContain('primary-action-bar--sticky');
    expect(q(container, 'settings-company-discard')).toBeNull();
    expect((q(container, 'settings-company-save') as HTMLButtonElement).disabled).toBe(true);

    const input = q(container, 'settings-company-city') as HTMLInputElement;
    const vorher = input.value;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Neustadt');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(q(container, 'settings-company-save-bar')!.className).toContain('primary-action-bar--sticky');
    expect(q(container, 'settings-company-dirty')?.textContent).toBe('Ungespeicherte Änderungen');
    expect((q(container, 'settings-company-save') as HTMLButtonElement).disabled).toBe(false);
    expect(q(container, 'settings-company-save')?.textContent).toContain('Speichern');
    expect(q(container, 'settings-company-discard')?.textContent).toContain('Verwerfen');

    await click(q(container, 'settings-company-discard')!);
    expect((q(container, 'settings-company-city') as HTMLInputElement).value).toBe(vorher);
    expect(q(container, 'settings-company-save-bar')!.className).not.toContain('primary-action-bar--sticky');
    expect(rpcLog.filter((name) => name.startsWith('upsert:'))).toEqual([]);
  });

  it('N-06.1 Version zeigt Version und Stand; Rechtsseiten aus dem Hub mit Rückweg in den Hub', async () => {
    const container = await mountApp('/einstellungen/version');
    expect(q(container, 'settings-version-number')?.textContent).toBe(APP_VERSION);
    expect(q(container, 'settings-version-state')?.textContent).toMatch(/\d{2}\.\d{2}\.\d{4}/);
    expect(q(container, 'settings-version-mode')?.textContent).toBe('Cloud-Betrieb');
    await unmountApp();

    const hub = await mountApp('/einstellungen');
    await click(q(hub, 'settings-entry-imprint')!);
    expect(q(hub, 'impressum-page')).not.toBeNull();
    expect(q(hub, 'legal-back-settings')?.getAttribute('href')).toBe('/einstellungen');
    await unmountApp();

    // Ohne den Hub als Herkunft bleibt der bisherige Rückweg.
    const direkt = await mountApp('/impressum');
    expect(q(direkt, 'legal-back')?.getAttribute('href')).toBe('/login');
  });
});

describe('EINRICHTUNG-01 AP5 — lokaler Betrieb ohne Cloud (N-03.5)', () => {
  let localRoot: Root | null = null;
  let localHost: HTMLDivElement | null = null;

  beforeEach(async () => {
    resetTestStores();
    resetAuthForTests();
    localStorage.clear();
    setActiveStorageScope({ type: 'guest' });
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    await loginAsDefaultAdmin();
  });

  afterEach(async () => {
    await act(async () => {
      localRoot?.unmount();
    });
    localHost?.remove();
    localRoot = null;
    localHost = null;
    vi.restoreAllMocks();
    resetTestStores();
  });

  async function render(entry: string): Promise<HTMLDivElement> {
    localHost = document.createElement('div');
    document.body.appendChild(localHost);
    localRoot = createRoot(localHost);
    const { AccountLanguagePage } = await import('./pages/settings/AccountLanguagePage');
    await act(async () => {
      localRoot!.render(
        <MemoryRouter initialEntries={[entry]}>
          <AuthProvider>
            <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, language: 'de' }}>
              <Routes>
                <Route path="/einstellungen" element={<EinstellungenPage />} />
                <Route path="/einstellungen/konto/sprache" element={<AccountLanguagePage />} />
              </Routes>
            </AppProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
    });
    await settle(20);
    return localHost;
  }

  it('Hub ohne Konto (außer Sprache), Team, Betrieb löschen, Postfach, Synchronisation; Sprache wirkt lokal sofort', async () => {
    hydrateWorkspaceStore({ workspace: null, workspaceMembers: [] });
    const hub = await render('/einstellungen');
    const ids = hubEintraege(hub);
    for (const fehlt of ['account', 'account-security', 'account-sessions', 'account-delete', 'team-members', 'workspace-delete', 'mailbox', 'sync']) {
      expect(ids, fehlt).not.toContain(fehlt);
    }
    for (const da of ['account-language', 'company-profile', 'logo', 'invoices', 'number-ranges', 'communication', 'chart-of-accounts', 'backup', 'export', 'device', 'version']) {
      expect(ids, da).toContain(da);
    }
    await act(async () => {
      localRoot?.unmount();
    });
    localHost?.remove();

    const sprache = await render('/einstellungen/konto/sprache');
    const switcher = q(sprache, 'account-language-switcher')!;
    expect(switcher).not.toBeNull();
    await click(switcher.querySelector('[data-testid="language-option-tr"]') as HTMLElement);
    expect(getCachedSetup().language).toBe('tr');
  });
});
