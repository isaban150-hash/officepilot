import type { ClassifiedDocumentKind } from '../types/models';

export type ReceiptCutoverKind = 'tankbeleg' | 'ec_beleg' | 'kassenbeleg' | 'kreditkartenbeleg' | 'quittung';

export type ReceiptCutoverKindThresholds = {
  minConfidence: number;
  minMargin: number;
};

export const RECEIPT_SCORING_CUTOVER = {
  enabled: true,
  allowedKinds: ['tankbeleg', 'ec_beleg', 'kassenbeleg', 'kreditkartenbeleg', 'quittung'],
  minOcrScore: 0.60,
  minEvidenceRefs: 2,
  kindThresholds: {
    tankbeleg: { minConfidence: 0.85, minMargin: 0.25 },
    ec_beleg: { minConfidence: 0.85, minMargin: 0.12 },
    kassenbeleg: { minConfidence: 0.80, minMargin: 0.12 },
    kreditkartenbeleg: { minConfidence: 0.85, minMargin: 0.12 },
    quittung: { minConfidence: 0.80, minMargin: 0.12 },
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

export type CertificateCutoverKind = 'freistellungsbescheinigung' | 'unbedenklichkeitsbescheinigung';

export type CertificateCutoverKindThresholds = {
  minConfidence: number;
  minMargin: number;
};

export const CERTIFICATE_SCORING_CUTOVER = {
  enabled: true,
  allowedKinds: ['freistellungsbescheinigung', 'unbedenklichkeitsbescheinigung'],
  minOcrScore: 0.65,
  minEvidenceRefs: 2,
  kindThresholds: {
    freistellungsbescheinigung: { minConfidence: 0.85, minMargin: 0.18 },
    unbedenklichkeitsbescheinigung: { minConfidence: 0.85, minMargin: 0.18 },
  },
} as const satisfies {
  enabled: boolean;
  allowedKinds: readonly CertificateCutoverKind[];
  minOcrScore: number;
  minEvidenceRefs: number;
  kindThresholds: Record<CertificateCutoverKind, CertificateCutoverKindThresholds>;
};

export const DI_CERTIFICATE_SCORING_REASON_KEY = 'classification.detect.diCertificateScoring';

export type ContractCutoverKind = 'werkvertrag' | 'subunternehmervertrag' | 'nachunternehmervertrag';

export type ContractCutoverKindThresholds = {
  minConfidence: number;
  minMargin: number;
};

export const CONTRACT_SCORING_CUTOVER = {
  enabled: true,
  allowedKinds: ['werkvertrag', 'subunternehmervertrag', 'nachunternehmervertrag'],
  minOcrScore: 0.65,
  minEvidenceRefs: 3,
  kindThresholds: {
    werkvertrag: { minConfidence: 0.85, minMargin: 0.03 },
    subunternehmervertrag: { minConfidence: 0.85, minMargin: 0.10 },
    nachunternehmervertrag: { minConfidence: 0.85, minMargin: 0.10 },
  },
} as const satisfies {
  enabled: boolean;
  allowedKinds: readonly ContractCutoverKind[];
  minOcrScore: number;
  minEvidenceRefs: number;
  kindThresholds: Record<ContractCutoverKind, ContractCutoverKindThresholds>;
};

export const DI_CONTRACT_SCORING_REASON_KEY = 'classification.detect.diContractScoring';

const CONTRACT_DOMINANT_MARKER =
  /\b(werkvertrag|werk[\s-]?vertrag|subunternehmervertrag|subunternehmer[\s-]?vertrag|nachunternehmervertrag|nachunternehmer[\s-]?vertrag|bau-?subunternehmer|leistungsverzeichnis|bauvorhaben|baustellenadresse)\b/i;

const CERTIFICATE_DOCUMENT_MARKER =
  /freistellungsbescheinigung|§48b|§48\s*b|unbedenklichkeitsbescheinigung/i;
const AUTHORITY_DOMINANT_FOR_CERTIFICATE_EXCLUSION =
  /beitragsbescheid|steuerbescheid|festsetzung|umsatzsteuervoranmeldung|lohnsteuer-anmeldung/i;
const CERTIFICATE_CONTRACT_EXCLUSION_GUARD =
  /\bwerkvertrag\b|\bsubunternehmer(?:vertrag)?\b|\bleistungsverzeichnis\b|\bbau-?subunternehmer\b|\bunternehmervertrag\b/i;
const CERTIFICATE_RECEIPT_EXCLUSION_GUARD =
  /\btankbeleg\b|\btankstelle\b|\bkassenbeleg\b|\bkassenbon\b|\bec-beleg\b|\bec beleg\b/i;

const CERTIFICATE_KIND_TEXT_GUARDS: Record<CertificateCutoverKind, RegExp> = {
  freistellungsbescheinigung: /freistellungsbescheinigung|§48b|§48\s*b/i,
  unbedenklichkeitsbescheinigung: /unbedenklichkeitsbescheinigung|\bunbedenklichkeit\b/i,
};

export function hasAuthorityCutoverCertificateExclusion(recognizedText: string): boolean {
  if (!CERTIFICATE_DOCUMENT_MARKER.test(recognizedText)) {
    return false;
  }
  return !AUTHORITY_DOMINANT_FOR_CERTIFICATE_EXCLUSION.test(recognizedText);
}

export function hasCertificateCutoverKindTextGuard(
  kind: ClassifiedDocumentKind,
  recognizedText: string,
): boolean {
  if (!isCertificateScoringCutoverKind(kind)) {
    return false;
  }
  return CERTIFICATE_KIND_TEXT_GUARDS[kind].test(recognizedText);
}

export function hasCertificateCutoverPaymentExclusion(recognizedText: string): boolean {
  return MAHNUNG_EXCLUSION_GUARD.test(recognizedText);
}

export function hasCertificateCutoverContractExclusion(recognizedText: string): boolean {
  return CERTIFICATE_CONTRACT_EXCLUSION_GUARD.test(recognizedText);
}

export function hasCertificateCutoverReceiptExclusion(recognizedText: string): boolean {
  if (CERTIFICATE_DOCUMENT_MARKER.test(recognizedText)) {
    return false;
  }
  return CERTIFICATE_RECEIPT_EXCLUSION_GUARD.test(recognizedText);
}

export function hasCertificateCutoverAuthorityExclusion(recognizedText: string): boolean {
  return AUTHORITY_DOMINANT_FOR_CERTIFICATE_EXCLUSION.test(recognizedText);
}

export function hasCertificateCutoverInvoiceExclusion(recognizedText: string): boolean {
  return AUTHORITY_INVOICE_EXCLUSION_GUARD.test(recognizedText);
}

const CONTRACT_KIND_TEXT_GUARDS: Record<ContractCutoverKind, RegExp> = {
  werkvertrag: /\bwerkvertrag\b|\bwerk[\s-]?vertrag\b/i,
  subunternehmervertrag:
    /\bsubunternehmervertrag\b|\bsubunternehmer[\s-]?vertrag\b|\bbau-?subunternehmer\b/i,
  nachunternehmervertrag: /\bnachunternehmervertrag\b|\bnachunternehmer[\s-]?vertrag\b/i,
};

export function hasContractCutoverKindTextGuard(
  kind: ClassifiedDocumentKind,
  recognizedText: string,
): boolean {
  if (!isContractScoringCutoverKind(kind)) {
    return false;
  }
  return CONTRACT_KIND_TEXT_GUARDS[kind].test(recognizedText);
}

export function hasContractCutoverPaymentExclusion(recognizedText: string): boolean {
  return MAHNUNG_EXCLUSION_GUARD.test(recognizedText);
}

export function hasContractCutoverInvoiceExclusion(recognizedText: string): boolean {
  if (!AUTHORITY_INVOICE_EXCLUSION_GUARD.test(recognizedText)) {
    return false;
  }
  return !CONTRACT_DOMINANT_MARKER.test(recognizedText);
}

export function hasContractCutoverReceiptExclusion(recognizedText: string): boolean {
  if (CONTRACT_DOMINANT_MARKER.test(recognizedText)) {
    return false;
  }
  return CERTIFICATE_RECEIPT_EXCLUSION_GUARD.test(recognizedText);
}

export function hasContractCutoverCertificateExclusion(recognizedText: string): boolean {
  if (!CERTIFICATE_DOCUMENT_MARKER.test(recognizedText)) {
    return false;
  }
  return !CONTRACT_DOMINANT_MARKER.test(recognizedText);
}

export function hasContractCutoverAuthorityExclusion(recognizedText: string): boolean {
  if (!AUTHORITY_DOMINANT_FOR_CERTIFICATE_EXCLUSION.test(recognizedText)) {
    return false;
  }
  return !CONTRACT_DOMINANT_MARKER.test(recognizedText);
}

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

let certificateCutoverEnabledOverride: boolean | null = null;

export function getCertificateScoringCutoverEnabled(): boolean {
  if (certificateCutoverEnabledOverride !== null) {
    return certificateCutoverEnabledOverride;
  }
  return CERTIFICATE_SCORING_CUTOVER.enabled;
}

export function setCertificateScoringCutoverEnabledForTests(value: boolean | null): void {
  certificateCutoverEnabledOverride = value;
}

export function isCertificateScoringCutoverKind(
  kind: ClassifiedDocumentKind,
): kind is CertificateCutoverKind {
  return CERTIFICATE_SCORING_CUTOVER.allowedKinds.includes(kind as CertificateCutoverKind);
}

export function getCertificateCutoverKindThresholds(
  kind: ClassifiedDocumentKind,
): CertificateCutoverKindThresholds | null {
  if (!isCertificateScoringCutoverKind(kind)) {
    return null;
  }
  return CERTIFICATE_SCORING_CUTOVER.kindThresholds[kind];
}

let contractCutoverEnabledOverride: boolean | null = null;

export function getContractScoringCutoverEnabled(): boolean {
  if (contractCutoverEnabledOverride !== null) {
    return contractCutoverEnabledOverride;
  }
  return CONTRACT_SCORING_CUTOVER.enabled;
}

export function setContractScoringCutoverEnabledForTests(value: boolean | null): void {
  contractCutoverEnabledOverride = value;
}

export function isContractScoringCutoverKind(
  kind: ClassifiedDocumentKind,
): kind is ContractCutoverKind {
  return CONTRACT_SCORING_CUTOVER.allowedKinds.includes(kind as ContractCutoverKind);
}

export function getContractCutoverKindThresholds(
  kind: ClassifiedDocumentKind,
): ContractCutoverKindThresholds | null {
  if (!isContractScoringCutoverKind(kind)) {
    return null;
  }
  return CONTRACT_SCORING_CUTOVER.kindThresholds[kind];
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
  ec_beleg: /ec-beleg|ec beleg|girocard|ec-cash|ec\s+zahlung/i,
  kassenbeleg: /kassenbeleg|kassenbon/i,
  kreditkartenbeleg: /kreditkartenbeleg|visa|mastercard|contactless|\bkreditkarte\b/i,
  quittung: /quittung|bar erhalten|quittung über/i,
};

const RECEIPT_INVOICE_EXCLUSION_GUARD =
  /\brechnungsnummer\b|\brechnungs(?:nr\.?)\b|\binvoice(?:\s*no\.?)?\b/i;
const RECEIPT_IBAN_PATTERN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\s?[A-Z0-9]{1,4}\b/i;

export function hasReceiptCutoverPaymentExclusion(recognizedText: string): boolean {
  return MAHNUNG_EXCLUSION_GUARD.test(recognizedText);
}

export function hasReceiptCutoverInvoiceExclusion(recognizedText: string): boolean {
  return RECEIPT_INVOICE_EXCLUSION_GUARD.test(recognizedText) && RECEIPT_IBAN_PATTERN.test(recognizedText);
}

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
  | AuthorityCutoverKind
  | CertificateCutoverKind
  | ContractCutoverKind;

export const OCR_ONLY_RECOGNIZED_DATA = {
  enabled: true,
  kinds: [
    'tankbeleg',
    'ec_beleg',
    'kassenbeleg',
    'kreditkartenbeleg',
    'quittung',
    'eingangsrechnung',
    'mahnung',
    'zahlungserinnerung',
    'finanzamt',
    'bg_bau',
    'steuerbescheid',
    'freistellungsbescheinigung',
    'unbedenklichkeitsbescheinigung',
    'werkvertrag',
    'subunternehmervertrag',
    'nachunternehmervertrag',
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
