import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentReviewSuccess } from './components/inbox/review/DocumentReviewSuccess';
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
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { t } from './i18n';
import type { DocumentReviewSuccessStepView } from './services/documentReviewViewService';
import * as documentLifecycleService from './services/documentLifecycleService';

const TODAY = '2026-06-27';

const steps: DocumentReviewSuccessStepView[] = [
  { id: 'archived', labelKey: 'reviewWorkflow.success.archived' },
];

function createFreistellungInbox(id = 'inbox-wf01b') {
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

type Mount = { container: HTMLDivElement; root: Root };

function mountSuccess(props: {
  archiveDocumentId?: string;
  vorgangId?: string;
  onOpenArchive?: () => void;
  onOpenVorgang?: () => void;
  onNextDocument?: () => void;
}): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <DocumentReviewSuccess
          steps={steps}
          archiveDocumentId={props.archiveDocumentId}
          vorgangId={props.vorgangId}
          translate={(key) => t(key, 'de')}
          onOpenArchive={props.onOpenArchive}
          onOpenVorgang={props.onOpenVorgang}
          onNextDocument={props.onNextDocument ?? vi.fn()}
        />
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function importArchiveDoc() {
  const result = importInboxDocument(createFreistellungInbox(), 'Test GmbH');
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('import failed');
  return result.document;
}

describe('DOC-WF-01B Post-Intake Next-Step CTA', () => {
  let mounted: Mount | undefined;

  beforeEach(() => {
    resetTestStores();
    resetMemory();
    resetCommunicationHistoryStore();
    hydrateDocumentStore([]);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = undefined;
    }
    vi.restoreAllMocks();
  });

  it('archiveDocumentId + reply_open: Primary „Weiter: Antwort vorbereiten“, Auftrag Secondary', () => {
    const doc = importArchiveDoc();
    recordRemindLater({ type: 'document', id: doc.id }, 'Später');
    expect(resolveDocumentLifecycle({ documentId: doc.id }, TODAY)?.openReasons).toContain(
      'reply_open',
    );

    const onOpenArchive = vi.fn();
    const onOpenVorgang = vi.fn();
    mounted = mountSuccess({
      archiveDocumentId: doc.id,
      vorgangId: 'v-1',
      onOpenArchive,
      onOpenVorgang,
    });

    const reply = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-review-continue-reply"]',
    );
    const order = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-review-open-vorgang"]',
    );
    expect(reply).not.toBeNull();
    expect(reply!.textContent).toContain(t('reviewWorkflow.success.continueReply', 'de'));
    expect(reply!.className).toContain('btn--primary');
    expect(order).not.toBeNull();
    expect(order!.className).toContain('btn--outline');
    expect(mounted.container.querySelectorAll('button.btn--primary')).toHaveLength(1);

    act(() => {
      reply!.click();
    });
    expect(onOpenArchive).toHaveBeenCalledTimes(1);
  });

  it('archiveDocumentId + file_original: Primary „Weiter: Papier abheften“', () => {
    const doc = importArchiveDoc();
    expect(resolveDocumentLifecycle({ documentId: doc.id }, TODAY)?.openReasons).toContain(
      'file_original',
    );
    expect(resolveDocumentLifecycle({ documentId: doc.id }, TODAY)?.openReasons).not.toContain(
      'reply_open',
    );

    const onOpenArchive = vi.fn();
    mounted = mountSuccess({
      archiveDocumentId: doc.id,
      onOpenArchive,
    });

    const filing = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-review-continue-filing"]',
    );
    expect(filing).not.toBeNull();
    expect(filing!.textContent).toContain(t('reviewWorkflow.success.continueFiling', 'de'));
    expect(filing!.className).toContain('btn--primary');
    expect(mounted.container.querySelector('[data-testid="document-review-continue-reply"]')).toBeNull();
    expect(mounted.container.querySelectorAll('button.btn--primary')).toHaveLength(1);
  });

  it('archiveDocumentId + done: keine Reply-/Papier-Primary, neutraler Archiv-Link', () => {
    const doc = importArchiveDoc();
    recordMarkedAnswered({ type: 'document', id: doc.id }, 'ok');
    markDocumentPhysicallyFiled(doc.id);
    expect(resolveDocumentLifecycle({ documentId: doc.id }, TODAY)?.status).toBe('done');

    mounted = mountSuccess({
      archiveDocumentId: doc.id,
      onOpenArchive: vi.fn(),
      vorgangId: 'v-1',
      onOpenVorgang: vi.fn(),
    });

    expect(mounted.container.querySelector('[data-testid="document-review-continue-reply"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="document-review-continue-filing"]')).toBeNull();
    const openArchive = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-review-open-archive"]',
    );
    expect(openArchive).not.toBeNull();
    expect(openArchive!.textContent).toContain(t('reviewWorkflow.success.openArchive', 'de'));
    expect(openArchive!.className).toContain('btn--outline');
  });

  it('archiveDocumentId + Lifecycle null: neutraler CTA ohne Exception', () => {
    vi.spyOn(documentLifecycleService, 'resolveDocumentLifecycle').mockReturnValue(null);

    expect(() => {
      mounted = mountSuccess({
        archiveDocumentId: 'doc-missing-lifecycle',
        onOpenArchive: vi.fn(),
      });
    }).not.toThrow();

    const openArchive = mounted!.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-review-open-archive"]',
    );
    expect(openArchive).not.toBeNull();
    expect(openArchive!.textContent).toContain(t('reviewWorkflow.success.openArchive', 'de'));
    expect(mounted!.container.querySelector('[data-testid="document-review-continue-reply"]')).toBeNull();
    expect(mounted!.container.querySelector('[data-testid="document-review-continue-filing"]')).toBeNull();
  });

  it('kein archiveDocumentId: keine Archiv-CTA, bestehendes Verhalten', () => {
    mounted = mountSuccess({
      vorgangId: 'v-1',
      onOpenVorgang: vi.fn(),
    });

    expect(mounted.container.querySelector('[data-testid="document-review-continue-reply"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="document-review-continue-filing"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="document-review-open-archive"]')).toBeNull();
    const order = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-review-open-vorgang"]',
    );
    expect(order).not.toBeNull();
    expect(order!.className).toContain('btn--primary');
  });

  it('Vorgang zusätzlich: bei Reply/Papier höchstens Secondary', () => {
    const doc = importArchiveDoc();
    mounted = mountSuccess({
      archiveDocumentId: doc.id,
      vorgangId: 'v-2',
      onOpenArchive: vi.fn(),
      onOpenVorgang: vi.fn(),
    });

    const filing = mounted.container.querySelector('[data-testid="document-review-continue-filing"]');
    const order = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-review-open-vorgang"]',
    );
    expect(filing).not.toBeNull();
    expect(order!.className).toContain('btn--outline');
    expect(mounted.container.querySelectorAll('button.btn--primary')).toHaveLength(1);
  });

  it('„Zur Ablage“-Label bei unveränderter Ablage-Route-Callback', () => {
    const onNextDocument = vi.fn();
    mounted = mountSuccess({ onNextDocument });

    const next = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="document-review-next-document"]',
    );
    expect(next).not.toBeNull();
    expect(next!.textContent).toContain(t('reviewWorkflow.success.nextDocument', 'de'));
    expect(t('reviewWorkflow.success.nextDocument', 'de')).toBe('Zur Ablage');
    expect(next!.textContent).not.toContain('Nächstes Dokument');

    act(() => {
      next!.click();
    });
    expect(onNextDocument).toHaveBeenCalledTimes(1);
  });

  it('Regression: Success-Panel ohne Auto-Navigation, Steps sichtbar, keine doppelte Primary', () => {
    const doc = importArchiveDoc();
    const onOpenArchive = vi.fn();
    mounted = mountSuccess({
      archiveDocumentId: doc.id,
      onOpenArchive,
    });

    expect(mounted.container.querySelector('[data-testid="document-review-success"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain(t('reviewWorkflow.success.title', 'de'));
    expect(mounted.container.textContent).toContain(t('reviewWorkflow.success.archived', 'de'));
    expect(onOpenArchive).not.toHaveBeenCalled();
    expect(mounted.container.querySelectorAll('button.btn--primary')).toHaveLength(1);
    expect(mounted.container.querySelectorAll('[data-testid^="document-review-continue-"]')).toHaveLength(
      1,
    );
  });
});
