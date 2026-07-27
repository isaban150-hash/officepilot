/**
 * BUSINESS-MEANING-CORE-01 — shared operational reading inside Business Interpretation.
 * No domain specialists; no persistence; no execution.
 */
import type {
  BusinessConfirmationId,
  BusinessDeadlineType,
  BusinessEventType,
  BusinessFactCertainty,
  BusinessInterpretationConfirmation,
  BusinessMeaningKind,
  BusinessOperationalReading,
  BusinessPrimaryCase,
  BusinessStructuredFacts,
} from '../types/businessInterpretation';
import type { ClassifiedDocumentKind, InboxItem, WorkflowResult } from '../types/models';

type WorkflowCore = Omit<WorkflowResult, 'businessInterpretation'>;

const AUTHORITY_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'finanzamt',
  'bg_bau',
  'soka_bau',
  'berufsgenossenschaft',
  'handwerkskammer',
  'ihk',
  'gewerbeamt',
  'bauamt',
  'ordnungsamt',
  'agentur_fuer_arbeit',
  'deutsche_rentenversicherung',
  'zoll',
  'krankenkasse',
  'aok',
  'barmer',
  'tk',
  'dak',
  'ikk',
  'knappschaft',
  'pflegekasse',
]);

const INSURANCE_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'versicherung',
  'versicherungsbescheid',
  'fahrzeugversicherung',
  'rechtsschutzversicherung',
  'gebaeudeversicherung',
  'betriebshaftpflicht',
]);

const BANK_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set(['kontoauszug']);

export function isAuthorityClassifiedKind(kind: ClassifiedDocumentKind): boolean {
  return AUTHORITY_KINDS.has(kind);
}

export function isInsuranceClassifiedKind(kind: ClassifiedDocumentKind): boolean {
  return INSURANCE_KINDS.has(kind);
}

export function isBankClassifiedKind(kind: ClassifiedDocumentKind): boolean {
  return BANK_KINDS.has(kind);
}

function collectCorpus(item: InboxItem, workflow: WorkflowCore): string {
  const parts = [
    item.title,
    item.sender,
    item.recognizedData._extractedText,
    item.recognizedData._vertragstext,
    item.recognizedData.Betreff,
    workflow.documentUnderstanding?.documentType,
    workflow.documentUnderstanding?.sender,
    workflow.classification?.title,
    workflow.classification?.sender,
    workflow.classification?.explanation,
  ];
  return parts.filter(Boolean).join('\n').toLowerCase();
}

function pushUnique(list: BusinessMeaningKind[], value: BusinessMeaningKind): void {
  if (!list.includes(value)) list.push(value);
}

function hasDeadlineSignal(item: InboxItem, workflow: WorkflowCore, facts: BusinessStructuredFacts): boolean {
  return Boolean(
    facts.timeline.deadline ||
      workflow.documentUnderstanding?.deadline ||
      workflow.classification?.deadline ||
      item.deadline ||
      item.recognizedData.Faelligkeit ||
      item.recognizedData.Frist,
  );
}

function hasMoneySignal(workflow: WorkflowCore, facts: BusinessStructuredFacts): boolean {
  if (facts.money.length > 0) return true;
  return Boolean(
    workflow.documentUnderstanding?.amount ||
      workflow.classification?.recognizedData?.Betrag ||
      workflow.contractOrderProposal?.contractTotalNet,
  );
}

function mapEventToPrimary(eventType: BusinessEventType): BusinessPrimaryCase {
  switch (eventType) {
    case 'possible_new_business_case':
      return 'possible_new_order';
    case 'contract_proposed':
      return 'contract_proposed';
    case 'business_case_update':
      return 'business_case_update';
    case 'order_confirmed':
      return 'order_confirmed';
    case 'service_change_proposed':
      return 'service_change_proposed';
    case 'invoice_received':
      return 'invoice_received';
    case 'invoice_created':
      return 'invoice_created';
    case 'payment_reminder_received':
      return 'payment_reminder_received';
    case 'delivery_recorded':
      return 'delivery_recorded';
    case 'acceptance_recorded':
      return 'acceptance_recorded';
    case 'complaint_received':
      return 'complaint_received';
    case 'evidence_added':
      return 'evidence_added';
    case 'information_only':
      return 'information_only';
    case 'deadline_or_obligation_detected':
      return 'deadline_or_obligation_detected';
    case 'review_required':
    default:
      return 'review_required';
  }
}

