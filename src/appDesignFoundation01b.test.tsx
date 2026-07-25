import type { ReactNode } from 'react';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { HeutePage } from './pages/HeutePage';
import { HomeDocumentAddCard } from './components/home/HomeDocumentAddCard';
import { HomeOrdersCard } from './components/home/HomeOrdersCard';
import { HomeOfficePilotCard } from './components/home/HomeOfficePilotCard';
import { HomeSteuerberaterCard } from './components/home/HomeSteuerberaterCard';
import { HomeMoreCard } from './components/home/HomeMoreCard';
import { DeskPriorities } from './components/home/DeskPriorities';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateTaskStore } from './services/taskStore';
import { hydrateVorgangStore } from './services/vorgangService';
import { createTestVorgang } from './test/fixtures';
import { resetHomeHintDismissals } from './services/homeHintDismissalService';
import { buildDeskPriorities } from './services/deskIntelligenceService';
import { t } from './i18n';

const HOME_CARD_ORDER = [
  'home-card-add-document',
  'home-card-orders',
  'home-card-officepilot',
  'home-card-steuerberater',
  'home-card-more',
] as const;

function renderHome() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <HeutePage />
      </AppProvider>
    </MemoryRouter>,
  );
}

function renderCard(node: ReactNode) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AppProvider initialSetup={DEFAULT_SETUP}>{node}</AppProvider>
    </MemoryRouter>,
  );
}

describe('APP-DESIGN-FOUNDATION-01B', () => {
  beforeEach(() => {
    resetHomeHintDismissals();
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-f01b-1', title: 'Badumbau', customer: 'Müller GmbH' }),
    ]);
    hydrateTaskStore([]);
  });

  afterEach(() => {
    resetHomeHintDismissals();
  });

  it('HomeDocumentAddCard rendert documents-NavIcon statt Emoji', () => {
    const html = renderCard(<HomeDocumentAddCard />);
    expect(html).toContain('data-testid="home-card-add-document"');
    expect(html).toContain('mobile-home-card__icon');
    expect(html).toContain('nav-icon');
    expect(html).toContain('<svg');
    expect(html).not.toContain('mobile-home-card__emoji');
    expect(html).not.toContain('📥');
    expect(html).toContain('href="/dokumente/hinzufuegen"');
    expect(html).toContain(t('mobile.home.addDocument', 'de'));
  });

  it('HomeOrdersCard rendert orders-NavIcon', () => {
    const html = renderCard(<HomeOrdersCard />);
    expect(html).toContain('data-testid="home-card-orders"');
    expect(html).toContain('mobile-home-card__icon');
    expect(html).toContain('<svg');
    expect(html).not.toContain('mobile-home-card__emoji');
    expect(html).not.toContain('📂');
    expect(html).toContain('href="/vorgaenge"');
    expect(html).toContain(t('mobile.home.ordersTitle', 'de'));
  });

  it('HomeOfficePilotCard rendert assistant-NavIcon', () => {
    const html = renderCard(<HomeOfficePilotCard />);
    expect(html).toContain('data-testid="home-card-officepilot"');
    expect(html).toContain('mobile-home-card__icon');
    expect(html).toContain('<svg');
    expect(html).not.toContain('mobile-home-card__emoji');
    expect(html).not.toContain('🤖');
    expect(html).toContain(t('mobile.home.assistantTitle', 'de'));
  });

  it('HomeSteuerberaterCard rendert tax-NavIcon', () => {
    const html = renderCard(<HomeSteuerberaterCard />);
    expect(html).toContain('data-testid="home-card-steuerberater"');
    expect(html).toContain('mobile-home-card__icon');
    expect(html).toContain('<svg');
    expect(html).not.toContain('mobile-home-card__emoji');
    expect(html).not.toContain('🧾');
    expect(html).toContain('href="/steuerberater"');
    expect(html).toContain(t('mobile.home.taxTitle', 'de'));
  });

  it('HomeMoreCard rendert more-NavIcon', () => {
    const html = renderCard(<HomeMoreCard />);
    expect(html).toContain('data-testid="home-card-more"');
    expect(html).toContain('mobile-home-card__icon');
    expect(html).toContain('<svg');
    expect(html).not.toContain('mobile-home-card__emoji');
    expect(html).toContain('href="/mehr"');
    expect(html).toContain(t('mobile.home.moreTitle', 'de'));
  });

  it('Schreibtisch behält Kartenreihenfolge, Links und Texte', () => {
    const html = renderHome();
    const positions = HOME_CARD_ORDER.map((id) => html.indexOf(`data-testid="${id}"`));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }

    expect(html).toContain('href="/dokumente/hinzufuegen"');
    expect(html).toContain('href="/vorgaenge"');
    expect(html).toContain('href="/steuerberater"');
    expect(html).toContain('href="/mehr"');
    expect(html).toContain(t('mobile.home.addDocument', 'de'));
    expect(html).toContain(t('mobile.home.ordersTitle', 'de'));
    expect(html).toContain(t('mobile.home.assistantTitle', 'de'));
    expect(html).toContain(t('mobile.home.taxTitle', 'de'));
    expect(html).toContain(t('mobile.home.moreTitle', 'de'));
    expect(html).not.toContain('mobile-home-card__emoji');
  });

  it('DeskPriorities zeigt keine Severity-Emojis und bleibt unterscheidbar', () => {
    const priorities = buildDeskPriorities();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <DeskPriorities />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).not.toContain('🔴');
    expect(html).not.toContain('🟠');
    expect(html).not.toContain('🟡');

    if (priorities.length === 0) {
      expect(html).toContain('data-testid="desk-priorities-empty"');
      return;
    }

    const severities = new Set(priorities.slice(0, 3).map((hint) => hint.severity));
    for (const severity of severities) {
      expect(html).toContain(`desk-priorities__severity--${severity}`);
      expect(html).toContain(`data-severity="${severity}"`);
    }
    expect(html).toContain('desk-priorities__severity-dot');
    expect(html).toContain('sr-only');

    for (const hint of priorities.slice(0, 3)) {
      expect(html).toContain(`data-testid="desk-priority-${hint.id}"`);
      const labelKey =
        hint.severity === 'critical'
          ? 'priority.kritisch'
          : hint.severity === 'warning'
            ? 'priority.hoch'
            : 'priority.mittel';
      expect(html).toContain(t(labelKey, 'de'));
    }
  });

  it('Prioritätsreihenfolge und Inhalte bleiben unverändert', () => {
    const priorities = buildDeskPriorities();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <DeskPriorities />
        </AppProvider>
      </MemoryRouter>,
    );

    const visible = priorities.slice(0, 3);
    const positions = visible.map((hint) => html.indexOf(`data-testid="desk-priority-${hint.id}"`));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('Mobile und Desktop nutzen dieselben Home-Komponenten', () => {
    const html = renderHome();
    expect(html).toContain('data-testid="mobile-first-home"');
    expect(html).toContain('data-testid="home-card-add-document"');
    expect(html).toContain('data-testid="home-card-orders"');
    expect(html).toContain('data-testid="home-card-officepilot"');
    expect(html).toContain('data-testid="home-card-steuerberater"');
    expect(html).toContain('data-testid="home-card-more"');
  });
});
