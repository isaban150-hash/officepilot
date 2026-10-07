import type { InboxItem } from '../types/models';
import { resolveMainDocumentFromRecognizedData } from './document/mainDocumentPageScope';

/**
 * Der Text, den Klassifikation, Kern, Felder, Einschätzung und Aufgaben lesen.
 *
 * EINGANG-02A-3 — ist an einem institutionellen Schreiben eine Fremdanlage
 * sicher abgegrenzt, ist das nur der Text der Hauptseiten. Gespeichert bleibt
 * alles: `_extractedText` und `_pageTexts` werden nicht verändert.
 */
export function getInboxExtractedDocumentText(
  item: InboxItem,
  /** CLOUD-SYNC S4 — Nacharbeit 1: ausdrückliche Firmenidentität; ohne sie gilt das aktuelle Firmenprofil. */
  options: { ownCompanyName?: string } = {},
): string {
  const haupt = resolveMainDocumentFromRecognizedData(item.recognizedData, options).text;
  if (haupt) return haupt;
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
