import type { SyncMeta } from './sync';

export type MailImportSource = 'manual' | 'file_upload' | 'test_data';

export type MailImportStatus = 'pending' | 'importing' | 'processed' | 'failed';

export type MailAttachmentStatus = 'pending' | 'processed' | 'failed';

export interface MailAttachmentImport {
  id: string;
  fileName: string;
  mimeType: string;
  status: MailAttachmentStatus;
  linkedInboxId?: string;
  errorMessage?: string;
}

export interface MailImport {
  id: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  bodyText: string;
  attachments: MailAttachmentImport[];
  status: MailImportStatus;
  source: MailImportSource;
  linkedInboxIds: string[];
  linkedDocumentIds: string[];
  createdAt: string;
  updatedAt: string;
  sync?: SyncMeta;
}

export interface CreateMailImportInput {
  from: string;
  to?: string;
  subject: string;
  bodyText: string;
  receivedAt?: string;
  source?: MailImportSource;
}
