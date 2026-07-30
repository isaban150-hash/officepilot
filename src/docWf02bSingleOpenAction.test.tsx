import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import {
  recordMarkedAnswered,
  recordRemindLater,
} from './services/communicationHistoryService';
import { resetCommunicationHistoryStore } from './services/communicationHistoryStore';
import { hydrateDocumentStore, importInboxDocument } from './services/documentService';
import { resolveDocumentLifecycle } from './services/documentLifecycleService';
import {
  markDocumentPhysicallyFiled,
  resetMemory,
} from './services/officePilotMemoryService';
import { createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import { hydrateVorgangStore } from './services/vorgangService';
import { resetTestStores } from './test/resetStores';
import type { CompanyDocument } from './types/models';
import { t } from './i18n';

const TODAY = '2026-06-27';

function createFreistellungInbox(id = 'inbox-wf02b-freistellung') {
  return createAuftragInboxItem({
    id,
    title: 'Freistellungsbescheinigung §48b',
    documentType: 'behoerde',
    classifiedKind: 'freistellungsbescheinigung',
    sender: 'Finanzamt München',
    deadline: '2026-12-31',
    recognizedData: {
      Dokument: 'Freistellungsbescheinigung nach §48b EStG',
    },
  });
}

function createDeadlineInbox() {
  return createAuftragInboxItem({
    id: 'inbox-wf02b-deadline',
    title: 'Finanzamt – Fristsetzung',
    documentType: 'behoerde',
    classifiedKind: 'finanzamt',
    sender: 'Finanzamt München',
    deadline: '2026-07-15',
    recognizedData: {
      Dokument: 'Bitte reichen Sie Unterlagen bis zum 15.07.2026 ein.',
    },
  });
}

type Mount = { container: HTMLDivElement; root: Root };

function mountDetail(documentId: string): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[`/dokumente/${documentId}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function importDoc(inbox = createFreistellungInbox()) {
  const result = importInboxDocumentForTests(inbox, 'Test GmbH');
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('import failed');
  return result.document;
}

function experiencePrimaryButtons(container: HTMLElement): HTMLButtonElement[] {
  const experience = container.querySelector('[data-testid="document-detail-experience"]');
  if (!experience) return [];
  return Array.from(experience.querySelectorAll<HTMLButtonElement>('button.btn--primary'));
}

describe('DOC-WF-02B Single Open Action on DokumentDetailPage', () => {
  let mounted: Mount | undefined;

  beforeEach(() => {
    resetTestStores();
    resetMemory();
    resetCommunicationHistoryStore();
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = undefined;
    }
  });

  it('reply_open + file_original: Antwort ist Primary, Papier nicht Primary', () => {
    const doc = importDoc();
    recordRemindLater({ type: 'document', id: doc.id }, 'Später');
    const view = resolveDocumentLifecycle({ documentId: doc.id }, TODAY);
    expect(view?.openReasons).toContain('reply_open');
    expect(view?.openReasons).toContain('file_original');

    mounted = mountDetail(doc.id);

    const reply = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-detail-reply-action"]',
    );
    const filing = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-filing-mark-filed"]',
    );
    expect(reply).not.toBeNull();
    expect(reply!.className).toContain('btn--primary');
    expect(filing).not.toBeNull();
    expect(filing!.className).toContain('btn--outline');
    expect(filing!.className).not.toContain('btn--primary');
    expect(experiencePrimaryButtons(mounted.container)).toHaveLength(1);
    expect(mounted.container.querySelectorAll('[data-testid="document-detail-reply-action"]')).toHaveLength(
      1,
    );
  });

  it('nur reply_open: Antwort ist einzige Primary-Arbeitsaktion', () => {
    const doc = importDoc();
    recordRemindLater({ type: 'document', id: doc.id }, 'Später');
    markDocumentPhysicallyFiled(doc.id);
    const view = resolveDocumentLifecycle({ documentId: doc.id }, TODAY);
    expect(view?.openReasons).toContain('reply_open');
    expect(view?.openReasons).not.toContain('file_original');

    mounted = mountDetail(doc.id);

    expect(mounted.container.querySelector('[data-testid="document-detail-reply-action"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="document-filing-mark-filed"]')).toBeNull();
    expect(experiencePrimaryButtons(mounted.container)).toHaveLength(1);
    expect(
      experiencePrimaryButtons(mounted.container)[0].getAttribute('data-testid'),
    ).toBe('document-detail-reply-action');
  });

  it('nur file_original: Filing ist einzige Primary, kein generisches Nachrichtenschreiben', () => {
    const doc = importDoc();
    const view = resolveDocumentLifecycle({ documentId: doc.id }, TODAY);
    expect(view?.openReasons).toContain('file_original');
    expect(view?.openReasons).not.toContain('reply_open');

    mounted = mountDetail(doc.id);

    expect(mounted.container.querySelector('[data-testid="document-detail-reply-action"]')).toBeNull();
    const filing = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-filing-mark-filed"]',
    );
    expect(filing).not.toBeNull();
    expect(filing!.className).toContain('btn--primary');
    expect(experiencePrimaryButtons(mounted.container)).toHaveLength(0);
  });

  it('done: keine künstliche Primary-Arbeitsaktion, Status bleibt verständlich', () => {
    const doc = importDoc();
    recordMarkedAnswered({ type: 'document', id: doc.id }, 'Erledigt');
    markDocumentPhysicallyFiled(doc.id);
    const view = resolveDocumentLifecycle({ documentId: doc.id }, TODAY);
    expect(view?.status).toBe('done');
    expect(view?.openReasons ?? []).toHaveLength(0);

    mounted = mountDetail(doc.id);

    expect(mounted.container.querySelector('[data-testid="document-detail-reply-action"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="document-filing-mark-filed"]')).toBeNull();
    expect(experiencePrimaryButtons(mounted.container)).toHaveLength(0);
    expect(mounted.container.textContent).toContain(t('document.experience.saved', 'de'));
  });

  it('sonstiger offener Grund: keine Reply-/Filing-Primary, nextStep sichtbar', () => {
    const result = importInboxDocumentForTests(createDeadlineInbox(), 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;
    const doc = result.document;
    markDocumentPhysicallyFiled(doc.id);
    const view = resolveDocumentLifecycle({ documentId: doc.id }, TODAY);
    expect(view?.openReasons).toContain('deadline_open');
    expect(view?.openReasons).not.toContain('reply_open');
    expect(view?.openReasons).not.toContain('file_original');

    mounted = mountDetail(doc.id);

    expect(mounted.container.querySelector('[data-testid="document-detail-reply-action"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="document-filing-mark-filed"]')).toBeNull();
    expect(experiencePrimaryButtons(mounted.container)).toHaveLength(0);
    expect(mounted.container.querySelector('[data-testid="document-detail-next-step"]')?.textContent).toBe(
      view?.nextStep,
    );
  });

  it('Dokument ohne Memory: sicherer Fallback ohne Exception', () => {
    const bare: CompanyDocument = {
      id: 'doc-wf02b-bare',
      title: 'Manuell ohne Memory',
      category: 'sonstiges',
      issuer: 'Test',
      recognizedText: '',
      issueDate: '2026-01-01',
      validUntil: null,
      digitalFolder: { id: 'd', name: 'Sonstiges', path: '/Sonst/' },
      paperFolder: { folderId: '', register: '', label: '' },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    hydrateDocumentStore([bare]);

    expect(() => {
      mounted = mountDetail(bare.id);
    }).not.toThrow();

    expect(mounted!.container.querySelector('[data-testid="document-detail-experience"]')).not.toBeNull();
    // Lifecycle resolves from document alone; without paper folder / reply events typically no forced primary.
    // If lifecycle is null-like empty opens: no reply primary. Filing button absent without paper folder.
    expect(mounted!.container.querySelector('[data-testid="document-filing-mark-filed"]')).toBeNull();
  });

  it('Auftrag verknüpft bleibt Secondary bei offener Hauptaktion', () => {
    const vorgang = createTestVorgang({ id: 'v-wf02b', title: 'Auftrag WF02B' });
    hydrateVorgangStore([vorgang]);
    const doc = importDoc();
    const withLink: CompanyDocument = {
      ...doc,
      linkedVorgang: { vorgangId: vorgang.id, vorgangTitle: vorgang.title },
    };
    hydrateDocumentStore([withLink]);
    recordRemindLater({ type: 'document', id: doc.id }, 'Später');

    mounted = mountDetail(doc.id);

    const order = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-detail-open-order"]',
    );
    const reply = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-detail-reply-action"]',
    );
    expect(order).not.toBeNull();
    expect(order!.className).toContain('btn--outline');
    expect(reply!.className).toContain('btn--primary');
    expect(experiencePrimaryButtons(mounted.container)).toHaveLength(1);
  });

  it('Regression: Filing-Confirm, Kommunikation unter Mehr, FreeQuestion, Understanding, ShowMore', () => {
    const doc = importDoc();
    mounted = mountDetail(doc.id);

    expect(mounted.container.querySelector('[data-testid="document-understanding-card"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="document-free-question-panel"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="document-detail-show-more"]')).not.toBeNull();

    const filing = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-filing-mark-filed"]',
    );
    expect(filing).not.toBeNull();
    act(() => {
      filing!.click();
    });
    expect(mounted.container.querySelector('[data-testid="document-filing-mark-filed"]')).toBeNull();
    expect(resolveDocumentLifecycle({ documentId: doc.id }, TODAY)?.openReasons).not.toContain(
      'file_original',
    );

    act(() => {
      mounted!.container.querySelector<HTMLButtonElement>('[data-testid="show-more-toggle"]')?.click();
    });

    expect(mounted.container.querySelector('[data-testid="dokument-communication"]')).not.toBeNull();
  });

  it('Edit-Modus bleibt unverändert nutzbar', () => {
    const doc = importDoc();
    markDocumentPhysicallyFiled(doc.id);
    recordMarkedAnswered({ type: 'document', id: doc.id }, 'ok');
    mounted = mountDetail(doc.id);

    const showMoreBtn = Array.from(mounted.container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes(t('common.showMore', 'de')),
    );
    expect(showMoreBtn).toBeTruthy();
    act(() => {
      showMoreBtn!.click();
    });
    const editBtn = Array.from(mounted.container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes(t('document.edit', 'de')),
    );
    expect(editBtn).toBeTruthy();
    act(() => {
      editBtn!.click();
    });
    expect(mounted.container.querySelector('form, [data-testid="document-form"]') ?? mounted.container.textContent).toBeTruthy();
    expect(mounted.container.textContent).toContain(t('document.experience.editing', 'de'));
  });
});
