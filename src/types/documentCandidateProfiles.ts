import type { ClassifiedDocumentKind } from './models';
import type { DocumentZone } from './documentAnalysis';
import type { DocumentFeatureStrength } from './documentFeatures';

export type CandidateFeatureRule = {
  featureId: string;
  weight: number;
  required?: boolean;
  zones?: DocumentZone[];
  minStrength?: DocumentFeatureStrength;
};

export type ReceiptCandidateProfile = {
  kind: ClassifiedDocumentKind;
  family: string;
  positive: CandidateFeatureRule[];
  negative: CandidateFeatureRule[];
  structural: CandidateFeatureRule[];
};

export const RECEIPT_CANDIDATE_PROFILES: ReceiptCandidateProfile[] = [
  {
    kind: 'tankbeleg',
    family: 'eingangsrechnung',
    structural: [
      { featureId: 'structure.receipt_layout', weight: 3, zones: ['body', 'header'], required: true },
    ],
    positive: [
      {
        featureId: 'structure.fuel_marker',
        weight: 4,
        zones: ['body', 'header'],
        minStrength: 'medium',
        required: true,
      },
      { featureId: 'amount.monetary_value', weight: 2.5, zones: ['body', 'header'], required: true },
      { featureId: 'payment.card_payment', weight: 1.5, zones: ['body', 'header'] },
      { featureId: 'date.document_date', weight: 0.8, zones: ['body', 'header'] },
    ],
    negative: [
      { featureId: 'reference.invoice_number', weight: 2.5, zones: ['body', 'header'] },
      { featureId: 'structure.payment_request', weight: 2, zones: ['body'] },
      { featureId: 'payment.iban', weight: 1.5, zones: ['body', 'footer'] },
      { featureId: 'structure.authority_letter', weight: 2, zones: ['header', 'body'] },
    ],
  },
  {
    kind: 'ec_beleg',
    family: 'eingangsrechnung',
    structural: [
      { featureId: 'structure.receipt_layout', weight: 2.5, zones: ['body'] },
    ],
    positive: [
      {
        featureId: 'structure.ec_marker',
        weight: 4,
        zones: ['body', 'header'],
        required: true,
      },
      { featureId: 'payment.card_payment', weight: 3, zones: ['body', 'header'], minStrength: 'medium' },
      { featureId: 'amount.monetary_value', weight: 2.5, zones: ['body'], required: true },
      { featureId: 'date.document_date', weight: 0.8, zones: ['body', 'header'] },
    ],
    negative: [
      { featureId: 'structure.kreditkarten_marker', weight: 4, zones: ['body', 'header'] },
      { featureId: 'structure.fuel_marker', weight: 2, zones: ['body', 'header'] },
      { featureId: 'reference.invoice_number', weight: 2.5, zones: ['body', 'header'] },
      { featureId: 'structure.payment_request', weight: 2, zones: ['body'] },
      { featureId: 'payment.iban', weight: 2, zones: ['body', 'footer'] },
      { featureId: 'register.hrb_hra_number', weight: 1, zones: ['footer'] },
    ],
  },
  {
    kind: 'kreditkartenbeleg',
    family: 'eingangsrechnung',
    structural: [
      { featureId: 'structure.receipt_layout', weight: 2, zones: ['body'] },
    ],
    positive: [
      {
        featureId: 'structure.kreditkarten_marker',
        weight: 4,
        zones: ['body', 'header'],
        required: true,
      },
      { featureId: 'amount.monetary_value', weight: 2.5, zones: ['body'], required: true },
      { featureId: 'payment.card_payment', weight: 2, zones: ['body', 'header'] },
      { featureId: 'date.document_date', weight: 0.8, zones: ['body', 'header'] },
    ],
    negative: [
      { featureId: 'structure.ec_marker', weight: 4, zones: ['body', 'header'] },
      { featureId: 'structure.fuel_marker', weight: 2, zones: ['body', 'header'] },
      { featureId: 'reference.invoice_number', weight: 2.5, zones: ['body', 'header'] },
      { featureId: 'payment.iban', weight: 2, zones: ['body', 'footer'] },
      { featureId: 'structure.quittung_marker', weight: 3, zones: ['body', 'header'] },
      { featureId: 'register.hrb_hra_number', weight: 1, zones: ['footer'] },
    ],
  },
  {
    kind: 'kassenbeleg',
    family: 'eingangsrechnung',
    structural: [
      { featureId: 'structure.receipt_layout', weight: 3, zones: ['body'] },
    ],
    positive: [
      { featureId: 'amount.monetary_value', weight: 3, zones: ['body'] },
      { featureId: 'date.document_date', weight: 0.8, zones: ['body', 'header'] },
    ],
    negative: [
      { featureId: 'payment.card_payment', weight: 1, zones: ['body'] },
      { featureId: 'structure.fuel_marker', weight: 2.5, zones: ['body', 'header'] },
      { featureId: 'reference.invoice_number', weight: 2, zones: ['body', 'header'] },
      { featureId: 'register.hrb_hra_number', weight: 1, zones: ['footer'] },
    ],
  },
  {
    kind: 'quittung',
    family: 'eingangsrechnung',
    structural: [
      { featureId: 'structure.receipt_layout', weight: 2, zones: ['body'] },
    ],
    positive: [
      {
        featureId: 'structure.quittung_marker',
        weight: 4,
        zones: ['body', 'header'],
        required: true,
      },
      { featureId: 'amount.labeled_total', weight: 2.5, zones: ['body', 'header', 'footer'], required: true },
      { featureId: 'amount.monetary_value', weight: 2, zones: ['body'] },
      { featureId: 'date.document_date', weight: 0.8, zones: ['body', 'header'] },
    ],
    negative: [
      { featureId: 'payment.card_payment', weight: 2.5, zones: ['body', 'header'] },
      { featureId: 'structure.kreditkarten_marker', weight: 3, zones: ['body', 'header'] },
      { featureId: 'structure.ec_marker', weight: 3, zones: ['body', 'header'] },
      { featureId: 'structure.fuel_marker', weight: 1.5, zones: ['body', 'header'] },
      { featureId: 'reference.invoice_number', weight: 3, zones: ['body', 'header'] },
      { featureId: 'payment.iban', weight: 2.5, zones: ['body', 'footer'] },
      { featureId: 'register.hrb_hra_number', weight: 1, zones: ['footer'] },
    ],
  },
  {
    kind: 'handelsregister',
    family: 'behoerde',
    structural: [],
    positive: [
      { featureId: 'register.hrb_hra_number', weight: 3, zones: ['footer', 'body', 'header'] },
      { featureId: 'register.court_marker', weight: 2.5, zones: ['footer', 'body', 'header'] },
      { featureId: 'register.managing_director_marker', weight: 2, zones: ['footer', 'body', 'header'] },
    ],
    negative: [
      { featureId: 'structure.receipt_layout', weight: 4, zones: ['body'] },
      { featureId: 'amount.monetary_value', weight: 2.5, zones: ['body'] },
      { featureId: 'structure.fuel_marker', weight: 3, zones: ['body', 'header'] },
      { featureId: 'payment.card_payment', weight: 2.5, zones: ['body', 'header'] },
    ],
  },
  {
    kind: 'finanzamt',
    family: 'behoerde',
    structural: [
      {
        featureId: 'structure.authority_letter',
        weight: 3,
        zones: ['header', 'body'],
        required: true,
      },
    ],
    positive: [
      {
        featureId: 'structure.finanzamt_marker',
        weight: 4,
        zones: ['header', 'body'],
        required: true,
      },
      { featureId: 'date.deadline_date', weight: 2.5, zones: ['body', 'header', 'footer'] },
      { featureId: 'reference.case_reference', weight: 2, zones: ['body', 'header'] },
    ],
    negative: [
      { featureId: 'structure.payment_request', weight: 3.5, zones: ['body', 'header'] },
      { featureId: 'structure.mahnung_marker', weight: 3, zones: ['body', 'header'] },
      { featureId: 'structure.zahlungserinnerung_marker', weight: 3, zones: ['body', 'header'] },
      { featureId: 'structure.receipt_layout', weight: 3, zones: ['body'] },
      { featureId: 'reference.invoice_number', weight: 2.5, zones: ['body', 'header'] },
      { featureId: 'payment.card_payment', weight: 2, zones: ['body'] },
      { featureId: 'structure.steuerbescheid_marker', weight: 2.5, zones: ['body', 'header'] },
      { featureId: 'structure.bg_bau_marker', weight: 2.5, zones: ['body', 'header'] },
    ],
  },
  {
    kind: 'bg_bau',
    family: 'behoerde',
    structural: [
      {
        featureId: 'structure.authority_letter',
        weight: 3,
        zones: ['header', 'body'],
        required: true,
      },
    ],
    positive: [
      {
        featureId: 'structure.bg_bau_marker',
        weight: 5,
        zones: ['header', 'body'],
        required: true,
      },
      { featureId: 'date.deadline_date', weight: 2.5, zones: ['body', 'header', 'footer'] },
      { featureId: 'reference.case_reference', weight: 2, zones: ['body', 'header'] },
      { featureId: 'amount.labeled_total', weight: 1.5, zones: ['body'] },
    ],
    negative: [
      { featureId: 'structure.payment_request', weight: 3.5, zones: ['body', 'header'] },
      { featureId: 'structure.mahnung_marker', weight: 3, zones: ['body', 'header'] },
      { featureId: 'structure.receipt_layout', weight: 3, zones: ['body'] },
      { featureId: 'reference.invoice_number', weight: 2.5, zones: ['body', 'header'] },
      { featureId: 'payment.card_payment', weight: 2, zones: ['body'] },
      { featureId: 'structure.finanzamt_marker', weight: 2, zones: ['body', 'header'] },
      { featureId: 'structure.steuerbescheid_marker', weight: 2, zones: ['body', 'header'] },
    ],
  },
  {
    kind: 'steuerbescheid',
    family: 'behoerde',
    structural: [
      {
        featureId: 'structure.authority_letter',
        weight: 3,
        zones: ['header', 'body'],
        required: true,
      },
    ],
    positive: [
      {
        featureId: 'structure.steuerbescheid_marker',
        weight: 5,
        zones: ['header', 'body'],
        required: true,
      },
      { featureId: 'date.deadline_date', weight: 2.5, zones: ['body', 'header', 'footer'] },
      { featureId: 'reference.case_reference', weight: 2, zones: ['body', 'header'] },
    ],
    negative: [
      { featureId: 'structure.payment_request', weight: 3.5, zones: ['body', 'header'] },
      { featureId: 'structure.mahnung_marker', weight: 3, zones: ['body', 'header'] },
      { featureId: 'structure.receipt_layout', weight: 3, zones: ['body'] },
      { featureId: 'reference.invoice_number', weight: 2.5, zones: ['body', 'header'] },
      { featureId: 'payment.card_payment', weight: 2, zones: ['body'] },
      { featureId: 'structure.bg_bau_marker', weight: 3, zones: ['body', 'header'] },
    ],
  },
  {
    kind: 'eingangsrechnung',
    family: 'eingangsrechnung',
    structural: [],
    positive: [
      {
        featureId: 'reference.invoice_number',
        weight: 3.5,
        zones: ['body', 'header'],
        minStrength: 'medium',
        required: true,
      },
      { featureId: 'amount.labeled_total', weight: 2.5, zones: ['body'] },
      { featureId: 'amount.monetary_value', weight: 1.5, zones: ['body'] },
      { featureId: 'payment.iban', weight: 1.5, zones: ['body', 'footer'] },
      { featureId: 'date.deadline_date', weight: 1.5, zones: ['body'] },
    ],
    negative: [
      { featureId: 'structure.payment_request', weight: 3, zones: ['body', 'header'] },
      { featureId: 'structure.mahnung_marker', weight: 4, zones: ['body', 'header'] },
      { featureId: 'structure.zahlungserinnerung_marker', weight: 4, zones: ['body', 'header'] },
      { featureId: 'structure.receipt_layout', weight: 3, zones: ['body'] },
      { featureId: 'structure.fuel_marker', weight: 2.5, zones: ['body', 'header'] },
      { featureId: 'payment.card_payment', weight: 1.5, zones: ['body'] },
    ],
  },
  {
    kind: 'mahnung',
    family: 'zahlung',
    structural: [],
    positive: [
      {
        featureId: 'structure.payment_request',
        weight: 3.5,
        zones: ['body', 'header'],
        required: true,
      },
      {
        featureId: 'structure.mahnung_marker',
        weight: 4,
        zones: ['body', 'header'],
      },
      { featureId: 'date.deadline_date', weight: 2.5, zones: ['body'] },
      { featureId: 'amount.monetary_value', weight: 2.5, zones: ['body'] },
      { featureId: 'reference.invoice_number', weight: 1.5, zones: ['body', 'header'] },
    ],
    negative: [
      { featureId: 'amount.labeled_total', weight: 2.5, zones: ['body'] },
      { featureId: 'payment.iban', weight: 2, zones: ['body', 'footer'] },
      { featureId: 'structure.zahlungserinnerung_marker', weight: 5, zones: ['body', 'header'] },
      { featureId: 'structure.receipt_layout', weight: 3, zones: ['body'] },
      { featureId: 'payment.card_payment', weight: 2, zones: ['body'] },
    ],
  },
  {
    kind: 'zahlungserinnerung',
    family: 'zahlung',
    structural: [],
    positive: [
      {
        featureId: 'structure.payment_request',
        weight: 3.5,
        zones: ['body', 'header'],
        required: true,
      },
      {
        featureId: 'structure.zahlungserinnerung_marker',
        weight: 6,
        zones: ['body', 'header'],
      },
      { featureId: 'date.deadline_date', weight: 2.5, zones: ['body'] },
      { featureId: 'amount.monetary_value', weight: 2.5, zones: ['body'] },
      { featureId: 'reference.invoice_number', weight: 1.5, zones: ['body', 'header'] },
    ],
    negative: [
      { featureId: 'amount.labeled_total', weight: 2, zones: ['body'] },
      { featureId: 'structure.mahnung_marker', weight: 3, zones: ['body', 'header'] },
      { featureId: 'structure.receipt_layout', weight: 3, zones: ['body'] },
      { featureId: 'payment.card_payment', weight: 2, zones: ['body'] },
      { featureId: 'reference.invoice_number', weight: 1, zones: ['body', 'header'] },
    ],
  },
  {
    kind: 'sonstiges',
    family: 'sonstiges',
    structural: [],
    positive: [],
    negative: [],
  },
];
