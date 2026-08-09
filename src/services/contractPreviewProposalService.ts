import { analyzeContractIntelligenceFromText, buildContractOrderProposal } from './contractIntelligenceService';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import type { PendingDocumentIntake } from './pendingDocumentIntakeService';

export function resolvePendingDocumentContractProposal(
  pendingDocument: PendingDocumentIntake | null | undefined,
) {
  if (!pendingDocument) return null;

  const intelligence = analyzeContractIntelligenceFromText(
    pendingDocument.extraction.recognizedText,
    pendingDocument.extraction.pageTexts,
  );

  if (!intelligence) return null;

  const inboxItem = createMockInboxItemFromUpload({
    sourceFileName: pendingDocument.cachedFile.fileName,
    recognizedText: pendingDocument.extraction.recognizedText,
  });

  return buildContractOrderProposal(inboxItem, intelligence);
}
