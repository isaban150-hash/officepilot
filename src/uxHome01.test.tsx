import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { BottomNav } from './components/layout/BottomNav';
import { SidebarNav } from './components/layout/SidebarNav';
import { HeutePage } from './pages/HeutePage';
import { SteuerberaterPage } from './pages/SteuerberaterPage';
import { EingangPage } from './pages/EingangPage';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateTaskStore } from './services/taskStore';
import { hydrateVorgangStore } from './services/vorgangService';
import { createTestVorgang } from './test/fixtures';
import {
  buildHomeHintId,
  computeSnoozeUntil,
  dismissHomeHint,
  isHomeHintVisible,
  resetHomeHintDismissals,
  snoozeHomeHint,
} from './services/homeHintDismissalService';
import { buildHomeHints } from './services/homeHintService';
import {
  getDefaultSteuerberaterMonthKey,
  getSteuerberaterMonthOverview,
} from './services/steuerberaterOverviewService';
import { DESKTOP_NAV_ITEMS, MOBILE_BOTTOM_NAV_ITEMS } from './components/layout/navConfig';
import { t } from './i18n';

describe('UX-HOME-01 ABSCHLUSSFIX', () => {
  beforeEach(() => {
    resetHomeHintDismissals();
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-ux-1', title: 'Badumbau', customer: 'Müller GmbH' }),
    ]);
    hydrateTaskStore([]);
  });

  afterEach(() => {
    resetHomeHintDismissals();
  });

  it('Desktop-Schreibtisch zeigt Mobile-First Startseite', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="mobile-first-home"');
    expect(html).toContain('data-testid="home-card-add-document"');
    expect(html).toContain('data-testid="home-card-orders"');
    expect(html).toContain('data-testid="home-card-officepilot"');
    expect(html).toContain('data-testid="home-card-steuerberater"');
    expect(html).toContain('data-testid="home-card-more"');
  });

  it('Mobile Bottom-Nav hat maximal 5 Punkte ohne Steuerberater', () => {
    expect(MOBILE_BOTTOM_NAV_ITEMS).toHaveLength(5);
    expect(MOBILE_BOTTOM_NAV_ITEMS.map((item) => item.to)).toEqual([
      '/',
      '/ablage',
      '/vorgaenge',
      '/assistent',
      '/mehr',
    ]);

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <BottomNav />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).not.toContain('Steuerberater');
    expect(html).not.toContain('Kunden');
    expect(html).toContain('Schreibtisch');
    expect(html).toContain('Dokumente');
  });

  it('Desktop-Sidebar behält 6 Bereiche inkl. Steuerberater', () => {
    expect(DESKTOP_NAV_ITEMS).toHaveLength(6);

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <SidebarNav />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('Steuerberater');
  });

  it('Steuerberater über Startseite, Kunden nur über Mehr', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('href="/steuerberater"');
    expect(html).not.toContain('href="/kunden"');
    expect(html).toContain('href="/mehr"');
  });

  it('Steuerberater ohne echten Versand-Button', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <SteuerberaterPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="steuerberater-prepare-folder"');
    expect(html).toContain('Monatsmappe vorbereiten');
    expect(html).not.toContain('An Steuerberater senden');
    expect(html).not.toContain('erfolgreich versendet');
    expect(html).not.toContain('Versand vorbereitet');
  });

  it('Vormonat am 2./3. des Monats als Standard', () => {
    expect(getDefaultSteuerberaterMonthKey(new Date('2026-08-02'))).toBe('2026-07');
    expect(getDefaultSteuerberaterMonthKey(new Date('2026-08-03'))).toBe('2026-07');
    expect(getDefaultSteuerberaterMonthKey(new Date('2026-08-04'))).toBe('2026-08');

    const overview = getSteuerberaterMonthOverview(new Date('2026-08-03'), 'de-DE');
    expect(overview.isDefaultMonth).toBe(true);
    expect(overview.monthKey).toBe('2026-07');
  });

  it('Snooze morgen / 3 Tage / nächste Woche', () => {
    const now = new Date('2026-07-06T12:00:00Z');
    const hintId = buildHomeHintId('hints.test', { id: 1 });

    snoozeHomeHint(hintId, 'tomorrow', now);
    expect(isHomeHintVisible(hintId, now)).toBe(false);
    expect(isHomeHintVisible(hintId, new Date(now.getTime() + 86400000))).toBe(true);

    resetHomeHintDismissals();
    const until3 = new Date(computeSnoozeUntil('3days', now));
    expect(until3.getDate()).toBe(9);
    expect(until3.getMonth()).toBe(6);

    resetHomeHintDismissals();
    const untilWeek = new Date(computeSnoozeUntil('nextweek', now));
    expect(untilWeek.getDate()).toBe(13);
  });

  it('Hinweisleiste unterstützt Ausblenden ohne Wiederholung', () => {
    const hintId = buildHomeHintId('hints.steuerberaterReady', { month: 'Juli 2026' });
    dismissHomeHint(hintId, 'hidden');
    expect(isHomeHintVisible(hintId)).toBe(false);
    expect(buildHomeHints().some((hint) => hint.id === hintId)).toBe(false);
  });

  it('Dokumente-Seite zeigt alle Aufnahmewege', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <EingangPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="documents-capture-panel"');
    expect(html).toContain('data-testid="document-add-photo"');
    expect(html).toContain('data-testid="document-add-pdf"');
    expect(html).toContain('data-testid="document-add-scan"');
    expect(html).toContain('Foto');
    expect(html).toContain('PDF');
  });

  it('DE/TR vollständig für neue Texte', () => {
    const keys = [
      'steuerberater.prepareFolderButton',
      'steuerberater.noDirectSend',
      'ablage.action.photo',
      'hints.action.snoozeTomorrow',
    ] as const;

    for (const key of keys) {
      expect(t(key, 'de').length).toBeGreaterThan(0);
      expect(t(key, 'tr').length).toBeGreaterThan(0);
      expect(t(key, 'tr')).not.toBe(key);
    }
  });
});
