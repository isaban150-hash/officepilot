/**
 * EINRICHTUNG-01 (AP3) — „Mein Konto“ unter `/einstellungen/konto` nach Katalog V3, Abschnitt K (Vitest-Anteile):
 *  - K-01.1/K-01.4 Name und Telefon speichern; bei Netzfehler kein Erfolg, Eingaben bleiben;
 *  - K-02.1 E-Mail-Wechsel: bis zur doppelten Bestätigung gilt die alte Adresse;
 *  - K-03.1 falsches aktuelles Passwort ändert nichts; K-03.2/K-03.3 richtiges: neues gilt, dieselbe Sitzung,
 *    kein Sitzungs- oder Bestandswechsel, kein Bootstrap; K-03.4 andere Sitzungen werden abgemeldet;
 *  - K-04.1/K-04.2 Sprache je Person ohne Firmen-Schreibauftrag, auch im Nur-Lesen-Betrieb; K-04.3 die am Profil
 *    gespeicherte Sprache gilt auf einem anderen Gerät, `<html lang>` folgt;
 *  - K-05.1 eigene Zustimmungen und Mitgliedschaften.
 *
 * EINRICHTUNG-01 (AP5; Vertrag 1.15) — „Mein Konto“ ist in Ziele aufgeteilt (Profil, Anmeldung und Sicherheit, Sprache,
 * Sitzungen). Die Fälle bleiben unverändert; der Test montiert die vier Seiten gemeinsam, die Test-IDs sind dieselben.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../context/AuthContext';
import { AppProvider, useApp } from '../../context/AppContext';
import { AccountSettingsPage } from './AccountSettingsPage';
import { AccountSecurityPage } from './AccountSecurityPage';
import { AccountLanguagePage } from './AccountLanguagePage';
import { AccountSessionsPage } from './AccountSessionsPage';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { applyStateToStores, getCachedSetup, persistAll } from '../../services/persistenceService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../../services/sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../../services/sync/syncChangeTrackerService';
import { createSyncClient } from '../../services/sync/syncClientService';
import { STORAGE_VERSION } from '../../services/sync/syncMigrationService';
import { PERSONAL_UI_LANGUAGE_KEY_PREFIX } from '../../services/auth/personalUiLanguage';
import {
  WORKSPACE_ACCESS_KEY_PREFIX,
  isWorkspaceLicenseReadOnly,
  resetWorkspaceAccessForTests,
} from '../../services/workspace/workspaceAccessService';
import { setWorkspace } from '../../services/workspace/workspaceStore';
import { t } from '../../i18n';
import { resetTestStores } from '../../test/resetStores';
import { loginAsDefaultAdmin, DEFAULT_ADMIN_PASSWORD } from '../../test/authFixtures';
import {
  createMockIsolatedAuthClient,
  getMockCurrentSession,
  getMockIsolatedAuthCounts,
  getMockLastSignOutScope,
  getMockPendingEmailChange,
  getMockProfileFetchCount,
} from '../../test/mockSupabaseAuth';
import { clearMockRpcHandlers, getMockProfile, patchMockProfile, registerMockRpcHandler } from '../../test/mockProfileStore';
import type { AppPersistedState } from '../../types/models';

const WS = 'ws-ein01-konto';
let userId = '';

function ausgangsstand(): AppPersistedState {
  return {
    version: STORAGE_VERSION,
    syncClient: { ...createSyncClient(), serverWorkspaceId: WS, workspaceId: WS },
    syncOutbox: [],
    setup: { ...DEFAULT_SETUP, companyName: 'Konto GmbH', language: 'de', setupComplete: true, setupVersion: 1 },
    companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Konto GmbH' },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    savedAt: '2026-10-23T08:00:00.000Z',
  } as unknown as AppPersistedState;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** App-Eigenprüfung (N-09) — die Kurzmeldung zeigt sonst erst der App-Rahmen; hier liest sie eine Sonde mit. */
function MeldungsSonde() {
  const { toast } = useApp();
  return <output data-testid="test-meldung">{toast ?? ''}</output>;
}

async function starte(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/einstellungen/konto']}>
        <AuthProvider>
          <AppProvider initialSetup={getCachedSetup()}>
            <AccountSettingsPage />
            <AccountSecurityPage />
            <AccountLanguagePage />
            <AccountSessionsPage />
            <MeldungsSonde />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  expect(container.querySelector('[data-testid="settings-account-page"]'), 'Kontoseite fehlt').not.toBeNull();
  return container;
}

