import type { ClassifiedDocumentKind } from '../types/models';

export type ReceiptCutoverKind = 'tankbeleg' | 'ec_beleg' | 'kassenbeleg';

export type ReceiptCutoverKindThresholds = {
  minConfidence: number;
  minMargin: number;
};

export const RECEIPT_SCORING_CUTOVER = {
  enabled: true,
  allowedKinds: ['tankbeleg', 'ec_beleg', 'kassenbeleg'],
  minOcrScore: 0.60,
  minEvidenceRefs: 2,
  kindThresholds: {
    tankbeleg: { minConfidence: 0.85, minMargin: 0.25 },
    ec_beleg: { minConfidence: 0.85, minMargin: 0.12 },
    kassenbeleg: { minConfidence: 0.80, minMargin: 0.12 },
  },
} as const satisfies {
  enabled: boolean;
  allowedKinds: readonly ReceiptCutoverKind[];
  minOcrScore: number;
  minEvidenceRefs: number;
  kindThresholds: Record<ReceiptCutoverKind, ReceiptCutoverKindThresholds>;
};

export const DI_RECEIPT_SCORING_REASON_KEY = 'classification.detect.diReceiptScoring';

let cutoverEnabledOverride: boolean | null = null;

export function getReceiptScoringCutoverEnabled(): boolean {
  if (cutoverEnabledOverride !== null) {
    return cutoverEnabledOverride;
  }
  return RECEIPT_SCORING_CUTOVER.enabled;
}

export function setReceiptScoringCutoverEnabledForTests(value: boolean | null): void {
  cutoverEnabledOverride = value;
}

export function isReceiptScoringCutoverKind(
  kind: ClassifiedDocumentKind,
): kind is ReceiptCutoverKind {
  return RECEIPT_SCORING_CUTOVER.allowedKinds.includes(kind as ReceiptCutoverKind);
}

export function getReceiptCutoverKindThresholds(
  kind: ClassifiedDocumentKind,
): ReceiptCutoverKindThresholds | null {
  if (!isReceiptScoringCutoverKind(kind)) {
    return null;
  }
  return RECEIPT_SCORING_CUTOVER.kindThresholds[kind];
}

const RECEIPT_KIND_TEXT_GUARDS: Record<ReceiptCutoverKind, RegExp> = {
  tankbeleg: /tankbeleg|tankstelle|kraftstoff|diesel|benzin|super|e10|adblue/i,
  ec_beleg: /ec-beleg|ec beleg|kartenzahlung|girocard|ec-cash|ec\s+zahlung/i,
  kassenbeleg: /kassenbeleg|kassenbon/i,
};

export function hasReceiptCutoverKindTextGuard(
  kind: ClassifiedDocumentKind,
  recognizedText: string,
): boolean {
  if (!isReceiptScoringCutoverKind(kind)) {
    return false;
  }
  return RECEIPT_KIND_TEXT_GUARDS[kind].test(recognizedText);
}

export type OcrOnlyRecognizedDataKind = ReceiptCutoverKind | 'eingangsrechnung';

export const OCR_ONLY_RECOGNIZED_DATA = {
  enabled: true,
  kinds: ['tankbeleg', 'ec_beleg', 'kassenbeleg', 'eingangsrechnung'],
} as const satisfies {
  enabled: boolean;
  kinds: readonly OcrOnlyRecognizedDataKind[];
};

let ocrOnlyRecognizedDataOverride: boolean | null = null;

export function getOcrOnlyRecognizedDataEnabled(): boolean {
  if (ocrOnlyRecognizedDataOverride !== null) {
    return ocrOnlyRecognizedDataOverride;
  }
  return OCR_ONLY_RECOGNIZED_DATA.enabled;
}

export function setOcrOnlyRecognizedDataEnabledForTests(value: boolean | null): void {
  ocrOnlyRecognizedDataOverride = value;
}

export function isOcrOnlyRecognizedDataKind(
  kind: ClassifiedDocumentKind,
): kind is OcrOnlyRecognizedDataKind {
  return OCR_ONLY_RECOGNIZED_DATA.kinds.includes(kind as OcrOnlyRecognizedDataKind);
}
