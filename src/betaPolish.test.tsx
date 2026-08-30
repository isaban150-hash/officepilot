import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TestProviders } from './test/testProviders';
import { DEFAULT_SETUP } from './data/mockData';
import { AppShell } from './components/layout/AppShell';
import { EingangPage } from './pages/EingangPage';
import { AufgabenPage } from './pages/AufgabenPage';
import { DokumentePage } from './pages/DokumentePage';
import { VorgaengePage } from './pages/VorgaengePage';
import { SearchPage } from './pages/SearchPage';
import { SyncPage } from './pages/SyncPage';
import { RechnungPage } from './pages/RechnungPage';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateDocumentStore } from './services/documentService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateTaskStore } from './services/taskStore';
import { formatInboxActionToast } from './utils/inboxActionToast';
import { confirmFiling } from './services/inboxTaskService';
import { callAiProxy, setAiProxyFetchForTests } from './services/ai/aiProxyClient';
import { createSyncClient, hydrateSyncClient } from './services/sync/syncClientService';
import { loginAsDefaultAdmin, seedDefaultAdminUser } from './test/authFixtures';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { BetaModeBanner } from './components/layout/BetaModeBanner';
import * as betaTestMode from './config/betaTestMode';
import * as syncUiService from './services/sync/syncUiService';
import type { TranslationKey } from './i18n';
import { de } from './i18n/index';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

function translate(key: TranslationKey): string {
  return de[key] ?? key;
}