function confirmHint(
  confirmations: BusinessInterpretationConfirmation[],
  fallback: string,
): string {
  if (confirmations.length === 0) return fallback;
  return confirmations.map((c) => c.summary).join(' · ');
}

function primaryConfirmId(
  confirmations: BusinessInterpretationConfirmation[],
): BusinessConfirmationId | undefined {
  return confirmations[0]?.id;
}

export interface ResolveOperationalReadingInput {
  item: InboxItem;
  workflow: WorkflowCore;
  eventType: BusinessEventType;
  eventCertainty: BusinessFactCertainty;
  facts: BusinessStructuredFacts;
  requiredConfirmations: BusinessInterpretationConfirmation[];
}

/**
 * Derive shared operational reading from kind, text signals, event, and facts.
 */
export function resolveOperationalReading(
  input: ResolveOperationalReadingInput,
): BusinessOperationalReading {
  const { item, workflow, eventType, eventCertainty, facts, requiredConfirmations } = input;
  const kind = workflow.classifiedKind;
  const corpus = collectCorpus(item, workflow);
  const meanings: BusinessMeaningKind[] = [];
  const importEmail = item.importSource === 'email';

  const looksHotel =
    /hotelrechnung|\bhotel\b|übernachtung|uebernachtung|frühstück|fruehstueck|tiefgarage|aufenthalt:/i.test(
      corpus,
    );
  const looksAuthorityText =
    /finanzamt|bg bau|berufsgenossenschaft|soka-?bau|krankenkasse|unbedenklichkeit|steuernummer|aktenzeichen/i.test(
      corpus,
    );
  const looksInsurance =
    isInsuranceClassifiedKind(kind) ||
    /versicherung|versicherungsschein|betriebshaftpflicht|jahresbeitrag|beitragsanpassung|schadenfall/i.test(
      corpus,
    );
  const looksBank =
    isBankClassifiedKind(kind) ||
    /rücklastschrift|ruecklastschrift|zahlungsstörung|zahlungsstoerung|sparkasse|lastschrift.*deckung/i.test(
      corpus,
    );
  const looksScheduleChange =
    /termin.*verschieb|verschieben|auf den \d{1,2}\.\d{1,2}/i.test(corpus);
  const looksReplyRequest =
    /bitte um (kurze )?rückmeldung|bitte um antwort|können wir|koennen wir/i.test(corpus);
  const looksDocSubmission =
    /einreichung|nachweis|unterlagen| meldenachweis|unbedenklichkeitsbescheinigung|reichen sie/i.test(
      corpus,
    );
  const looksContribution =
    /beitragsanpassung|jahresbeitrag|beitrag|prämie|praemie/i.test(corpus);
  const looksClaim = /schadenfall|schadensmeldung|regulierung/i.test(corpus);
  const looksPaymentProblem =
    /rücklastschrift|ruecklastschrift|unzureichende deckung|zahlungsstörung|zahlungsstoerung/i.test(
      corpus,
    );

  let primaryCase: BusinessPrimaryCase = mapEventToPrimary(eventType);
  let deadlineType: BusinessDeadlineType | undefined;
  let nextStep = 'Dokument prüfen und nächste Aktion bewusst bestätigen.';
  let certainty: BusinessFactCertainty = eventCertainty;

  // Contract/invoice specialist events must not be overridden by incidental
  // authority/insurance wording inside Werkvertrag boilerplate (e.g. BG/SOKA Nachweise).
  const strongSpecialistEvent =
    eventType === 'possible_new_business_case' ||
    eventType === 'contract_proposed' ||
    eventType === 'business_case_update' ||
    eventType === 'order_confirmed' ||
    eventType === 'service_change_proposed' ||
    eventType === 'invoice_created' ||
    eventType === 'payment_reminder_received' ||
    eventType === 'delivery_recorded' ||
    eventType === 'acceptance_recorded' ||
    eventType === 'complaint_received' ||
    eventType === 'evidence_added';

  const allowAuthorityInsuranceBank =
    !strongSpecialistEvent &&
    (eventType === 'review_required' ||
      eventType === 'information_only' ||
      eventType === 'deadline_or_obligation_detected' ||
      isAuthorityClassifiedKind(kind) ||
      isInsuranceClassifiedKind(kind) ||
      isBankClassifiedKind(kind) ||
      looksAuthorityText ||
      looksInsurance ||
      looksBank);

  // --- Domain signals (shared layer, not specialists) ---
  if (
    allowAuthorityInsuranceBank &&
    (isAuthorityClassifiedKind(kind) || (looksAuthorityText && !looksInsurance && !looksHotel))
  ) {
    if (looksDocSubmission) {
      primaryCase = 'authority_documents_required';
      deadlineType = 'document_submission_due';
      nextStep = 'Geforderte Unterlagen prüfen und Einreichung bis zur Frist vorbereiten.';
      pushUnique(meanings, 'obligation');
      pushUnique(meanings, 'evidence');
      pushUnique(meanings, 'deadline');
      pushUnique(meanings, 'action_required');
    } else if (/beitrag|zahlung|nachzahlung|bescheid.*€/i.test(corpus)) {
      primaryCase = 'authority_payment';
      deadlineType = 'payment_due';
      nextStep = 'Behördliche Zahlungsanforderung prüfen — keine automatische Zahlung.';
      pushUnique(meanings, 'money');
      pushUnique(meanings, 'obligation');
      pushUnique(meanings, 'action_required');
    } else {
      primaryCase = 'authority_information';
      nextStep = 'Behördenschreiben lesen, Frist prüfen und bewusst ablegen oder bearbeiten.';
      pushUnique(meanings, 'information');
      pushUnique(meanings, 'obligation');
    }
    certainty = 'detected';
  } else if (allowAuthorityInsuranceBank && looksInsurance) {
    // Contribution before claim: letters often mention Schadenfall only as aside.
    if (looksContribution) {
      primaryCase = 'insurance_contribution';
      deadlineType = hasDeadlineSignal(item, workflow, facts) ? 'response_due' : undefined;
      nextStep = 'Beitragsanpassung prüfen — keine automatische Zahlung oder Lastschriftänderung.';
      pushUnique(meanings, 'money');
      pushUnique(meanings, 'action_required');
      pushUnique(meanings, 'risk');
    } else if (looksClaim) {
      primaryCase = 'insurance_claim';
      nextStep = 'Schadenhinweis prüfen und benötigte Unterlagen zusammenstellen — keine Anerkennung.';
      pushUnique(meanings, 'risk');
      pushUnique(meanings, 'evidence');
      pushUnique(meanings, 'action_required');
    } else {
      primaryCase = 'insurance_information';
      nextStep = 'Versicherungsschreiben prüfen und bei Bedarf manuell nachfassen.';
      pushUnique(meanings, 'information');
    }
    if (hasDeadlineSignal(item, workflow, facts) && !deadlineType) {
      deadlineType = looksDocSubmission ? 'document_submission_due' : 'response_due';
      pushUnique(meanings, 'deadline');
    }
    certainty = 'detected';
  } else if (allowAuthorityInsuranceBank && looksBank) {
    if (looksPaymentProblem) {
      primaryCase = 'bank_payment_problem';
      nextStep = 'Zahlungsstörung klären — keine automatische erneute Zahlung auslösen.';
      pushUnique(meanings, 'money');
      pushUnique(meanings, 'risk');
      pushUnique(meanings, 'action_required');
      pushUnique(meanings, 'communication');
    } else {
      primaryCase = 'bank_information';
      nextStep = 'Bankmitteilung prüfen und bei Bedarf manuell zuordnen.';
      pushUnique(meanings, 'information');
      pushUnique(meanings, 'money');
    }
    certainty = 'detected';
  } else if (looksHotel && (eventType === 'invoice_received' || /hotelrechnung|rechnung/i.test(corpus))) {
    primaryCase = 'expense_hotel';
    nextStep = 'Hotel-/Reisebeleg als Betriebsausgabe prüfen — kein Kundenauftrag.';
    pushUnique(meanings, 'money');
    pushUnique(meanings, 'action_required');
    pushUnique(meanings, 'information');
    if (hasDeadlineSignal(item, workflow, facts)) {
      deadlineType = 'payment_due';
      pushUnique(meanings, 'deadline');
    }
    certainty = 'detected';
  } else if (
    importEmail ||
    kind === 'brief' ||
    kind === 'schriftverkehr' ||
    kind === 'email_pdf'
  ) {
    if (looksScheduleChange) {
      primaryCase = 'communication_schedule_change';
      deadlineType = 'service_due';
      nextStep = 'Terminvorschlag prüfen und Antwort bewusst freigeben — nicht automatisch senden.';
      pushUnique(meanings, 'communication');
      pushUnique(meanings, 'action_required');
      pushUnique(meanings, 'deadline');
    } else if (looksReplyRequest) {
      primaryCase = 'communication_request';
      deadlineType = 'response_due';
      nextStep = 'Kundenanfrage beantworten — Entwurf nur nach Freigabe senden.';
      pushUnique(meanings, 'communication');
      pushUnique(meanings, 'action_required');
    } else {
      primaryCase = 'communication_information';
      nextStep = 'Nachricht lesen und bei Bedarf dem Vorgang zuordnen.';
      pushUnique(meanings, 'communication');
      pushUnique(meanings, 'information');
    }
    certainty = importEmail || looksReplyRequest || looksScheduleChange ? 'detected' : eventCertainty;
  } else if (eventType === 'invoice_received') {
    primaryCase = 'invoice_received';
    nextStep = 'Rechnungsdaten prüfen und erst nach Freigabe finalisieren.';
    pushUnique(meanings, 'money');
    pushUnique(meanings, 'action_required');
    if (hasDeadlineSignal(item, workflow, facts)) {
      deadlineType = 'payment_due';
      pushUnique(meanings, 'deadline');
    }
  } else if (
    eventType === 'possible_new_business_case' ||
    eventType === 'contract_proposed'
  ) {
    primaryCase =
      eventType === 'contract_proposed' ? 'contract_proposed' : 'possible_new_order';
    nextStep = 'Vertragsdaten und Positionen prüfen — Auftrag nur nach Bestätigung anlegen.';
    pushUnique(meanings, 'obligation');
    pushUnique(meanings, 'action_required');
    if (hasMoneySignal(workflow, facts)) pushUnique(meanings, 'money');
    if (facts.positions.length > 0) pushUnique(meanings, 'evidence');
  } else if (eventType === 'review_required') {
    primaryCase = 'review_required';
    nextStep = 'Dokument manuell prüfen — keine Automatik.';
    pushUnique(meanings, 'review');
    pushUnique(meanings, 'action_required');
  } else if (eventType === 'information_only') {
    primaryCase = 'information_only';
    nextStep = 'Zur Kenntnis nehmen und bei Bedarf ablegen.';
    pushUnique(meanings, 'information');
  } else if (eventType === 'deadline_or_obligation_detected') {
    primaryCase = 'deadline_or_obligation_detected';
    nextStep = 'Frist oder Verpflichtung prüfen und bewusst handeln.';
    pushUnique(meanings, 'deadline');
    pushUnique(meanings, 'obligation');
    pushUnique(meanings, 'action_required');
    if (!deadlineType && hasDeadlineSignal(item, workflow, facts)) {
      deadlineType = 'response_due';
    }
  }

  // Termination notice from facts — never as payment_due
  if (facts.conditions.some((c) => c.type === 'termination') && !deadlineType) {
    // do not set timeline deadline; expose type only when kuendigung is the signal
    if (/kündigungsfrist|kuendigungsfrist/i.test(corpus)) {
      deadlineType = 'termination_notice';
      pushUnique(meanings, 'obligation');
    }
  }

  if (meanings.length === 0) {
    pushUnique(meanings, eventType === 'review_required' ? 'review' : 'information');
  }

  const confirmRequirement = confirmHint(
    requiredConfirmations,
    primaryConfirmId(requiredConfirmations)
      ? 'Vorhandene Bestätigungsschritte prüfen.'
      : 'Keine automatische Ausführung — Nutzerentscheidung erforderlich.',
  );

  return {
    primaryCase,
    meanings,
    deadlineType,
    nextStep,
    confirmRequirement,
    certainty,
  };
}
