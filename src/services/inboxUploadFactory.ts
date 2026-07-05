import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import type { DocumentClassificationInput, InboxItem, UploadDocumentKind } from '../types/models';
import {
  classifyInboxItem,
} from './documentClassificationService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';

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
  recognizedText?: string;
  titleHint?: string;
  senderHint?: string;
  mailImportId?: string;
  importSource?: 'scan' | 'upload' | 'email';
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
    recognizedData: {
      ...template.recognizedData,
      Dokumentart: classified.classifiedKind ?? '',
    },
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
  const recognizedText = options.recognizedText?.trim();
  const kind = options.kind ?? (recognizedText ? undefined : pickRandomKind());
  const sourceFileName = options.sourceFileName ?? defaultFileName();

  const input: DocumentClassificationInput = {
    sourceFileName,
    kindHint: kind,
    recognizedText,
    titleHint: options.titleHint,
    senderHint: options.senderHint,
  };

  let item = classifyInboxItem(input);

  if (kind) {
    item = enrichFromTemplate(item, kind);
  }

  if (recognizedText) {
    item = {
      ...item,
      recognizedData: withInboxExtractedDocumentText(item.recognizedData, recognizedText),
    };
  }

  if (options.titleHint) {
    item = {
      ...item,
      title: options.titleHint,
      recognizedData: {
        ...item.recognizedData,
        Betreff: options.titleHint,
      },
    };
  }

  if (options.senderHint) {
    item = {
      ...item,
      sender: options.senderHint,
    };
  }

  if (options.mailImportId || options.importSource) {
    item = {
      ...item,
      mailImportId: options.mailImportId,
      importSource: options.importSource,
    };
  }

  return item;
}
