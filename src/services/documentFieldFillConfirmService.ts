import type { InboxItem } from '../types/models';
import {
  extractFieldsWithConfidence,
  type ExtractedDocumentFields,
  type FieldConfidenceLevel,
} from './documentFieldExtractionService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import type {
  DocumentFieldFillConfirmFieldKey,
  DocumentFieldFillConfirmRow,
  DocumentFieldFillConfirmViewModel,
} from '../types/documentFieldFillConfirm';

/** Relevant fields shown on the panel (including empty/missing slots). */
export const DOCUMENT_FIELD_FILL_CONFIRM_RELEVANT_KEYS: readonly DocumentFieldFillConfirmFieldKey[] =
  [
    'Absender',
    'Empfänger',
    'Kunde',
    'Datum',
    'Frist',
    'Betrag',
    'Aktenzeichen',
    'Betreff',
    'Baustelle',
    'Rechnungsnummer',
  ];

const FIELD_LABELS: Record<DocumentFieldFillConfirmFieldKey, string> = {
  Absender: 'Absender',
  Empfänger: 'Empfänger',
  Datum: 'Datum',
  Aktenzeichen: 'Aktenzeichen',
  Baustelle: 'Baustelle',
  Kunde: 'Kunde',
  Vorgang: 'Vorgang',
  Rechnungsnummer: 'Rechnungsnummer',
  Betrag: 'Betrag',
  Frist: 'Frist',
  Projekt: 'Projekt',
  Straße: 'Straße',
  Ort: 'Ort',
  Lieferant: 'Lieferant',
  Betreff: 'Betreff',
};

function contextValueForField(
  item: InboxItem,
  fieldKey: DocumentFieldFillConfirmFieldKey,
): string | undefined {
  const fromRecognized = item.recognizedData[fieldKey]?.trim();
  if (fromRecognized && !fromRecognized.startsWith('_')) {
    return fromRecognized;
  }

  switch (fieldKey) {
    case 'Absender':
      return item.sender?.trim() || undefined;
    case 'Frist':
      return item.deadline?.trim() || undefined;
    case 'Betreff':
      return item.title?.trim() || undefined;
    default:
      return undefined;
  }
}

function buildRow(
  fieldKey: DocumentFieldFillConfirmFieldKey,
  proposedValue: string,
  confidence: FieldConfidenceLevel | undefined,
): DocumentFieldFillConfirmRow {
  const trimmed = proposedValue.trim();
  if (!trimmed) {
    return Object.freeze({
      fieldKey,
      label: FIELD_LABELS[fieldKey],
      proposedValue: '',
      status: 'missing' as const,
    });
  }
  return Object.freeze({
    fieldKey,
    label: FIELD_LABELS[fieldKey],
    proposedValue: trimmed,
    ...(confidence ? { confidence } : {}),
    status: 'proposed' as const,
  });
}

/**
 * Build the initial fill-confirm view-model from OCR extraction + inbox page fields.
 * Does not invent values, call AI, or persist.
 */
export function buildDocumentFieldFillConfirmViewModel(
  item: InboxItem,
): DocumentFieldFillConfirmViewModel {
  const text = getInboxExtractedDocumentText(item);
  const extracted = extractFieldsWithConfidence(text);

  const rows: DocumentFieldFillConfirmRow[] = DOCUMENT_FIELD_FILL_CONFIRM_RELEVANT_KEYS.map(
    (fieldKey) => {
      const fromExtraction = extracted[fieldKey as keyof ExtractedDocumentFields];
      if (fromExtraction?.value?.trim()) {
        return buildRow(fieldKey, fromExtraction.value, fromExtraction.confidence);
      }
      const fromContext = contextValueForField(item, fieldKey);
      if (fromContext) {
        return buildRow(fieldKey, fromContext, 'medium');
      }
      return buildRow(fieldKey, '', undefined);
    },
  );

  return Object.freeze({
    rows: Object.freeze(rows),
  });
}

export function getConfirmedFillConfirmValues(
  rows: readonly DocumentFieldFillConfirmRow[],
): Array<{ label: string; value: string }> {
  return rows
    .filter((row) => row.status === 'confirmed' && Boolean(row.confirmedValue?.trim()))
    .map((row) => ({
      label: row.label,
      value: row.confirmedValue!.trim(),
    }));
}

export function formatConfirmedFillConfirmClipboardText(
  rows: readonly DocumentFieldFillConfirmRow[],
): string {
  return getConfirmedFillConfirmValues(rows)
    .map((entry) => `${entry.label}: ${entry.value}`)
    .join('\n');
}
