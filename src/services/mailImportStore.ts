import type { MailImport } from '../types/mailImport';

function cloneMailImport(item: MailImport): MailImport {
  return {
    ...item,
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    linkedInboxIds: [...item.linkedInboxIds],
    linkedDocumentIds: [...item.linkedDocumentIds],
  };
}

let mailImports: MailImport[] = [];

export function getMailImportStoreSnapshot(): MailImport[] {
  return mailImports.map(cloneMailImport);
}

export function hydrateMailImportStore(items: MailImport[]): void {
  mailImports = items.map(cloneMailImport);
}

export function resetMailImportStore(): void {
  mailImports = [];
}

export function setMailImportStoreForTests(items: MailImport[]): void {
  mailImports = items.map(cloneMailImport);
}

export function upsertMailImportInStore(item: MailImport): MailImport {
  const index = mailImports.findIndex((entry) => entry.id === item.id);
  if (index === -1) {
    mailImports = [cloneMailImport(item), ...mailImports];
  } else {
    mailImports = [
      ...mailImports.slice(0, index),
      cloneMailImport(item),
      ...mailImports.slice(index + 1),
    ];
  }
  return cloneMailImport(item);
}

export function getMailImportFromStore(id: string): MailImport | undefined {
  const item = mailImports.find((entry) => entry.id === id);
  return item ? cloneMailImport(item) : undefined;
}

export function getAllMailImportsFromStore(): MailImport[] {
  return mailImports.map(cloneMailImport);
}
