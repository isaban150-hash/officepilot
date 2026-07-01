import type { InboxItem } from '../types/models';

export function getInboxExtractedDocumentText(item: InboxItem): string {
  return (
    item.recognizedData._extractedText ??
    item.recognizedData._vertragstext ??
    item.recognizedData.Vertragstext ??
    ''
  ).trim();
}

export function withInboxExtractedDocumentText(
  recognizedData: Record<string, string>,
  extractedText: string,
): Record<string, string> {
  const trimmed = extractedText.trim();
  if (!trimmed) {
    return recognizedData;
  }

  return {
    ...recognizedData,
    _extractedText: trimmed,
    _vertragstext: trimmed,
  };
}
