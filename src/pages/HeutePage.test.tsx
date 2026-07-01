import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { HeutePage } from './HeutePage';
import { hydrateInboxStore } from '../services/inboxService';
import * as pendingEngineService from '../services/pendingEngineService';

const FORBIDDEN_TERMS = [
  'Inbox',
  'OCR',
  'Smart Intake',
  'Workflow',
  'Engine',
  'recognizedData',
  'Context',
];

describe('HeutePage', () => {
  beforeEach(() => {
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rendert die Startseite mit Scan-Button und Schnellaktionen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="heute-page"');
    expect(html).toContain('data-testid="heute-scan-button"');
    expect(html).toContain('Foto / Scan');
    expect(html).toContain('data-testid="heute-quick-actions"');
    expect(html).toContain('Brief verstehen');
    expect(html).toContain('Rechnung schreiben');
    expect(html).toContain('Ausgabe erfassen');
    expect(html).toContain('Auftrag öffnen');
    expect(html).toContain('Nachricht schreiben');
    expect(html).toContain('Frag OfficePilot');
  });

  it('nutzt Pending-Daten für die Heute-Liste', () => {
    const scanSpy = vi.spyOn(pendingEngineService, 'scanPendingItems');

    renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(scanSpy).toHaveBeenCalled();
    expect(scanSpy.mock.results[0]?.value.items.length).toBeGreaterThan(0);
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
