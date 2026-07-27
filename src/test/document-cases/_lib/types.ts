/**
 * Fachliches Soll für Document-Cases (Stable-Pipeline).
 * Kein Dump von WorkflowResult — nur betriebliche Erwartungen.
 */

export type DocumentCaseChannel = 'upload' | 'scan' | 'email' | 'photo' | 'pdf';

export type DocumentCaseCoarseKind =
  | 'contract'
  | 'invoice'
  | 'letter'
  | 'form'
  | 'delivery_note'
  | 'message'
  | 'authority'
  | 'insurance'
  | 'banking'
  | 'uncertain';

export type DocumentCasePrimaryCase =
  | 'possible_new_order'
  | 'invoice_received'
  | 'overhead_expense'
  | 'authority_obligation'
  | 'insurance_matter'
  | 'payment_disruption'
  | 'customer_inquiry'
  | 'information_only'
  | 'review_required';

export type DocumentCaseMeaning =
  | 'information'
  | 'action_required'
  | 'money'
  | 'deadline'
  | 'obligation'
  | 'evidence'
  | 'risk'
  | 'communication'
  | 'vorgang_change';

export type DocumentCaseForbidden =
  | 'auto_create_order'
  | 'auto_payment'
  | 'auto_send_message'
  | 'silent_plan_change'
  | 'contract_effect_on_invoice'
  | 'performance_plan_on_non_performance_family'
  | 'authority_creates_boq'
  | 'hotel_creates_customer_order'
  | 'termination_as_payment_due'
  | 'invented_parties'
  | 'invented_money'
  | 'invoice_invented_from_letter';

export type DocumentCaseDeadlineKind =
  | 'payment_due'
  | 'response_due'
  | 'document_submission_due'
  | 'service_due'
  | 'termination_notice';

export interface DocumentCaseScenario {
  caseId: string;
  /** Schaden, den dieser Fall verhindert. */
  damagePrevented: string;
  category:
    | 'contracts'
    | 'invoices'
    | 'authorities'
    | 'insurance'
    | 'banking'
    | 'communication'
    | 'uncertain';
  layers: Array<'stable-pipeline' | 'persistence-smoke'>;
  channel: DocumentCaseChannel;
  /** Optional: OCR aus bestehender Fixture statt Dateiinhalt. */
  textFixture?: 'werkvertragMultiSection';
  importSource?: 'scan' | 'upload' | 'email';
  titleHint?: string;
  senderHint?: string;
  kindHint?: string;
  markedAsCompanyDocument?: boolean;
  tags?: string[];
}

export interface DocumentCaseExpected {
  damagePrevented: string;
  ingress: {
    channel: DocumentCaseChannel;
    sourceKind?: string;
  };
  document: {
    coarseKind: DocumentCaseCoarseKind;
    fineKindAllowed?: string[];
    recognition?: 'certain' | 'uncertain';
  };
  businessCase: {
    primaryCase: DocumentCasePrimaryCase;
    /** Erlaubte BI-Ereignisse (Dokumentart ≠ Geschäftsfall). */
    biEventAllowed: string[];
    alternatives?: string[];
    vorgangRef?: 'none' | 'none_or_suggested' | 'linked';
  };
  actors?: {
    senderContains?: string[];
    counterpartyContains?: string[];
    ownCompanyContains?: string[];
    rolePairsForbiddenSwap?: Array<{ aContains: string; bContains: string }>;
    forbidInventedParties?: boolean;
  };
  meaning: DocumentCaseMeaning[];
  money?: {
    required: boolean;
    amountApprox?: number;
    currency?: string | null;
    kindsAllowed?: string[];
    forbidAmount?: boolean;
  };
  deadlines?: {
    allowedKinds?: DocumentCaseDeadlineKind[];
    forbidKinds?: DocumentCaseDeadlineKind[];
    /** Wenn true: timeline.deadline darf nicht nur aus Kündigungsfrist stammen. */
    forbidTerminationAsDeadline?: boolean;
  };
  decisions?: string[];
  forbidden: DocumentCaseForbidden[];
  positions?: {
    minCount?: number;
    maxCount?: number;
    mustInclude?: Array<{
      descriptionContains: string;
      quantity?: number;
      unitAliases?: string[];
    }>;
  };
  classifiedKindAllowed?: string[];
  knownGaps: string[];
}

export interface LoadedDocumentCase {
  caseId: string;
  dir: string;
  scenario: DocumentCaseScenario;
  expected: DocumentCaseExpected;
  ocrText: string;
  pages?: Array<{ pageNumber: number; text: string }>;
  notes?: string;
}
