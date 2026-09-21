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

  /* STARTSEITE-03B — der Upload ist die sekundäre Aktion unter dem Auftragsfeld, kein Kopf-Knopf mehr. */
  it('Startseite: Dokument hochladen als klarer, sekundärer Weg', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="home-card-add-document"');
    expect(html).toContain('href="/dokumente/hinzufuegen"');
    expect(html).toContain('Dokument hochladen');
    /* STARTSEITE-04B — Upload als eigene Fläche neben der Fokusaufgabe, kein Primärknopf. */
    expect(html).toContain('heute-drop');
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

  /* STARTSEITE-03B — kein Mikrofon (es gibt keine Spracheingabe), nur Beispiele, die ohne Kontext antworten. */
  it('Auftragsfeld ohne Mikrofon, mit echten Beispielen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).not.toContain('data-testid="home-assistant-mic"');
    expect(html).toContain('data-testid="home-assistant-input"');
    expect(html).toContain('data-testid="home-assistant-suggestion-heute.work.ask1"');
    expect(html).not.toContain('Schreib eine Rechnung.');
    expect(html).not.toContain('Ordne dieses Dokument zu.');
  });

  it('Steuerberater-Karte ohne Versand vortäuschen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    /* 02B/03B — die Monatsmappe ist ein ruhiger Zustand mit Weg in die Mappe, kein Versandknopf. */
    expect(html).toContain('data-testid="home-monatsmappe"');
    expect(html).toContain('href="/steuerberater"');
    expect(html).not.toContain('An Steuerberater senden');
  });

  it('DE/TR für Mobile-First Texte', () => {
    expect(t('mobile.home.addDocument', 'de')).toBe('Dokument hinzufügen');
    expect(t('mobile.add.photo', 'tr')).toBe('Fotoğraf');
    expect(t('mobile.home.greeting', 'tr')).not.toBe('mobile.home.greeting');
  });
});
