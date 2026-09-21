import type { ReactNode } from 'react';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { HeutePage } from './pages/HeutePage';
import { HomeQuickActions } from './components/home/HomeQuickActions';
import { HomeOpenWork } from './components/home/HomeOpenWork';
import { HomeAssistantPrompt } from './components/home/HomeAssistantPrompt';
import { HomeKpis } from './components/home/HomeKpis';
import { DeskPriorities } from './components/home/DeskPriorities';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateTaskStore } from './services/taskStore';
import { hydrateVorgangStore } from './services/vorgangService';
import { createTestVorgang } from './test/fixtures';
import { resetHomeHintDismissals } from './services/homeHintDismissalService';
import { buildDeskPriorities } from './services/deskIntelligenceService';
import { t } from './i18n';

/* VISUAL-POLISH-01B — Reihenfolge im Markup: Hauptaktion, Hauptspalte (Prioritäten, offene Arbeit, OfficePilot-Eingang), Seitenspalte (Kennzahlen/Steuerberater, Schnellaktionen). Mobil ordnet CSS `order` die Blöcke um. */
/* STARTSEITE-04B — Reihenfolge nach Prototyp 04A: Fokusaufgabe, Danach/Upload, Auftragsfeld, Eingang, Monatsmappe. */
const HOME_CARD_ORDER = [
  'heute-section-attention',
  'home-card-add-document',
  'home-card-officepilot',
  'heute-section-new',
  'home-monatsmappe',
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

  it('HomeQuickActions rendert Aufnahmewege als kompakte SVG-Aktionen', () => {
    const html = renderCard(<HomeQuickActions />);
    expect(html).toContain('data-testid="home-quick-add"');
    expect(html).toContain('data-testid="home-quick-scan"');
    expect(html).not.toContain('document-add-actions--inline');
    expect(html).toContain('<svg');
    expect(html).not.toContain('mobile-home-card__emoji');
    expect(html).not.toContain('📥');
  });

  it('HomeOpenWork rendert Eingang, Aufträge, Rechnungen als Zeilen mit NavIcon; Steuerberater nur in HomeKpis', () => {
    const html = renderCard(<HomeOpenWork />) + renderCard(<HomeKpis />);
    for (const id of ['home-card-inbox', 'home-card-orders', 'home-card-invoices', 'home-card-steuerberater']) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect((html.match(/data-testid="home-card-steuerberater"/g) ?? []).length).toBe(1);
    expect(html).toContain('row-list__icon');
    expect(html).toContain('<svg');
    expect(html).not.toContain('📂');
    expect(html).not.toContain('🧾');
    expect(html).toContain('href="/vorgaenge"');
    expect(html).toContain('href="/steuerberater"');
    expect(html).toContain(t('mobile.home.ordersTitle', 'de'));
    expect(html).toContain(t('mobile.home.taxTitle', 'de'));
  });

  it('HomeAssistantPrompt rendert assistant-Icon ohne Emoji', () => {
    const html = renderCard(<HomeAssistantPrompt />);
    expect(html).toContain('data-testid="home-card-officepilot"');
    expect(html).toContain('assistant-prompt__icon');
    expect(html).toContain('<svg');
    expect(html).not.toContain('🤖');
    expect(html).not.toContain('🎤');
    expect(html).toContain(t('mobile.home.assistantTitle', 'de'));
  });

  it('HomeKpis rendert vier Kennzahlen mit Links', () => {
    const html = renderCard(<HomeKpis />);
    for (const id of ['home-kpi-receivables', 'home-kpi-inbox', 'home-kpi-orders', 'home-kpi-tax']) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('href="/steuerberater"');
    expect(html).toContain(t('heute.section.kpis', 'de').length > 0 ? 'kpi-tile__value' : '');
  });

  it('Schreibtisch behält Kartenreihenfolge, Links und Texte', () => {
    const html = renderHome();
    const positions = HOME_CARD_ORDER.map((id) => html.indexOf(`data-testid="${id}"`));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }

    expect(html).toContain('href="/dokumente/hinzufuegen"');
    expect(html).toContain('href="/steuerberater"');
    // VISUAL-POLISH-01B — „Mehr“ ist Navigation (Bottom-Nav/Sidebar), keine Heute-Karte.
    expect(html).not.toContain('href="/mehr"');
    expect(html).toContain(t('heute.pilot.upload', 'de'));
    expect(html).toContain(t('heute.work.askTitle', 'de'));
    expect(html).toContain(t('heute.work.inboxTitle', 'de'));
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
    // VISUAL-POLISH-01B — Statuswort (StatusBadge) statt farbigem Punkt.
    expect(html).not.toContain('desk-priorities__severity-dot');
    expect(html).toContain('status-badge');
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
    expect(html).toContain('data-testid="heute-section-attention"');
    expect(html).toContain('data-testid="home-card-officepilot"');
    expect(html).toContain('data-testid="home-monatsmappe"');
    // VISUAL-POLISH-01B — keine Mehr-Karte mehr auf Heute (Bottom-Nav/Sidebar führen dorthin).
    expect(html).not.toContain('data-testid="home-card-more"');
  });
});
