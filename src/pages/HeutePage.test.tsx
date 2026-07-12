import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { HeutePage } from './HeutePage';
import { hydrateInboxStore } from '../services/inboxService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateTaskStore } from '../services/taskStore';
import { resetHomeHintDismissals } from '../services/homeHintDismissalService';
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
  'Dashboard',
  'KPI',
];

describe('HeutePage MOBILE-FIRST-01', () => {
  beforeEach(() => {
    resetHomeHintDismissals();
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
    hydrateVorgangStore([]);
    hydrateDocumentStore([]);
    hydrateTaskStore([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetHomeHintDismissals();
  });

  it('rendert Mobile-First Startseite mit 5 Hauptkarten', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="heute-page"');
    expect(html).toContain('data-testid="mobile-first-home"');
    expect(html).toContain('data-testid="home-card-add-document"');
    expect(html).toContain('data-testid="home-card-orders"');
    expect(html).toContain('data-testid="home-card-officepilot"');
    expect(html).toContain('data-testid="home-card-steuerberater"');
    expect(html).toContain('data-testid="home-card-more"');
    expect(html).toContain('Dokument hinzufügen');
    expect(html).toContain('data-testid="desk-greeting-header"');
    expect(html).toContain('Heute kümmere ich mich um Folgendes:');
  });

  it('zeigt keine KPI-Wand oder altes Dashboard', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).not.toContain('data-testid="heute-dashboard"');
    expect(html).not.toContain('data-testid="home-desk-tiles"');
    expect(html).not.toContain('data-testid="heute-hero"');
    expect(html).not.toContain('Offene Rechnungen');
  });

  it('Hauptfunktionen mit maximal zwei Klicks erreichbar', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('href="/dokumente/hinzufuegen"');
    expect(html).toContain('href="/vorgaenge"');
    expect(html).toContain('href="/steuerberater"');
    expect(html).toContain('href="/mehr"');
    expect(html).toContain('data-testid="home-assistant-input"');
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
});

describe('SidebarNav active state', () => {
  it('markiert aktiven Link auf Schreibtisch', () => {
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
