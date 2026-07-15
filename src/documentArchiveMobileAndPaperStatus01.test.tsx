import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DocumentFilingCard } from './components/documents/DocumentFilingCard';
import { DocumentLifecycleCard } from './components/documents/DocumentLifecycleCard';
import { DocumentOriginalFilePanel } from './components/documents/DocumentOriginalFilePanel';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import {
  getDocumentLifecycleStatusLabelKey,
  resolveDocumentLifecycle,
} from './services/documentLifecycleService';
import {
  getDocumentById,
  hydrateDocumentStore,
  importInboxDocument,
  searchDocuments,
} from './services/documentService';
import {
  getDocumentMemoryByDocumentId,
  markDocumentPhysicallyFiled,
  resetMemory,
} from './services/officePilotMemoryService';
import { resetCommunicationHistoryStore } from './services/communicationHistoryStore';
import {
  getDocumentFileRefById,
  getOriginalDocumentFileBytes,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { resetDocumentBlobDatabaseForTests } from './services/storage/documentBlobIndexedDbService';
import { hydrateTaskStore } from './services/taskStore';
import type { InboxItem } from './types/models';

const TODAY = '2026-06-27';
const CSS_PATH = resolve(__dirname, 'styles/document-upload.css');

function createLetterWithDeadline(overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-letter-deadline-paper',
    title: 'Finanzamt – Fristsetzung',
    documentType: 'behoerde',
    classifiedKind: 'finanzamt',
    sender: 'Finanzamt München',
    deadline: '2026-07-10',
    recognizedData: {
      Dokument: 'Bitte reichen Sie Unterlagen bis zum 10.07.2026 ein.',
    },
    ...overrides,
  });
}

function createFreistellung(overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-freistellung-paper',
    title: 'Freistellungsbescheinigung §48b',
    documentType: 'behoerde',
    classifiedKind: 'freistellungsbescheinigung',
    sender: 'Finanzamt München',
    deadline: '2026-12-31',
    recognizedData: {
      Dokument: 'Freistellungsbescheinigung nach §48b EStG',
    },
    ...overrides,
  });
}

