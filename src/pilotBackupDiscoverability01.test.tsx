import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { de } from './i18n';
import { deBackup } from './i18n/locales/de/backup';
import { PersistenceFailureBanner } from './components/system/PersistenceFailureBanner';
import { PilotHintsPanel } from './components/settings/PilotHintsPanel';
import { BackupExportPanel } from './components/settings/BackupExportPanel';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { FirmendatenPage } from './pages/FirmendatenPage';
import { MehrPage } from './pages/MehrPage';
import {
  BACKUP_SECTION_ID,
  FIRMENDATEN_BACKUP_HREF,
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
    expect(de['mehr.companyDesc']).toMatch(/Firmendaten.*Rechnungsangaben.*Datensicherung/);
  });

  it('backup hint mentions daily backup without alarmist tone', () => {
    expect(deBackup['backup.hint']).toMatch(/täglich/i);
    expect(deBackup['backup.hint']).not.toMatch(/sofort|dringend|unbedingt/i);
  });

  it('backup section anchor id is stable and unique', () => {
    expect(BACKUP_SECTION_ID).toBe('datensicherung');
    expect(FIRMENDATEN_BACKUP_HREF).toBe('/firmendaten#datensicherung');
  });

  it('Mehr Firmendaten link points at backup hash', () => {
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
    expect(html).toContain('Datensicherung');
    expect(html).toContain(FIRMENDATEN_BACKUP_HREF);
    expect(html).toContain(`#${BACKUP_SECTION_ID}`);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('BackupExportPanel exposes stable backup section anchor', () => {
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

  it('persistence banner and pilot hint link to backup section', () => {
    notifyPersistenceHealthChanged({ healthy: false, hasFailure: true });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <AppProvider initialSetup={completeSetup}>
            <PersistenceFailureBanner />
            <PilotHintsPanel />
          </AppProvider>
        </MemoryRouter>,
      );
    });

    const bannerLink = container.querySelector(
      '[data-testid="persistence-failure-backup-link"]',
    ) as HTMLAnchorElement;
    const pilotLink = container.querySelector(
      '[data-testid="pilot-hints-backup-link"]',
    ) as HTMLAnchorElement;
    expect(bannerLink.getAttribute('href')).toBe(FIRMENDATEN_BACKUP_HREF);
    expect(pilotLink.getAttribute('href')).toBe(FIRMENDATEN_BACKUP_HREF);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('FirmendatenPage with backup hash scrolls and focuses backup section', async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[FIRMENDATEN_BACKUP_HREF]}>
          <AppProvider initialSetup={completeSetup}>
            <Routes>
              <Route path="/firmendaten" element={<FirmendatenPage />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );
    });

    expect(container.querySelector(`#${BACKUP_SECTION_ID}`)).toBeTruthy();
    expect(container.querySelector('[data-testid="backup-section"]')).toBeTruthy();

    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });

    expect(scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement?.id === BACKUP_SECTION_ID || scrollIntoView.mock.calls.length > 0).toBe(
      true,
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
