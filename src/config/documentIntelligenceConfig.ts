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

export type InvoiceCutoverKind = 'eingangsrechnung';

export type InvoiceCutoverKindThresholds = {
  minConfidence: number;
  minMargin: number;
};

export const INVOICE_SCORING_CUTOVER = {
  enabled: true,
  allowedKinds: ['eingangsrechnung'],
  minOcrScore: 0.65,
  minEvidenceRefs: 3,
  kindThresholds: {
    eingangsrechnung: { minConfidence: 0.85, minMargin: 0.20 },
  },
} as const satisfies {
  enabled: boolean;
  allowedKinds: readonly InvoiceCutoverKind[];
  minOcrScore: number;
  minEvidenceRefs: number;
  kindThresholds: Record<InvoiceCutoverKind, InvoiceCutoverKindThresholds>;
};

export const DI_INVOICE_SCORING_REASON_KEY = 'classification.detect.diInvoiceScoring';

export type PaymentCutoverKind = 'mahnung' | 'zahlungserinnerung';

export type PaymentCutoverKindThresholds = {
  minConfidence: number;
  minMargin: number;
};

export const PAYMENT_SCORING_CUTOVER = {
  enabled: true,
  allowedKinds: ['mahnung', 'zahlungserinnerung'],
  minOcrScore: 0.65,
  minEvidenceRefs: 3,
  kindThresholds: {
    mahnung: { minConfidence: 0.85, minMargin: 0.18 },
    zahlungserinnerung: { minConfidence: 0.74, minMargin: 0.18 },
  },
} as const satisfies {
  enabled: boolean;
  allowedKinds: readonly PaymentCutoverKind[];
  minOcrScore: number;
  minEvidenceRefs: number;
  kindThresholds: Record<PaymentCutoverKind, PaymentCutoverKindThresholds>;
};

export const DI_PAYMENT_SCORING_REASON_KEY = 'classification.detect.diPaymentScoring';

export type AuthorityCutoverKind = 'finanzamt' | 'bg_bau' | 'steuerbescheid';

export type AuthorityCutoverKindThresholds = {
  minConfidence: number;
  minMargin: number;
};

export const AUTHORITY_SCORING_CUTOVER = {
  enabled: true,
  allowedKinds: ['finanzamt', 'bg_bau', 'steuerbescheid'],
  minOcrScore: 0.65,
  minEvidenceRefs: 3,
  kindThresholds: {
    finanzamt: { minConfidence: 0.85, minMargin: 0.18 },
    bg_bau: { minConfidence: 0.85, minMargin: 0.18 },
    steuerbescheid: { minConfidence: 0.80, minMargin: 0.18 },
  },
} as const satisfies {
  enabled: boolean;
  allowedKinds: readonly AuthorityCutoverKind[];
  minOcrScore: number;
  minEvidenceRefs: number;
  kindThresholds: Record<AuthorityCutoverKind, AuthorityCutoverKindThresholds>;
};

export const DI_AUTHORITY_SCORING_REASON_KEY = 'classification.detect.diAuthorityScoring';

const INVOICE_KIND_TEXT_GUARD = /rechnungsnummer|eingangsrechnung|invoice|rechnung/i;
const MAHNUNG_EXCLUSION_GUARD = /mahnung|zahlungserinnerung|zahlungsaufforderung|inkasso/i;
const AUTHORITY_INVOICE_EXCLUSION_GUARD =
  /\brechnungsnummer\b|\beingangsrechnung\b|\bgesamtbetrag\b|\brechnungssumme\b/i;
const AUTHORITY_CONTRACT_EXCLUSION_GUARD =
  /\bwerkvertrag\b|\bsubunternehmer(?:vertrag)?\b|\bleistungsverzeichnis\b|\bbau-?subunternehmer\b|\bunternehmervertrag\b/i;

const AUTHORITY_KIND_TEXT_GUARDS: Record<AuthorityCutoverKind, RegExp> = {
  finanzamt: /finanzamt|steuernummer|umsatzsteuer|lohnsteuer|steueramt/i,
  bg_bau:
    /beitragsbescheid|berufsgenossenschaft\s+(der\s+)?bauwirtschaft|bg[\s-]?bau[\s\S]{0,160}beitragsbescheid/i,
  steuerbescheid: /steuerbescheid|festsetzung|einkommensteuerbescheid/i,
};

export function hasAuthorityCutoverKindTextGuard(
  kind: ClassifiedDocumentKind,
  recognizedText: string,
): boolean {
  if (!isAuthorityScoringCutoverKind(kind)) {
    return false;
  }
  return AUTHORITY_KIND_TEXT_GUARDS[kind].test(recognizedText);
}

export function hasAuthorityCutoverPaymentExclusion(recognizedText: string): boolean {
  return MAHNUNG_EXCLUSION_GUARD.test(recognizedText);
}