async function beende(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
}

function q(testId: string): HTMLElement | null {
  return container?.querySelector(`[data-testid="${testId}"]`) ?? null;
}

async function eingeben(testId: string, value: string): Promise<void> {
  const element = q(testId) as HTMLInputElement | null;
  expect(element, `Feld ${testId} fehlt`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function absenden(formTestId: string): Promise<void> {
  const form = q(formTestId) as HTMLFormElement | null;
  expect(form, `Formular ${formTestId} fehlt`).not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function klick(testId: string): Promise<void> {
  const element = q(testId) as HTMLButtonElement | null;
  expect(element, `Schaltfläche ${testId} fehlt`).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await settle();
}

function firmenAuftraege() {
  return getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'company_setup' || entry.entityType === 'company_profile');
}

/** Ein Konto im Cloud-Betrieb: Betriebsbereich mit Kontobindung (wie nach dem Bootstrap). */
function cloudBereich(access: 'full' | 'member' = 'full'): void {
  setActiveStorageScope({ type: 'workspace', workspaceId: WS, account: { userId, access } });
  applyStateToStores(ausgangsstand());
  setWorkspace({ id: WS, name: 'Konto GmbH', ownerUserId: userId, createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z', version: 1 } as never);
  persistAll();
  resetSyncOutboxForTests();
  resetSyncChangeTrackerForTests();
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  resetTestStores();
  resetSyncOutboxForTests();
  clearMockRpcHandlers();
  await loginAsDefaultAdmin();
  userId = getMockCurrentSession()?.user.id ?? '';
  expect(userId).not.toBe('');
  cloudBereich('full');
});

afterEach(async () => {
  await beende();
  vi.restoreAllMocks();
  clearMockRpcHandlers();
  setActiveStorageScope({ type: 'guest' });
  document.documentElement.lang = '';
});

describe('EINRICHTUNG-01 AP3 — Mein Konto (K)', () => {
  it('K-01.1: Name und Telefon werden über das eigene Profil gespeichert', async () => {
    await starte();
    await eingeben('account-first-name', 'Saban');
    await eingeben('account-last-name', 'Irmak');
    await eingeben('account-phone', '+49 30 123');
    await absenden('account-personal');

    expect(q('account-personal-info')?.textContent).toBe(t('account.saved', 'de'));
    const profil = getMockProfile(userId);
    expect(profil).toMatchObject({ first_name: 'Saban', last_name: 'Irmak', phone: '+49 30 123' });
    // Rechte- und Lizenzfelder bleiben unberührt.
    expect(profil).toMatchObject({ role: 'admin', status: 'approved' });
  });

  it('K-01.4: Netzfehler beim Speichern — kein Erfolg, die Eingaben bleiben', async () => {
    registerMockRpcHandler('update_own_profile', () => {
      throw new Error('Failed to fetch');
    });
    await starte();
    const vorher = getMockProfile(userId);
    await eingeben('account-first-name', 'Saban');
    await eingeben('account-phone', '+49 30 999');
    await absenden('account-personal');

    expect(q('account-personal-info')?.textContent).toBe(t('account.saveFailed', 'de'));
    expect(q('account-personal-info')?.getAttribute('role')).toBe('alert');
    expect((q('account-first-name') as HTMLInputElement).value).toBe('Saban');
    expect((q('account-phone') as HTMLInputElement).value).toBe('+49 30 999');
    expect(getMockProfile(userId)?.first_name).toBe(vorher?.first_name);
  });

  it('K-02.1: E-Mail-Wechsel angefordert — bis zur Bestätigung gilt die alte Adresse', async () => {
    await starte();
    const alt = getMockProfile(userId)?.email;
    await eingeben('account-email-new', 'neu@officetakt.test');
    await absenden('account-email');

    expect(q('account-email-info')?.textContent).toBe(t('account.email.sent', 'de'));
    expect(getMockPendingEmailChange()).toMatchObject({ userId, email: 'neu@officetakt.test' });
    expect(q('account-email-current')?.textContent).toBe(alt);
    expect(getMockProfile(userId)?.email).toBe(alt);
  });

  it('K-03.1: falsches aktuelles Passwort — abgewiesen, nichts geändert', async () => {
    await starte();
    await eingeben('account-password-current', 'falsch-falsch');
    await eingeben('account-password-new', 'NeuesPasswort-2026');
    await eingeben('account-password-confirm', 'NeuesPasswort-2026');
    await absenden('account-password');

    expect(q('account-password-info')?.textContent).toBe(t('account.password.wrongCurrent', 'de'));
    const pruefer = createMockIsolatedAuthClient();
    const alt = await pruefer.auth.signInWithPassword({ email: 'admin@officepilot.local', password: DEFAULT_ADMIN_PASSWORD });
    expect(alt.error, 'altes Passwort gilt nicht mehr').toBeNull();
    const neu = await pruefer.auth.signInWithPassword({ email: 'admin@officepilot.local', password: 'NeuesPasswort-2026' });
    expect(neu.error).not.toBeNull();
    expect(getMockLastSignOutScope()).not.toBe('others');
  });

  it('K-03.2/K-03.3/K-03.4: richtiges Passwort — das neue gilt, dieselbe Sitzung bleibt, andere werden abgemeldet', async () => {
    await starte();
    const sitzungVorher = getMockCurrentSession();
    const abrufeVorher = getMockProfileFetchCount();
    await eingeben('account-password-current', DEFAULT_ADMIN_PASSWORD);
    await eingeben('account-password-new', 'NeuesPasswort-2026');
    await eingeben('account-password-confirm', 'NeuesPasswort-2026');
    await absenden('account-password');

    expect(q('account-password-info')?.textContent).toBe(t('account.password.changed', 'de'));
    // K-03.3 — geprüft wurde über den Prüf-Client; die Sitzung dieses Geräts ist dieselbe, kein Neuladen des Profils.
    expect(getMockIsolatedAuthCounts()).toEqual({ signIn: 1, signOut: 1 });
    expect(getMockCurrentSession()).toBe(sitzungVorher);
    expect(getMockProfileFetchCount()).toBe(abrufeVorher);
    expect(q('settings-account-page'), 'Seite verlassen oder neu aufgebaut').not.toBeNull();
    // K-03.4 — die anderen Sitzungen sind abgemeldet, diese nicht.
    expect(getMockLastSignOutScope()).toBe('others');
    // K-03.2 — das neue Passwort gilt, das alte nicht.
    const pruefer = createMockIsolatedAuthClient();
    expect((await pruefer.auth.signInWithPassword({ email: 'admin@officepilot.local', password: 'NeuesPasswort-2026' })).error).toBeNull();
    expect((await pruefer.auth.signInWithPassword({ email: 'admin@officepilot.local', password: DEFAULT_ADMIN_PASSWORD })).error).not.toBeNull();
    // Nichts Sichtbares trägt ein Passwort.
    expect(container?.textContent ?? '').not.toContain('NeuesPasswort-2026');
    expect((q('account-password-new') as HTMLInputElement).value).toBe('');
  });

  it('K-03: zu kurz, gleich wie bisher oder nicht wiederholt — eigene Meldung, kein Serveraufruf', async () => {
    await starte();
    await eingeben('account-password-current', DEFAULT_ADMIN_PASSWORD);
    await eingeben('account-password-new', 'kurz');
    await eingeben('account-password-confirm', 'kurz');
    await absenden('account-password');
    expect(q('account-password-info')?.textContent).toBe(t('account.password.weak', 'de'));

    await eingeben('account-password-new', 'NeuesPasswort-2026');
    await eingeben('account-password-confirm', 'AnderesPasswort-2026');
    await absenden('account-password');
    expect(q('account-password-info')?.textContent).toBe(t('account.password.mismatch', 'de'));

    await eingeben('account-password-new', DEFAULT_ADMIN_PASSWORD);
    await eingeben('account-password-confirm', DEFAULT_ADMIN_PASSWORD);
    await absenden('account-password');
    expect(q('account-password-info')?.textContent).toBe(t('account.password.same', 'de'));
    expect(getMockIsolatedAuthCounts().signIn).toBe(0);
  });

  it('K-04.1: die Sprache gilt der Person (Profil und Gerät); company_setup bleibt unverändert', async () => {
    await starte();
    const setupVorher = JSON.stringify(getCachedSetup());
    await klick('language-option-tr');

    expect(localStorage.getItem(`${PERSONAL_UI_LANGUAGE_KEY_PREFIX}${userId}`)).toBe('tr');
    expect(getMockProfile(userId)?.ui_language).toBe('tr');
    expect(document.documentElement.lang).toBe('tr');
    expect(JSON.stringify(getCachedSetup())).toBe(setupVorher);
    expect(firmenAuftraege()).toEqual([]);
  });

  it('K-04.1 (App-Eigenprüfung, N-09): die Bestätigung erscheint in der gewählten Sprache, nicht in der bisherigen', async () => {
    await starte();
    const meldung = () => q('test-meldung')?.textContent ?? '';
    await klick('language-option-tr');
    expect(meldung()).toContain(t('language.saved', 'tr'));
    expect(meldung()).not.toContain(t('language.saved', 'de'));
    await klick('language-option-bg');
    expect(meldung()).toContain(t('language.saved', 'bg'));
    expect(meldung()).not.toContain(t('language.saved', 'tr'));
    await klick('language-option-de');
    expect(meldung()).toContain(t('language.saved', 'de'));
  });

  it('K-04.2: im Nur-Lesen-Betrieb (Lizenz nicht wirksam) ist die Sprachwahl erlaubt, ohne Firmenauftrag', async () => {
    cloudBereich('member');
    localStorage.setItem(
      `${WORKSPACE_ACCESS_KEY_PREFIX}${userId}:${WS}`,
      JSON.stringify({
        workspaceId: WS,
        userId,
        role: 'member',
        licenseState: 'expired',
        licenseEffective: false,
        confirmedAt: '2026-10-23T08:00:00.000Z',
      }),
    );
    resetWorkspaceAccessForTests();
    expect(isWorkspaceLicenseReadOnly(WS, userId)).toBe(true);
    await starte();
    await klick('language-option-bg');

    expect(localStorage.getItem(`${PERSONAL_UI_LANGUAGE_KEY_PREFIX}${userId}`)).toBe('bg');
    expect(getMockProfile(userId)?.ui_language).toBe('bg');
    expect(firmenAuftraege()).toEqual([]);
  });

  it('K-04.3: die am Profil gespeicherte Sprache gilt auf einem anderen Gerät; <html lang> folgt', async () => {
    patchMockProfile(userId, { ui_language: 'tr' });
    // Ein anderes Gerät: keine Wahl auf diesem Gerät gespeichert.
    localStorage.removeItem(`${PERSONAL_UI_LANGUAGE_KEY_PREFIX}${userId}`);
    await starte();
    await beende();
    // Die Anmeldung hat die Profilsprache übernommen; die App liest sie beim nächsten Aufbau.
    expect(localStorage.getItem(`${PERSONAL_UI_LANGUAGE_KEY_PREFIX}${userId}`)).toBe('tr');
    await starte();
    expect(document.documentElement.lang).toBe('tr');
    expect(q('account-language')?.textContent).toContain(t('account.section.language', 'tr'));
  });

  it('K-05.1: eigene Zustimmungen (Version, Zeitpunkt) und Mitgliedschaften mit Betrieb und Rolle', async () => {
    registerMockRpcHandler('list_own_memberships', () => [
      { workspace_id: WS, workspace_name: 'Konto GmbH', role: 'owner', member_since: '2026-10-01T08:00:00.000Z' },
      { workspace_id: 'ws-zweiter', workspace_name: 'Zweitbetrieb', role: 'member', member_since: '2026-10-05T08:00:00.000Z' },
    ]);
    await starte();
    const profil = getMockProfile(userId);

    const zustimmung = q('account-consent')?.textContent ?? '';
    expect(zustimmung).toContain(profil?.accepted_terms_version ?? '—');
    expect(zustimmung).toContain(profil?.accepted_privacy_version ?? '—');
    expect(zustimmung).toContain(profil?.accepted_license_version ?? '—');
    expect(q('account-membership-ws-ein01-konto')?.textContent).toContain('Konto GmbH');
    expect(q('account-membership-ws-ein01-konto')?.textContent).toContain(t('account.role.owner', 'de'));
    expect(q('account-membership-ws-zweiter')?.textContent).toContain(t('account.role.member', 'de'));
  });

  it('K-05.1: ohne Antwort des Servers ein Hinweis statt einer leeren Liste', async () => {
    registerMockRpcHandler('list_own_memberships', () => {
      throw new Error('Failed to fetch');
    });
    await starte();
    expect(q('account-memberships-failed')).not.toBeNull();
    expect(q('account-memberships-empty')).toBeNull();
  });
});
