import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { de } from './i18n';
import { deBackup } from './i18n/locales/de/backup';
import { PersistenceFailureBanner } from './components/system/PersistenceFailureBanner';
import { BackupExportPanel } from './components/settings/BackupExportPanel';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { alsInhaber } from './test/workspaceRoleTestUtils';
import { BackupSettingsPage } from './pages/settings/BackupSettingsPage';
import { resolveFirmendatenLegacyTarget } from './pages/settings/FirmendatenLegacyRoute';
import { MehrPage } from './pages/MehrPage';
import {
  BACKUP_SECTION_ID,
  SETTINGS_BACKUP_HREF,
} from './services/backupSectionNavigation';
import { notifyPersistenceHealthChanged, resetPersistenceHealthForTests } from './services/persistenceHealthService';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true };

describe('PILOT-BACKUP-DISCOVERABILITY-01', () => {
  beforeEach(() => {    resetPersistenceHealthForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Firmendaten description names Datensicherung', () => {
    expect(de['mehr.companyDesc']).toContain('Datensicherung');
    expect(de['mehr.company']).toBe('Einstellungen');
  });

  it('backup hint mentions daily backup without alarmist tone', () => {
    expect(deBackup['backup.hint']).toMatch(/täglich/i);
    expect(deBackup['backup.hint']).not.toMatch(/sofort|dringend|unbedingt/i);
  });

  it('backup section anchor id is stable and unique', () => {
    expect(BACKUP_SECTION_ID).toBe('datensicherung');
    // EINRICHTUNG-01 (AP5; 1.15) — kanonisch ist die eigene Seite „Daten › Sicherung“; die alte URL bleibt redirectfähig.
    expect(SETTINGS_BACKUP_HREF).toBe('/einstellungen/daten/sicherung');
    // Die Legacy-URL bleibt redirectfähig — ohne eigene Konstante.
    expect(resolveFirmendatenLegacyTarget('#datensicherung')).toBe(SETTINGS_BACKUP_HREF);
  });

  it('Mehr enthält keinen zweiten Einstellungen-Einstieg und keinen Sprachumschalter (UIUX-01C)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <AuthProvider>
            <AppProvider initialSetup={completeSetup}>
              <MehrPage />
            </AppProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
    });

    const html = container.innerHTML;
    /* UIUX-01C — Einstellungen nur über Zahnrad/Benutzermenü; Mehr verlinkt Synchronisation, nicht die Datensicherung. */
    expect(html).not.toContain('href="/einstellungen"');
    // EINRICHTUNG-01 (AP5; 1.15) — die Synchronisation steht unter „Einstellungen › Hilfe und Rechtliches“, nicht in „Mehr“.
    expect(html).not.toContain('href="/synchronisation"');
    expect(html).not.toContain('/firmendaten');
    expect(container.querySelector('[data-testid="language-switcher"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('BackupExportPanel exposes stable backup section anchor', () => {
    // EINRICHTUNG-01 (E9) — den Sicherungsknopf sehen nur Inhaber und Admins (bzw. der lokale Betrieb).
    alsInhaber();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <AppProvider initialSetup={completeSetup}>
            <BackupExportPanel />
          </AppProvider>
        </MemoryRouter>,
      );
    });

    const section = container.querySelector(
      `[data-testid="backup-section"]#${BACKUP_SECTION_ID}`,
    ) as HTMLElement | null;
    expect(section).toBeTruthy();
    expect(section?.id).toBe(BACKUP_SECTION_ID);
    expect(section?.getAttribute('tabindex')).toBe('-1');
    expect(container.querySelector('[data-testid="backup-export-download"]')).toBeTruthy();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('persistence banner links to the backup section', () => {
    notifyPersistenceHealthChanged({ healthy: false, hasFailure: true });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <AppProvider initialSetup={completeSetup}>
            <PersistenceFailureBanner />
          </AppProvider>
        </MemoryRouter>,
      );
    });

    const bannerLink = container.querySelector(
      '[data-testid="persistence-failure-backup-link"]',
    ) as HTMLAnchorElement;
    expect(bannerLink.getAttribute('href')).toBe(SETTINGS_BACKUP_HREF);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  /*
   * EINRICHTUNG-01 (AP5; 1.15) — die Datensicherung ist eine eigene Seite: Der Link aus dem Speicherfehler-Hinweis landet
   * direkt bei ihr, ein Sprung innerhalb der Seite entfällt. Der Abschnitt behält seine Kennung für Altverweise.
   */
  it('BackupSettingsPage: der Tiefenlink öffnet die Sicherungsseite mit dem Abschnitt', async () => {
    alsInhaber();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[SETTINGS_BACKUP_HREF]}>
          <AuthProvider>
            <AppProvider initialSetup={completeSetup}>
              <Routes>
                <Route path={SETTINGS_BACKUP_HREF} element={<BackupSettingsPage />} />
              </Routes>
            </AppProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('[data-testid="settings-backup-page"]')).toBeTruthy();
    expect(container.querySelector(`#${BACKUP_SECTION_ID}`)).toBeTruthy();
    expect(container.querySelector('[data-testid="backup-section"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="backup-export-download"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
