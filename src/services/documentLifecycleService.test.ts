import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { resetCommunicationHistoryStore } from './communicationHistoryStore';
import {
  recordMarkedAnswered,
  recordMarkedNoReplyNeeded,
} from './communicationHistoryService';
import {
  getOpenDocumentLifecycleItems,
  resolveDocumentLifecycle,
  scanDocumentLifecyclePending,
} from './documentLifecycleService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';
import { hydrateDocumentStore, importInboxDocument } from './documentService';
import {
  markDocumentPhysicallyFiled,
  resetMemory,
  syncContractProofRequirementsFromInbox,
} from './officePilotMemoryService';
import { createAuftragInboxItem } from '../test/fixtures';
import type { InboxItem } from '../types/models';

const TODAY = '2026-06-27';

function createFreistellungInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-freistellung',
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

function createLetterWithDeadlineInboxItem(): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-letter-deadline',
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

function createWerkvertragInboxItem(vorgangId: string): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-werkvertrag',
    title: 'Werkvertrag Müller Bau',
    documentType: 'kundenauftrag',
    classifiedKind: 'werkvertrag',
    vorgangId,
    vorgangTitle: 'Projekt Müller',
    vorgangLinkStatus: 'linked',
    recognizedData: withInboxExtractedDocumentText({}, SAMPLE_WERKVERTRAG_TEXT),
  });
}

function createAdvertisementInboxItem(): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-ad',
    title: 'Sommer-Aktion Newsletter',
    documentType: 'sonstiges',
    classifiedKind: 'sonstiges',
    sender: 'Werbung GmbH Newsletter',
    isAdvertisement: true,
    recognizedData: {
      Dokument: 'Jetzt 20% Rabatt auf alle Prospekte',
    },
  });
}

describe('documentLifecycleService', () => {
  beforeEach(() => {
    resetMemory();
    resetCommunicationHistoryStore();
    hydrateDocumentStore([]);
  });

  it('Brief mit Frist → needs_action', () => {
    const result = importInboxDocument(createLetterWithDeadlineInboxItem(), 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const view = resolveDocumentLifecycle({ documentId: result.document.id }, TODAY);
    expect(view?.status).toBe('needs_action');
    expect(view?.openReasons).toContain('deadline_open');
    expect(view?.openItems).toContain('Frist offen');
  });

  it('Antwort erledigt → answered oder done', () => {
    const result = importInboxDocument(createFreistellungInboxItem(), 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;

    recordMarkedAnswered({ type: 'document', id: result.document.id }, 'Brief beantworten');

    const answered = resolveDocumentLifecycle({ documentId: result.document.id }, TODAY);
    expect(answered?.status).toBe('answered');
    expect(answered?.openReasons).not.toContain('reply_open');
    expect(answered?.openReasons).toContain('file_original');

    markDocumentPhysicallyFiled(result.document.id);
    const done = resolveDocumentLifecycle({ documentId: result.document.id }, TODAY);
    expect(done?.status).toBe('done');
    expect(done?.openItems).toHaveLength(0);
  });

  it('Original nicht abgeheftet → Ablage offen', () => {
    const result = importInboxDocument(createFreistellungInboxItem(), 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const view = resolveDocumentLifecycle({ documentId: result.document.id }, TODAY);
    expect(view?.status).toBe('needs_action');
    expect(view?.openReasons).toContain('file_original');
    expect(view?.openItems).toContain('Original noch abheften');
  });

  it('Original abgeheftet → done', () => {
    const result = importInboxDocument(createFreistellungInboxItem(), 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;

    markDocumentPhysicallyFiled(result.document.id);
    const view = resolveDocumentLifecycle({ documentId: result.document.id }, TODAY);
    expect(view?.status).toBe('done');
    expect(view?.openItems).toHaveLength(0);
  });

  it('Werbung → done', () => {
    const result = importInboxDocument(createAdvertisementInboxItem(), 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;

    recordMarkedNoReplyNeeded({ type: 'document', id: result.document.id }, 'Werbung');

    const view = resolveDocumentLifecycle({ documentId: result.document.id }, TODAY);
    expect(view?.status).toBe('done');
    expect(view?.openItems).toHaveLength(0);
    expect(view?.nextStep).toContain('Kein weiterer Schritt');
  });

  it('Werkvertrag mit fehlenden Nachweisen → needs_action', () => {
    const werkvertrag = createWerkvertragInboxItem('v-lifecycle-1');
    syncContractProofRequirementsFromInbox(werkvertrag);
    const result = importInboxDocument(werkvertrag, 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const view = resolveDocumentLifecycle({ documentId: result.document.id }, TODAY);
    expect(view?.status).toBe('needs_action');
    expect(view?.openReasons).toContain('proof_missing');
    expect(view?.openItems).toContain('Nachweis fehlt');
  });

  it('Heute zeigt offene Dokumente', () => {
    importInboxDocument(createFreistellungInboxItem({ id: 'inbox-heute-1' }), 'Test GmbH');
    importInboxDocument(createLetterWithDeadlineInboxItem(), 'Test GmbH');

    const openItems = getOpenDocumentLifecycleItems(TODAY);
    expect(openItems.length).toBeGreaterThanOrEqual(2);

    const pending = scanDocumentLifecyclePending(TODAY);
    expect(pending.some((item) => item.kind === 'document_lifecycle_filing')).toBe(true);
    expect(pending.some((item) => item.kind === 'document_lifecycle_deadline')).toBe(true);
    expect(pending.every((item) => item.route.startsWith('/dokumente/'))).toBe(true);
  });
});
