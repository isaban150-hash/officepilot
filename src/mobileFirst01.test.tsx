import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { HeutePage } from './pages/HeutePage';
import { DocumentAddPage } from './pages/DocumentAddPage';
import { EingangPage } from './pages/EingangPage';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateTaskStore } from './services/taskStore';
import { hydrateVorgangStore } from './services/vorgangService';
import { createTestVorgang } from './test/fixtures';
import { buildDeskPriorities } from './services/deskIntelligenceService';
import { resetHomeHintDismissals } from './services/homeHintDismissalService';
import { t } from './i18n';

describe('MOBILE-FIRST-01', () => {
  beforeEach(() => {
    resetHomeHintDismissals();
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-mf-1', title: 'Badumbau', customer: 'Müller GmbH' }),
    ]);
    hydrateTaskStore([]);
  });

  afterEach(() => {
    resetHomeHintDismissals();
  });

  it('Mobile Startseite: Dokument hinzufügen ist größte Karte', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('mobile-home-card--primary');
    expect(html).toContain('Foto');
    expect(html).toContain('PDF');
    expect(html).toContain('Galerie');
    expect(html).toContain('Scan');
  });

  it('Dokument hinzufügen: vier große Aktionen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <DocumentAddPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="document-add-page"');
    expect(html).toContain('data-testid="document-add-photo"');
    expect(html).toContain('data-testid="document-add-pdf"');
    expect(html).toContain('data-testid="document-add-gallery"');
    expect(html).toContain('data-testid="document-add-scan"');
    expect(html).not.toContain('Archiv durchsuchen');
  });

  it('Dokumente-Seite zeigt vier Aufnahmewege', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <EingangPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="documents-capture-panel"');
    expect(html).toContain('data-testid="document-add-photo"');
    expect(html).toContain('data-testid="document-add-scan"');
  });

  it('Prioritäten maximal drei Einträge', () => {
    const priorities = buildDeskPriorities();
    expect(priorities.length).toBeLessThanOrEqual(3);
  });

  it('OfficePilot-Karte mit Mikrofon und Vorschlägen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="home-assistant-mic"');
    expect(html).toContain('data-testid="home-assistant-input"');
    expect(html).toContain('data-testid="home-assistant-suggestion-assistant.q1"');
  });

  it('Steuerberater-Karte ohne Versand vortäuschen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="home-card-steuerberater"');
    expect(html).toContain('Monatsmappe vorbereiten');
    expect(html).not.toContain('An Steuerberater senden');
  });

  it('DE/TR für Mobile-First Texte', () => {
    expect(t('mobile.home.addDocument', 'de')).toBe('Dokument hinzufügen');
    expect(t('mobile.add.photo', 'tr')).toBe('Fotoğraf');
    expect(t('mobile.home.greeting', 'tr')).not.toBe('mobile.home.greeting');
  });
});
