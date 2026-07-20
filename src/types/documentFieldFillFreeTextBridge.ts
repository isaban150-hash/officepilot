import type { DocumentFieldFillConfirmFieldKey } from './documentFieldFillConfirm';

/** First-sprint scope for free-text → fill-confirm proposals. */
export const DOCUMENT_FIELD_FILL_FREETEXT_BRIDGE_KEYS = [
  'Rechnungsnummer',
  'Betrag',
  'Frist',
  'Datum',
  'Absender',
] as const;

export type DocumentFieldFillFreeTextBridgeFieldKey =
  (typeof DOCUMENT_FIELD_FILL_FREETEXT_BRIDGE_KEYS)[number];

export type DocumentFieldFillFreeTextBridgeParseResult =
  | { readonly kind: 'question' }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' }
  | {
      readonly kind: 'field_statement';
      readonly fieldKey: DocumentFieldFillFreeTextBridgeFieldKey;
      readonly value: string;
    };

/**
 * Session-only proposal from free text into the fill-confirm panel.
 * Never persisted. `id` forces re-application on repeated submits.
 */
export interface DocumentFieldFillFreeTextBridgeProposal {
  readonly id: number;
  readonly fieldKey: DocumentFieldFillConfirmFieldKey;
  readonly value: string;
}
