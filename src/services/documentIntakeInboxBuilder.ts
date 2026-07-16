import type { DocumentClassificationResult, InboxItem } from '../types/models';
import { buildInboxItemFromClassification } from './documentClassificationService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';
import type { CreateInboxFromUploadOptions } from './inboxUploadFactory';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';

export interface BuildInboxForDocumentIntakeOptions extends CreateInboxFromUploadOptions {
  /**
   * Preview classification from processDocumentFileForPreview.
   * When set, save path skips heavy re-classification (no pageTexts pipeline).
   */
  previewClassification?: DocumentClassificationResult;
  recognizedText?: string;
}

/**
 * Build inbox item for permanent save without running multi-page BOQ/contract analysis.
 * Preview classification is preferred; otherwise light classify without pageTexts.
 */
export function buildInboxItemForDocumentIntake(
  options: BuildInboxForDocumentIntakeOptions,
): InboxItem {
  const recognizedText = options.recognizedText?.trim();
  const sourceFileName = options.sourceFileName;

  if (options.previewClassification) {
    const timestamp = Date.now();
    const base = buildInboxItemFromClassification(options.previewClassification, {
      sourceFileName,
      prefixTitle: true,
    });

    let item: InboxItem = {
      ...base,
      id: `inbox-upload-${timestamp}`,
      status: 'neu',
      receivedAt: new Date().toISOString().slice(0, 10),
      isNewUpload: true,
      digitalFolder: {
        ...base.digitalFolder,
        id: `dig-upload-${timestamp}`,
      },
    };

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
      item = { ...item, sender: options.senderHint };
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

  // Light fallback: never pass pageTexts into classification during save.
  return createMockInboxItemFromUpload({
    sourceFileName: options.sourceFileName,
    kind: options.kind,
    recognizedText,
    titleHint: options.titleHint,
    senderHint: options.senderHint,
    mailImportId: options.mailImportId,
    importSource: options.importSource,
  });
}
