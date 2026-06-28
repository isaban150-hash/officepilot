import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import type { DocumentClassificationInput, InboxItem, UploadDocumentKind } from '../types/models';
import {
  classifyInboxItem,
} from './documentClassificationService';

export const UPLOAD_DOCUMENT_KINDS: UploadDocumentKind[] = [
  'auftrag',
  'zahlungserinnerung',
  'materialrechnung',
  'bg_bau',
  'werbung',
  'kontoauszug',
];

export const UPLOAD_KIND_LABELS: Record<UploadDocumentKind, string> = {
  auftrag: 'Auftrag',
  zahlungserinnerung: 'Zahlungserinnerung',
  materialrechnung: 'Materialrechnung',
  bg_bau: 'BG BAU Schreiben',
  werbung: 'Werbung',
  kontoauszug: 'Kontoauszug',
};

export interface CreateInboxFromUploadOptions {
  sourceFileName?: string;
  kind?: UploadDocumentKind;
}

function pickRandomKind(): UploadDocumentKind {
  const index = Math.floor(Math.random() * UPLOAD_DOCUMENT_KINDS.length);
  return UPLOAD_DOCUMENT_KINDS[index];
}

function defaultFileName(): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `Dokument_${stamp}.jpg`;
}

function enrichFromTemplate(
  classified: InboxItem,
  kind: UploadDocumentKind,
): InboxItem {
  const templateIdMap: Record<UploadDocumentKind, string> = {
    auftrag: 'inbox-001',
    zahlungserinnerung: 'inbox-002',
    materialrechnung: 'inbox-003',
    bg_bau: 'inbox-004',
    werbung: 'inbox-005',
    kontoauszug: 'inbox-006',
  };

  const template = MOCK_INBOX_ITEMS.find((item) => item.id === templateIdMap[kind]);
  if (!template) return classified;

  return {
    ...classified,
    recognizedData: { ...template.recognizedData, Dokumentart: classified.classifiedKind ?? '' },
    taskTemplate: template.taskTemplate ? { ...template.taskTemplate } : classified.taskTemplate,
    vorgangId: template.vorgangId ?? classified.vorgangId,
    vorgangTitle: template.vorgangTitle ?? classified.vorgangTitle,
    securityHint: template.securityHint,
    classifiedKind: classified.classifiedKind,
  };
}

export function createMockInboxItemFromUpload(
  options: CreateInboxFromUploadOptions = {},
): InboxItem {
  const kind = options.kind ?? pickRandomKind();
  const sourceFileName = options.sourceFileName ?? defaultFileName();

  const input: DocumentClassificationInput = {
    sourceFileName,
    kindHint: kind,
  };

  const classified = classifyInboxItem(input);
  return enrichFromTemplate(classified, kind);
}