describe('DOCUMENT-ARCHIVE-MOBILE-AND-PAPER-STATUS-01', () => {
  beforeEach(() => {
    resetMemory();
    resetCommunicationHistoryStore();
    hydrateDocumentStore([]);
    hydrateTaskStore([]);
  });

  afterEach(async () => {
    resetTestStores();
    resetDocumentFileStoreForTests();
    await resetDocumentBlobDatabaseForTests();
  });

  it('Bildvorschau besitzt mobile Breitenbegrenzung', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    expect(css).toMatch(/\.document-original-file-panel__image\s*\{[^}]*max-width:\s*100%/s);
    expect(css).toMatch(/\.document-original-file-panel__image\s*\{[^}]*height:\s*auto/s);
    expect(css).toMatch(/\.document-original-file-panel__image\s*\{[^}]*display:\s*block/s);
  });

  it('PDF-Vorschau besitzt mobile Breitenbegrenzung', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    expect(css).toMatch(/\.document-original-file-panel__pdf\s*\{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.document-original-file-panel__pdf\s*\{[^}]*max-width:\s*100%/s);
    expect(css).toMatch(/\.document-original-file-panel__pdf\s*\{[^}]*box-sizing:\s*border-box/s);
    expect(css).toMatch(/\.document-original-file-panel__preview\s*\{[^}]*overflow-x:\s*hidden/s);
  });

  it('Originalpanel-Markup enthält Containment-Klassen und Download', async () => {
    const bytes = new TextEncoder().encode('PREVIEW-MOBILE');
    const stored = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'iphone.jpg',
        mimeType: 'image/jpeg',
        fileSize: bytes.byteLength,
        bytes,
      },
      { lifecycleIntent: 'committed' },
    );
    const fileRef = stored.fileRef;

    const host = document.createElement('div');
    host.style.width = '390px';
    host.style.maxWidth = '390px';
    host.style.overflowX = 'auto';
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(
          'div',
          { style: { width: '390px', maxWidth: '390px', overflowX: 'auto' } },
          createElement(DocumentOriginalFilePanel, {
            fileRefId: fileRef.id,
            translate: (key) => t(key, 'de'),
          }),
        ),
      );
    });

    // Allow object-URL hook to resolve blob preview
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.document-original-file-panel')).toBeTruthy();
    expect(host.querySelector('.document-original-file-panel__preview')).toBeTruthy();
    const panel = host.querySelector('.document-original-file-panel') as HTMLElement;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    expect(host.querySelector('[data-testid="document-original-file-panel-download"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('markDocumentPhysicallyFiled verändert nur Papierfelder', async () => {
    const bytes = new TextEncoder().encode('KEEP-BLOB');
    const stored = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'archiv.pdf',
        mimeType: 'application/pdf',
        fileSize: bytes.byteLength,
        bytes,
      },
      { lifecycleIntent: 'committed' },
    );
    const fileRef = stored.fileRef;

    const result = importInboxDocument(createFreistellung({ fileRefId: fileRef.id }), 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const before = getDocumentById(result.document.id)!;
    expect(before.fileRefId).toBe(fileRef.id);

    markDocumentPhysicallyFiled(result.document.id, 'Max Mustermann');

    const after = getDocumentById(result.document.id)!;
    const memory = getDocumentMemoryByDocumentId(result.document.id)!;
    expect(after.fileRefId).toBe(fileRef.id);
    expect(after.id).toBe(before.id);
    expect(memory.physicalFiled).toBe(true);
    expect(memory.filedByUser).toBe('Max Mustermann');
    expect(memory.filedAt).toBeTruthy();
    expect(getDocumentFileRefById(fileRef.id)?.id).toBe(fileRef.id);
    const blob = await getOriginalDocumentFileBytes(fileRef.id);
    expect(blob).toBeTruthy();
    expect(blob!.byteLength).toBe(bytes.byteLength);
    expect(searchDocuments(after.title).some((doc) => doc.id === after.id)).toBe(true);
  });

  it('offene Frist bleibt nach Papierablage offen', () => {
    const result = importInboxDocument(createLetterWithDeadline(), 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;

    markDocumentPhysicallyFiled(result.document.id);
    const view = resolveDocumentLifecycle({ documentId: result.document.id }, TODAY);
    expect(view?.openReasons).toContain('deadline_open');
    expect(view?.openItems).toContain('Frist offen');
    expect(view?.status).toBe('needs_action');
    expect(view?.status).not.toBe('done');
  });

  it('offene Aufgabe bleibt nach Papierablage offen', () => {
    const inbox = createFreistellung({ id: 'inbox-with-task' });
    const result = importInboxDocument(inbox, 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;

    hydrateTaskStore([
      {
        id: 'task-paper-open',
        title: 'Frist prüfen',
        description: 'Unterlagen einreichen',
        status: 'open',
        priority: 'hoch',
        category: 'dokumente',
        linkedInboxId: inbox.id,
        sourceType: 'inbox',
        sourceId: inbox.id,
        taskKind: 'inbox_review',
        dedupeKey: `${inbox.id}:review`,
        autoCreated: false,
        createdAt: '2026-06-01T00:00:00.000Z',
        type: 'dokument_pruefen',
      },
    ]);

    markDocumentPhysicallyFiled(result.document.id);
    const view = resolveDocumentLifecycle({ documentId: result.document.id }, TODAY);
    expect(view?.openReasons).toContain('task_open');
    expect(view?.openItems).toContain('Aufgabe offen');
    expect(view?.status).toBe('needs_action');
  });

  it('UI zeigt Papierstatus getrennt vom digitalen Status', () => {
    const result = importInboxDocument(createFreistellung(), 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;

    markDocumentPhysicallyFiled(result.document.id);

    const filingHtml = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <DocumentFilingCard documentId={result.document.id} />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(filingHtml).toContain(t('document.filing.digitalSaved', 'de'));
    expect(filingHtml).toContain(t('document.filing.statusFiled', 'de'));
    expect(filingHtml).toContain('data-testid="document-filing-paper-status"');

    const lifecycleHtml = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <DocumentLifecycleCard documentId={result.document.id} />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(lifecycleHtml).toContain(t('document.lifecycle.status.paperDoneDigitalRemains', 'de'));
    expect(lifecycleHtml).toContain('Papierablage erledigt – digitales Dokument bleibt im Archiv.');
  });

  it('Status-Keys sind in DE/TR/BG lokalisiert', () => {
    for (const lang of ['de', 'tr', 'bg'] as const) {
      expect(t('document.filing.digitalSaved', lang).length).toBeGreaterThan(0);
      expect(t('document.filing.paperOnlyHint', lang).length).toBeGreaterThan(0);
      expect(t('document.lifecycle.status.paperDoneDigitalRemains', lang).length).toBeGreaterThan(0);
      expect(t('document.lifecycle.status.paperFiled', lang)).not.toBe(
        'document.lifecycle.status.paperFiled',
      );
    }
    expect(t('document.filing.digitalSaved', 'tr')).not.toBe(t('document.filing.digitalSaved', 'de'));
    expect(t('document.filing.digitalSaved', 'bg')).not.toBe(t('document.filing.digitalSaved', 'de'));
  });

  it('getDocumentLifecycleStatusLabelKey unterscheidet Papier-done von generischem done', () => {
    expect(getDocumentLifecycleStatusLabelKey('done')).toBe('document.lifecycle.status.done');
    expect(getDocumentLifecycleStatusLabelKey('done', { physicalFiled: true })).toBe(
      'document.lifecycle.status.paperDoneDigitalRemains',
    );
    expect(getDocumentLifecycleStatusLabelKey('filed')).toBe('document.lifecycle.status.paperFiled');
  });
});