describe('BETA-TEST-01 polish', () => {
  beforeEach(() => {
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Empty states', () => {
    it('zeigt Ablage-Empty-State mit Aufnahmewege', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <TestProviders initialSetup={completeSetup}>
            <EingangPage />
          </TestProviders>
        </MemoryRouter>,
      );

      expect(html).toContain('data-testid="ablage-empty-state"');
      expect(html).toContain('Alles erledigt');
      expect(html).toContain('data-testid="documents-capture-panel"');
      expect(html).toContain('Foto');
    });

    it('zeigt Dokumente-Empty-State mit Hinzufügen-Aktion', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <TestProviders initialSetup={completeSetup}>
            <DokumentePage />
          </TestProviders>
        </MemoryRouter>,
      );

      expect(html).toContain('data-testid="document-empty-state"');
      expect(html).toContain('Noch keine Dokumente');
      expect(html).toContain('Dokument hinzufügen');
    });

    it('zeigt Aufträge-Empty-State mit Scan-Aktion', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <TestProviders initialSetup={completeSetup}>
            <VorgaengePage />
          </TestProviders>
        </MemoryRouter>,
      );

      expect(html).toContain('data-testid="vorgaenge-empty-state"');
      expect(html).toContain('Noch keine Aufträge');
    });

    it('zeigt Aufgaben-Empty-State für offene Filter', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <TestProviders initialSetup={completeSetup}>
            <AufgabenPage />
          </TestProviders>
        </MemoryRouter>,
      );

      expect(html).toContain('data-testid="aufgaben-empty-state"');
      expect(html).toContain('Alles erledigt');
    });

    it('zeigt Suche-Hinweis ohne Suchbegriff', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/suche']}>
          <TestProviders initialSetup={completeSetup}>
            <SearchPage />
          </TestProviders>
        </MemoryRouter>,
      );

      expect(html).toContain('data-testid="search-empty-query"');
      expect(html).toContain('OfficePilot durchsuchen');
    });
  });

  describe('Navigation & Terminologie', () => {
    it('verlinkt Aufgaben zur Ablage statt Legacy-Eingang', () => {
      hydrateInboxStore([
        {
          ...MOCK_INBOX_ITEMS[0],
          id: 'inbox-link-test',
          status: 'neu',
          isNewUpload: false,
        },
      ]);
      hydrateTaskStore([
        {
          id: 'task-link-test',
          title: 'Brief prüfen',
          description: 'Test',
          status: 'open',
          priority: 'mittel',
          category: 'dokumente',
          linkedInboxId: 'inbox-link-test',
          sourceType: 'inbox',
          sourceId: 'inbox-link-test',
          taskKind: 'inbox_review',
          dedupeKey: 'inbox-link-test:review',
          autoCreated: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          type: 'dokument_pruefen',
        },
      ]);

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <TestProviders initialSetup={completeSetup}>
            <AufgabenPage />
          </TestProviders>
        </MemoryRouter>,
      );

      expect(html).toContain('/ablage/inbox-link-test');
      expect(html).not.toContain('/eingang/inbox-link-test');
    });

    it('leitet unbekannte Routen zur Startseite um', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/unbekannte-route']}>
          <TestProviders initialSetup={completeSetup}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<div data-testid="heute-fallback">Heute</div>} />
                <Route path="*" element={<div data-testid="redirect-target">Redirect</div>} />
              </Route>
            </Routes>
          </TestProviders>
        </MemoryRouter>,
      );

      expect(html).toContain('data-testid="app-shell"');
    });
  });

  describe('Fehlermeldungen', () => {
    it('formatiert Inbox-Toasts auf Deutsch über i18n', () => {
      hydrateDocumentStore([
        {
          id: 'doc-toast-archive',
          title: 'Toast Archiv',
          category: 'sonstiges',
          issuer: 'Test',
          recognizedText: '',
          issueDate: null,
          validUntil: null,
          digitalFolder: { id: 'd1', name: 'Test', path: '/test/' },
          paperFolder: { folderId: 'f1', register: 'A', label: 'Test' },
          tags: [],
          linkedCompany: 'Test GmbH',
          linkedVorgang: null,
          archived: true,
          createdAt: '2026-03-01T10:00:00.000Z',
        },
      ]);
      hydrateInboxStore([
        {
          ...MOCK_INBOX_ITEMS[0],
          id: 'inbox-toast-test',
          status: 'neu',
          importedToArchive: true,
          archiveDocumentId: 'doc-toast-archive',
        },
      ]);
      const result = confirmFiling('inbox-toast-test');
      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
      const msg = formatInboxActionToast(result!, translate);
      expect(msg).toContain('Abgelegt.');
      expect(msg).not.toMatch(/Upload failed|error/i);
    });

    it('liefert freundliche KI-Fehlermeldungen ohne Englisch', async () => {
      /*
       * Dieselbe Zusicherung wie zuvor, jetzt am OfficePilot-Endpunkt statt am
       * direkten Gemini-Aufruf: Ein technischer Fremdtext darf den Nutzer nicht
       * erreichen. Der Server reicht ohnehin nur einen Code heraus.
       */
      await seedDefaultAdminUser();
      await loginAsDefaultAdmin();
      hydrateSyncClient({
        ...createSyncClient(),
        serverWorkspaceId: '123e4567-e89b-12d3-a456-426614174000',
      });
      setAiProxyFetchForTests(
        vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
          json: async () => ({ ok: false, error: 'ai_upstream_error' }),
        }) as unknown as typeof fetch,
      );
      try {
        const result = await callAiProxy('assistant', 'Test');

        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.message).toContain('nicht erreichbar');
        expect(result.message).not.toContain('API key');
        expect(result.message).not.toMatch(/[A-Za-z]+ key not valid/);
      } finally {
        setAiProxyFetchForTests(null);
      }
    });

    it('zeigt Sync-Fehler ohne technische Rohmeldung', () => {
      vi.spyOn(syncUiService, 'getSyncUiSnapshot').mockReturnValue({
        deviceId: 'device-1234567890',
        workspaceId: 'workspace-1234567890',
        syncPolicy: 'cloud_ready',
        status: {
          syncState: 'error',
          pendingChanges: 0,
          lastError: 'ECONNREFUSED: connection refused at sync.push()',
        },
        lastReport: null,
        outbox: [],
        outboxCounts: { pending: 0, completed: 0, error: 0 },
        pendingOutboxEntries: [],
        isOffline: false,
        hasRetryableErrors: false,
      });

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <TestProviders initialSetup={completeSetup}>
            <SyncPage />
          </TestProviders>
        </MemoryRouter>,
      );

      expect(html).toContain('Bitte versuchen Sie es erneut');
      expect(html).not.toContain('ECONNREFUSED');
    });
  });

  describe('Rechnung not found', () => {
    it('nutzt i18n für fehlenden Auftrag', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/vorgaenge/missing/rechnung']}>
          <TestProviders initialSetup={completeSetup}>
            <Routes>
              <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
            </Routes>
          </TestProviders>
        </MemoryRouter>,
      );

      expect(html).toContain('Auftrag nicht gefunden');
      expect(html).not.toContain('Vorgang nicht gefunden.');
    });
  });
});

describe('Beta mode banner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('zeigt Banner im Testmodus', () => {
    vi.spyOn(betaTestMode, 'isBetaTestMode').mockReturnValue(true);

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TestProviders initialSetup={completeSetup}>
          <BetaModeBanner />
        </TestProviders>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="beta-mode-banner"');
    expect(html).toContain('Testmodus');
  });
});
