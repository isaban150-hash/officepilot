import type {
  CreateMailImportInput,
  MailAttachmentImport,
  MailImport,
} from '../types/mailImport';
import type { InboxItem } from '../types/models';
import { extractDocumentText } from './ocrDocumentService';
import { getInboxItemById, processUpload } from './inboxService';
import { importInboxDocument } from './documentService';
import { persistAll } from './persistenceService';
import { generateEntityId, withNewEntitySync } from './sync/syncMetaService';
import {
  getAllMailImportsFromStore,
  getMailImportFromStore,
  resetMailImportStore,
  upsertMailImportInStore,
} from './mailImportStore';

export interface ImportMailResult {
  mailImport: MailImport;
  inboxItems: InboxItem[];
}

function createId(prefix: string): string {
  return generateEntityId(prefix);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function buildMailRecognizedText(input: {
  subject: string;
  from: string;
  bodyText: string;
  attachmentText?: string;
}): string {
  const parts = [
    `Betreff: ${input.subject}`,
    `Von: ${input.from}`,
    '',
    input.bodyText.trim(),
  ];

  if (input.attachmentText?.trim()) {
    parts.push('', '--- Anhang ---', input.attachmentText.trim());
  }

  return parts.join('\n');
}

export function createMailImport(input: CreateMailImportInput): MailImport {
  const timestamp = nowIso();
  const mailImport = withNewEntitySync(
    {
      id: createId('mail'),
      from: input.from.trim(),
      to: input.to?.trim() || '',
      subject: input.subject.trim(),
      receivedAt: input.receivedAt ?? timestamp.slice(0, 10),
      bodyText: input.bodyText.trim(),
      attachments: [],
      status: 'pending' as const,
      source: input.source ?? 'manual',
      linkedInboxIds: [],
      linkedDocumentIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    'mail_import',
  );

  upsertMailImportInStore(mailImport);
  persistAll();
  return mailImport;
}

function createInboxItemFromMail(
  mailImport: MailImport,
  options: {
    sourceFileName: string;
    recognizedText: string;
  },
): InboxItem {
  return processUpload({
    sourceFileName: options.sourceFileName,
    recognizedText: options.recognizedText,
    titleHint: mailImport.subject,
    senderHint: mailImport.from,
    mailImportId: mailImport.id,
    importSource: 'email',
  });
}

function linkInboxToMail(mailImport: MailImport, inboxItem: InboxItem): MailImport {
  const linkedInboxIds = mailImport.linkedInboxIds.includes(inboxItem.id)
    ? mailImport.linkedInboxIds
    : [...mailImport.linkedInboxIds, inboxItem.id];

  return upsertMailImportInStore({
    ...mailImport,
    linkedInboxIds,
    updatedAt: nowIso(),
  });
}

export async function importMailAttachment(
  mailImportId: string,
  file: File,
): Promise<{ mailImport: MailImport; attachment: MailAttachmentImport; inboxItem: InboxItem }> {
  const mailImport = getMailImportById(mailImportId);
  if (!mailImport) {
    throw new Error('MailImport not found');
  }

  const attachmentId = createId('mail-att');
  const pendingAttachment: MailAttachmentImport = {
    id: attachmentId,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    status: 'pending',
  };

  let currentMail = upsertMailImportInStore({
    ...mailImport,
    status: 'importing',
    attachments: [...mailImport.attachments, pendingAttachment],
    updatedAt: nowIso(),
  });

  const extraction = await extractDocumentText(file);
  const recognizedText = buildMailRecognizedText({
    subject: currentMail.subject,
    from: currentMail.from,
    bodyText: currentMail.bodyText,
    attachmentText: extraction.recognizedText,
  });

  const inboxItem = createInboxItemFromMail(currentMail, {
    sourceFileName: file.name,
    recognizedText,
  });

  const processedAttachment: MailAttachmentImport = {
    ...pendingAttachment,
    status: 'processed',
    linkedInboxId: inboxItem.id,
  };

  currentMail = upsertMailImportInStore({
    ...currentMail,
    attachments: currentMail.attachments.map((entry) =>
      entry.id === attachmentId ? processedAttachment : entry,
    ),
    updatedAt: nowIso(),
  });
  currentMail = linkInboxToMail(currentMail, inboxItem);
  currentMail = upsertMailImportInStore({
    ...currentMail,
    status: 'processed',
    updatedAt: nowIso(),
  });

  persistAll();
  return { mailImport: currentMail, attachment: processedAttachment, inboxItem };
}

export function importMailAsInboxItem(mailImportId: string): ImportMailResult {
  const mailImport = getMailImportById(mailImportId);
  if (!mailImport) {
    throw new Error('MailImport not found');
  }

  if (mailImport.linkedInboxIds.length > 0) {
    const inboxItems = mailImport.linkedInboxIds
      .map((id) => getInboxItemById(id))
      .filter((item): item is InboxItem => Boolean(item));
    return { mailImport, inboxItems };
  }

  const recognizedText = buildMailRecognizedText({
    subject: mailImport.subject,
    from: mailImport.from,
    bodyText: mailImport.bodyText,
  });

  const inboxItem = createInboxItemFromMail(mailImport, {
    sourceFileName: `${mailImport.subject.slice(0, 40).replace(/\s+/g, '_') || 'email'}.eml`,
    recognizedText,
  });

  const updatedMail = linkInboxToMail(
    upsertMailImportInStore({
      ...mailImport,
      status: 'processed',
      updatedAt: nowIso(),
    }),
    inboxItem,
  );

  persistAll();
  return { mailImport: updatedMail, inboxItems: [inboxItem] };
}

export function getMailImports(): MailImport[] {
  return getAllMailImportsFromStore();
}

export function getMailImportById(id: string): MailImport | undefined {
  return getMailImportFromStore(id);
}

export function markMailImportProcessed(
  mailImportId: string,
  linkedDocumentIds: string[] = [],
): MailImport | null {
  const mailImport = getMailImportById(mailImportId);
  if (!mailImport) return null;

  const updated = upsertMailImportInStore({
    ...mailImport,
    status: 'processed',
    linkedDocumentIds: [...new Set([...mailImport.linkedDocumentIds, ...linkedDocumentIds])],
    updatedAt: nowIso(),
  });
  persistAll();
  return updated;
}

export function archiveMailInboxItem(
  inboxItem: InboxItem,
  linkedCompany: string,
  mailImportId?: string,
): string | null {
  const result = importInboxDocument(inboxItem, linkedCompany);
  if (!result.success) return null;

  if (mailImportId) {
    const mailImport = getMailImportById(mailImportId);
    if (mailImport) {
      upsertMailImportInStore({
        ...mailImport,
        linkedDocumentIds: [...new Set([...mailImport.linkedDocumentIds, result.document.id])],
        updatedAt: nowIso(),
      });
      persistAll();
    }
  }

  return result.document.id;
}

export function resetMailImports(): void {
  resetMailImportStore();
}

export function getMailImportSnapshot(): MailImport[] {
  return getAllMailImportsFromStore();
}

export function hydrateMailImports(items: MailImport[]): void {
  resetMailImportStore();
  items.forEach((item) => upsertMailImportInStore(item));
}
