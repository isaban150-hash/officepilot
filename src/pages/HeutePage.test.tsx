import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { HeutePage } from './HeutePage';
import { hydrateInboxStore } from '../services/inboxService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { hydrateDocumentStore, importInboxDocument } from '../services/documentService';
import { hydrateTaskStore } from '../services/taskStore';
import { resetMemory } from '../services/officePilotMemoryService';
import { createTestVorgang, createAuftragInboxItem } from '../test/fixtures';
import * as heuteDashboardService from '../services/heuteDashboardService';
import { SidebarNav } from '../components/layout/SidebarNav';

const FORBIDDEN_TERMS = [
  'Inbox',
  'OCR',
  'Smart Intake',
  'Workflow',
  'Engine',
  'recognizedData',
  'Context',
  'Pending',
  'Lifecycle',
  'Entity',
  'Sync',
];

describe('HeutePage', () => {
  beforeEach(() => {
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-heute-1', title: 'Testauftrag', status: 'in_bearbeitung' }),
    ]);
    hydrateDocumentStore([]);
    hydrateTaskStore([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rendert Premium-Hero mit Dashboard und 6 Schnellaktionen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="heute-page"');
    expect(html).toContain('data-testid="heute-hero"');
    expect(html).toContain('Was soll OfficePilot heute erledigen?');
    expect(html).toContain('data-testid="heute-scan-button"');
    expect(html).toContain('Dokument scannen');
    expect(html).toContain('OfficePilot fragen');
    expect(html).toContain('data-testid="heute-dashboard"');
    expect(html).toContain('Offene Dokumente');
    expect(html).toContain('Offene Rechnungen');
    expect(html).toContain('Fristen diese Woche');
    expect(html).toContain('Aufgaben heute');
    expect(html).toContain('data-testid="heute-quick-actions"');
    expect(html).toContain('data-testid="heute-action-scan"');
    expect(html).toContain('data-testid="heute-action-understand"');
    expect(html).toContain('data-testid="heute-action-invoice"');
    expect(html).toContain('data-testid="heute-action-expense"');
    expect(html).toContain('data-testid="heute-action-message"');
    expect(html).toContain('data-testid="heute-action-search"');
  });

  it('zeigt keine dominante Gerade-erfasst-Liste mehr', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).not.toContain('data-testid="heute-today-list"');
    expect(html).not.toContain('Gerade erfasst');
  });

  it('nutzt Dashboard-Daten aus bestehenden Services', () => {
    const statsSpy = vi.spyOn(heuteDashboardService, 'getHeuteDashboardStats');

    renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(statsSpy).toHaveBeenCalled();
  });

  it('zeigt Welcome-State im First-Run ohne offene Punkte', () => {
    hydrateInboxStore([]);
    hydrateVorgangStore([]);
    hydrateDocumentStore([]);
    hydrateTaskStore([]);

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="heute-welcome"');
    expect(html).toContain('Willkommen bei OfficePilot');
    expect(html).toContain('Erstes Dokument scannen');
    expect(html).not.toContain('data-testid="heute-open-items"');
  });

  it('zeigt kompakte offene Punkte nur bei echten Daten', () => {
    resetMemory();
    hydrateDocumentStore([]);
    importInboxDocument(
      createAuftragInboxItem({
        id: 'inbox-heute-ui',
        title: 'Freistellungsbescheinigung §48b',
        documentType: 'behoerde',
        classifiedKind: 'freistellungsbescheinigung',
        sender: 'Finanzamt München',
        deadline: '2026-12-31',
      }),
      'Test GmbH',
    );

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="heute-open-items"');
    expect(html).not.toContain('data-testid="heute-lifecycle-list"');
    expect(html).toContain('Original noch abheften');
    expect(html).toContain('Alle anzeigen');
    expect(html).not.toContain('data-testid="heute-welcome"');
  });

  it('zeigt keine technischen Entwicklerbegriffe', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    for (const term of FORBIDDEN_TERMS) {
      expect(html).not.toContain(term);
    }
  });

  it('enthält Scan- und Suche-Routen in Schnellaktionen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="heute-action-scan"');
    expect(html).toContain('data-testid="heute-action-search"');
    expect(html).toContain('/suche');
  });
});


describe('SidebarNav active state', () => {
  it('markiert aktiven Link auf Heute', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <SidebarNav />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="sidebar-nav-link-home"');
    expect(html).toContain('sidebar-nav__item--active');
  });
});
