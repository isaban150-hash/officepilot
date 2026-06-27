import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import type { InboxItem, InboxTaskTemplate, UploadDocumentKind } from '../types/models';

const KIND_TEMPLATE_IDS: Record<UploadDocumentKind, string> = {
  auftrag: 'inbox-001',
  zahlungserinnerung: 'inbox-002',
  materialrechnung: 'inbox-003',
  bg_bau: 'inbox-004',
  werbung: 'inbox-005',
  kontoauszug: 'inbox-006',
};

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

function deepCloneTaskTemplate(template?: InboxTaskTemplate): InboxTaskTemplate | undefined {
  return template ? { ...template } : undefined;
}

function cloneTemplateById(templateId: string): Omit<InboxItem, 'id' | 'status' | 'receivedAt'> {
  const source = MOCK_INBOX_ITEMS.find((item) => item.id === templateId);
  if (!source) {
    throw new Error(`Inbox template not found: ${templateId}`);
  }

  const {
    id: _id,
    status: _status,
    receivedAt: _receivedAt,
    isNewUpload: _isNewUpload,
    sourceFileName: _sourceFileName,
    ...rest
  } = source;

  return {
    ...rest,
    digitalFolder: { ...rest.digitalFolder },
    paperFiling: { ...rest.paperFiling },
    recognizedData: { ...rest.recognizedData },
    taskTemplate: deepCloneTaskTemplate(rest.taskTemplate),
  };
}

function pickRandomKind(): UploadDocumentKind {
  const index = Math.floor(Math.random() * UPLOAD_DOCUMENT_KINDS.length);
  return UPLOAD_DOCUMENT_KINDS[index];
}

function buildTitleFromTemplate(templateTitle: string): string {
  return `Gerade erfasst: ${templateTitle}`;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultFileName(): string {
  const stamp = todayIsoDate().replace(/-/g, '');
  return `Dokument_${stamp}.jpg`;
}

export function createMockInboxItemFromUpload(
  options: CreateInboxFromUploadOptions = {},
): InboxItem {
  const kind = options.kind ?? pickRandomKind();
  const templateId = KIND_TEMPLATE_IDS[kind];
  const template = cloneTemplateById(templateId);
  const receivedAt = todayIsoDate();
  const sourceFileName = options.sourceFileName ?? defaultFileName();
  const timestamp = Date.now();

  return {
    ...template,
    id: `inbox-upload-${timestamp}`,
    title: buildTitleFromTemplate(template.title),
    status: 'neu',
    receivedAt,
    sourceFileName,
    isNewUpload: true,
    digitalFolder: {
      ...template.digitalFolder,
      id: `dig-upload-${timestamp}`,
    },
  };
}