export function hasAuthorityCutoverInvoiceExclusion(recognizedText: string): boolean {
  if (!AUTHORITY_INVOICE_EXCLUSION_GUARD.test(recognizedText)) {
    return false;
  }
  return !/(finanzamt|steuerbescheid|bg[\s-]?bau|beitragsbescheid|festsetzung)/i.test(recognizedText);
}

export function hasAuthorityCutoverContractExclusion(recognizedText: string): boolean {
  return AUTHORITY_CONTRACT_EXCLUSION_GUARD.test(recognizedText);
}

const PAYMENT_KIND_TEXT_GUARDS: Record<PaymentCutoverKind, RegExp> = {
  mahnung: /mahnung|inkasso|zahlungsaufforderung/i,
  zahlungserinnerung: /zahlungserinnerung/i,
};

export function hasPaymentCutoverKindTextGuard(
  kind: ClassifiedDocumentKind,
  recognizedText: string,
): boolean {
  if (!isPaymentScoringCutoverKind(kind)) {
    return false;
  }
  return PAYMENT_KIND_TEXT_GUARDS[kind].test(recognizedText);
}

export function hasInvoiceCutoverKindTextGuard(recognizedText: string): boolean {
  return INVOICE_KIND_TEXT_GUARD.test(recognizedText);
}

export function hasInvoiceCutoverMahnungExclusion(recognizedText: string): boolean {
  return MAHNUNG_EXCLUSION_GUARD.test(recognizedText);
}

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

let invoiceCutoverEnabledOverride: boolean | null = null;

export function getInvoiceScoringCutoverEnabled(): boolean {
  if (invoiceCutoverEnabledOverride !== null) {
    return invoiceCutoverEnabledOverride;
  }
  return INVOICE_SCORING_CUTOVER.enabled;
}

export function setInvoiceScoringCutoverEnabledForTests(value: boolean | null): void {
  invoiceCutoverEnabledOverride = value;
}

export function isInvoiceScoringCutoverKind(
  kind: ClassifiedDocumentKind,
): kind is InvoiceCutoverKind {
  return INVOICE_SCORING_CUTOVER.allowedKinds.includes(kind as InvoiceCutoverKind);
}

export function getInvoiceCutoverKindThresholds(
  kind: ClassifiedDocumentKind,
): InvoiceCutoverKindThresholds | null {
  if (!isInvoiceScoringCutoverKind(kind)) {
    return null;
  }
  return INVOICE_SCORING_CUTOVER.kindThresholds[kind];
}

let paymentCutoverEnabledOverride: boolean | null = null;

export function getPaymentScoringCutoverEnabled(): boolean {
  if (paymentCutoverEnabledOverride !== null) {
    return paymentCutoverEnabledOverride;
  }
  return PAYMENT_SCORING_CUTOVER.enabled;
}

export function setPaymentScoringCutoverEnabledForTests(value: boolean | null): void {
  paymentCutoverEnabledOverride = value;
}

export function isPaymentScoringCutoverKind(
  kind: ClassifiedDocumentKind,
): kind is PaymentCutoverKind {
  return PAYMENT_SCORING_CUTOVER.allowedKinds.includes(kind as PaymentCutoverKind);
}

export function getPaymentCutoverKindThresholds(
  kind: ClassifiedDocumentKind,
): PaymentCutoverKindThresholds | null {
  if (!isPaymentScoringCutoverKind(kind)) {
    return null;
  }
  return PAYMENT_SCORING_CUTOVER.kindThresholds[kind];
}

let authorityCutoverEnabledOverride: boolean | null = null;

export function getAuthorityScoringCutoverEnabled(): boolean {
  if (authorityCutoverEnabledOverride !== null) {
    return authorityCutoverEnabledOverride;
  }
  return AUTHORITY_SCORING_CUTOVER.enabled;
}

export function setAuthorityScoringCutoverEnabledForTests(value: boolean | null): void {
  authorityCutoverEnabledOverride = value;
}

export function isAuthorityScoringCutoverKind(
  kind: ClassifiedDocumentKind,
): kind is AuthorityCutoverKind {
  return AUTHORITY_SCORING_CUTOVER.allowedKinds.includes(kind as AuthorityCutoverKind);
}

export function getAuthorityCutoverKindThresholds(
  kind: ClassifiedDocumentKind,
): AuthorityCutoverKindThresholds | null {
  if (!isAuthorityScoringCutoverKind(kind)) {
    return null;
  }
  return AUTHORITY_SCORING_CUTOVER.kindThresholds[kind];
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

export type OcrOnlyRecognizedDataKind =
  | ReceiptCutoverKind
  | 'eingangsrechnung'
  | PaymentCutoverKind
  | AuthorityCutoverKind;

export const OCR_ONLY_RECOGNIZED_DATA = {
  enabled: true,
  kinds: [
    'tankbeleg',
    'ec_beleg',
    'kassenbeleg',
    'eingangsrechnung',
    'mahnung',
    'zahlungserinnerung',
    'finanzamt',
    'bg_bau',
    'steuerbescheid',
  ],
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
