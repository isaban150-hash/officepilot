/**
 * EINGANG-01D-2 — die sichtbare Einschätzung eines Eingangs.
 *
 * Eine reine Ableitung (Projection) aus bereits vorhandener Wahrheit:
 *   - Eingang: Dokumentart, Absender, kanonische Frist (`deadline` +
 *     `deadlineType`), `financeReviewReason`, Verknüpfung, Status;
 *   - die vorhandene `DocumentSummary` (Fallzuordnung, bestehende Aktionen);
 *   - Firmenname, verknüpfte Ausgabe, verknüpfter Vorgang (vom Aufrufer gelesen).
 *
 * Sie persistiert nichts, klassifiziert nicht neu, erfindet keine Frist und
 * keinen Betrag und ruft keine KI. Was sie nicht sicher weiss, lässt sie leer.
 *
 * Die zweite Aufgabe ist die Korrektur der sichtbaren Karte, wo die Analyse
 * über den ganzen Text der kanonischen Hauptdokument-Wahrheit widerspricht
 * (Gutschrift mit angehängter Originalrechnung: deren Fälligkeit und Nummer
 * gehören nicht der Gutschrift). `buildDocumentSummary` selbst bleibt dabei
 * unverändert — die Korrektur gilt nur der Anzeige.
 */
import type { TranslationKey } from '../../i18n';
import type { BusinessDeadlineType } from '../../types/businessInterpretation';
import type { DocumentSemanticCore, SemanticComplaint } from '../../types/documentSemanticCore';
import { formatDunningAmount, resolveDunningFinanceTruth, type DunningFinanceState, type DunningFinanceTruth } from './dunningFinanceTruth';
import { resolveComplaint, resolveComplaintAction } from './complaintTruth';
import type {
  DocumentSummary,
  DocumentSummaryActionRef,
  DocumentSummaryFact,
} from '../../types/documentSummary';
import type { InboxItem } from '../../types/models';
import { isOwnCompanyName } from '../customerOwnCompanyGuard';
import { getInboxExtractedDocumentText } from '../inboxDocumentText';
import { resolveInboxDocumentText } from './documentSourceTextService';
import { buildDocumentLeadText } from '../documentLeadText';
import { resolveCreditNoteGrossTotal, resolveCreditNoteNumber } from '../officeActionService';

export type IntakeAssessmentRole =
  | 'supplier_credit'
  | 'own_credit'
  | 'invoice_correction'
  | 'self_billing_credit'
  | 'invoice'
  | 'other';

export type IntakeAssessmentActionNeed =
  | 'none'
  | 'review'
  | 'reply'
  | 'pay'
  | 'submit_documents'
  | 'observe_deadline'
  | 'assign'
  | 'record'
  | 'archive'
  /* EINGANG-02A-2B — Zahlungsfrist sicher erkannt: prüfen, nie automatisch zahlen. */
  | 'check_payment'
  /* EINGANG-02A-2B — Handlung mit nur relativer Frist: Datum selbst prüfen. */
  | 'check_deadline'
  /* EINGANG-02B — eingehende Mahnung neben der bekannten Finanzwahrheit; nie „Zahlen". */
  | 'check_dunning'
  | 'check_payment_status'
  | 'check_remaining_claim'
  | 'check_invoice_reference'
  | 'check_court_dunning'
  /* EINGANG-02C — eingehende Beschwerde: prüfen/vorbereiten, nie anerkennen oder zahlen. */
  | 'check_complaint'
  | 'prepare_statement'
  | 'check_remedy'
  | 'check_claim';

export type IntakeAssessmentStatus = 'sicher' | 'wahrscheinlich' | 'pruefen';

export type IntakeAssessmentAssignmentState = 'confirmed' | 'exact' | 'likely' | 'multiple' | 'none';

export interface IntakeAssessmentDeadline {
  /** Kanonischer Tag `JJJJ-MM-TT`. */
  date: string;
  /** Anzeige `TT.MM.JJJJ`. */
  display: string;
  type?: BusinessDeadlineType;
  labelKey: TranslationKey;
}

export interface IntakeAssessment {
  role: IntakeAssessmentRole;
  /** Feste Bezeichnung für Sonderrollen, sonst die Dokumentart als Schlüssel. */
  kindLabelKey?: TranslationKey;
  classifiedKind?: string;
  sender?: string;
  /** Eigene Nummer des Hauptdokuments — nie die einer zitierten Rechnung. */
  documentNumber?: string;
  assignment: { state: IntakeAssessmentAssignmentState; target?: string };
  deadline: IntakeAssessmentDeadline | null;
  /**
   * EINGANG-02A-2B — eine Handlung ohne absolutes Datum: die relative Frist im
   * Wortlaut oder „keine Frist genannt". Nur wenn `deadline` fehlt.
   */
  openDeadline?: { phrase: string } | { notStated: true };
  /** EINGANG-02A-2B — ausdrücklich reine Information, nichts zu tun. */
  informationOnly?: boolean;
  /**
   * EINGANG-02B — Mahnung neben der bekannten Finanzwahrheit (Bezug, bezahlt,
   * Rest, Forderung laut Mahnung). Nur gelesen, nichts gebucht.
   */
  dunning?: DunningFinanceTruth;
  /**
   * WEISS-Nacharbeit — der gedruckte Gesamtbetrag einer Gutschrift (Betrag,
   * ohne Vorzeichen), aus derselben Wahrheit wie die Formular-Vorbelegung
   * (`resolveCreditNoteGrossTotal`). Fehlt, wenn er nicht eindeutig ist.
   */
  creditTotal?: number;
  /** EINGANG-02C — Beschwerde laut Absender (Kern), Richtung eingehend oder eigenes Schreiben. */
  complaint?: SemanticComplaint;
  actionNeed: IntakeAssessmentActionNeed;
  nextStep: DocumentSummaryActionRef;
  status: IntakeAssessmentStatus;
  hasLinkedExpense: boolean;
}

export interface IntakeAssessmentInput {
  item: InboxItem;
  summary: DocumentSummary;
  /** Name des eigenen Betriebs aus dem Firmenprofil (für eigene Gutschriften). */
  ownCompanyName?: string;
  /** Gibt es zu diesem Eingang bereits eine Ausgabe? */
  hasLinkedExpense: boolean;
  /**
   * Hat die verknüpfte Ausgabe laut bestehender Finanzwahrheit noch einen
   * offenen Zahlbetrag (`getExpenseOpenAmount` > 0, nicht storniert)? Vom
   * Aufrufer gelesen; ohne verknüpfte Ausgabe ohne Bedeutung.
   */
  linkedExpenseOpen?: boolean;
  /** Bestätigt verknüpfter Vorgang, falls vorhanden. */
  linkedVorgang?: { title?: string; vorgangNumber?: string } | null;
  /** Die Klassifikation verlangt ausdrücklich eine Prüfung der Dokumentart. */
  needsKindReview?: boolean;
  /**
   * EINGANG-02A-2B — der gespeicherte semantische Kern (Pflichten, relative
   * Fristen, Informationshinweis). Ohne Kern bleibt alles wie bisher.
   */
  semantic?: DocumentSemanticCore | null;
}

const UNKNOWN_SENDER = /absender nicht eindeutig/i;
// Mahnung/Zahlungserinnerung verweisen auf eine vorhandene Rechnung (Zahlung prüfen) — keine eigene Erfassung.
const INVOICE_KINDS = new Set(['eingangsrechnung', 'rechnung']);
const FILED_STATUSES = new Set(['abgelegt']);

const DEADLINE_LABEL: Record<string, TranslationKey> = {
  payment_due: 'intakeAssessment.deadline.payment_due',
  response_due: 'intakeAssessment.deadline.response_due',
  document_submission_due: 'intakeAssessment.deadline.document_submission_due',
  service_due: 'intakeAssessment.deadline.service_due',
  termination_notice: 'intakeAssessment.deadline.termination_notice',
};

function toDisplayDate(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return parts ? `${parts[3]}.${parts[2]}.${parts[1]}` : iso;
}

function resolveRole(item: InboxItem, ownCompanyName: string | undefined): IntakeAssessmentRole {
  if (item.financeReviewReason === 'invoice_correction') return 'invoice_correction';
  if (item.financeReviewReason === 'self_billing_credit') return 'self_billing_credit';
  if (item.classifiedKind === 'gutschrift') {
    return ownCompanyName?.trim() && isOwnCompanyName(item.sender, ownCompanyName) ? 'own_credit' : 'supplier_credit';
  }
  if (item.classifiedKind && INVOICE_KINDS.has(item.classifiedKind)) return 'invoice';
  return 'other';
}

const ROLE_KIND_LABEL: Partial<Record<IntakeAssessmentRole, TranslationKey>> = {
  supplier_credit: 'intakeAssessment.kind.supplierCredit',
  own_credit: 'intakeAssessment.kind.ownCredit',
  invoice_correction: 'intakeAssessment.kind.invoiceCorrection',
  self_billing_credit: 'intakeAssessment.kind.selfBillingCredit',
};

/** Die sichtbare Frist: ausschliesslich die kanonische Frist des Eingangs. */
export function resolveCanonicalAssessmentDeadline(item: InboxItem): IntakeAssessmentDeadline | null {
  const date = item.deadline?.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const type = item.deadlineType;
  return {
    date,
    display: toDisplayDate(date),
    ...(type ? { type } : {}),
    labelKey: (type && DEADLINE_LABEL[type]) || 'intakeAssessment.deadline.untyped',
  };
}

/** Eigene Nummer des Hauptdokuments (01D-1-Wahrheit wiederverwendet). */
function resolveDocumentNumber(item: InboxItem, role: IntakeAssessmentRole): string | undefined {
  if (role === 'supplier_credit' || role === 'own_credit') {
    return resolveCreditNoteNumber(getInboxExtractedDocumentText(item)) || undefined;
  }
  if (role === 'invoice' || role === 'invoice_correction') {
    const value = (item.recognizedData.Rechnungsnummer ?? item.recognizedData.Belegnummer ?? '').trim();
    return value || undefined;
  }
  return undefined;
}

function resolveAssignment(input: IntakeAssessmentInput): IntakeAssessment['assignment'] {
  const { item, summary, linkedVorgang } = input;
  const linked = item.vorgangLinkStatus === 'linked' || item.vorgangLinkStatus === 'created';
  if (linked && item.vorgangId) {
    const target = linkedVorgang?.vorgangNumber?.trim() || linkedVorgang?.title?.trim() || item.vorgangTitle?.trim();
    return { state: 'confirmed', ...(target ? { target } : {}) };
  }
  const match = summary.caseMatch;
  if (!match || match.matchStatus === 'none') return { state: 'none' };
  const target = match.matchedCaseTitle?.trim() || undefined;
  if (match.matchStatus === 'exact') return { state: 'exact', ...(target ? { target } : {}) };
  if (match.matchStatus === 'likely') return { state: 'likely', ...(target ? { target } : {}) };
  return { state: 'multiple' };
}

const NEXT_RECORD: DocumentSummaryActionRef = {
  id: 'record_expense',
  labelKey: 'intakeAssessment.next.recordCredit',
  enabled: true,
};
const NEXT_OPEN_EXPENSE: DocumentSummaryActionRef = {
  id: 'record_expense',
  labelKey: 'intakeAssessment.next.openExpense',
  enabled: true,
};
const NEXT_REVIEW: DocumentSummaryActionRef = {
  id: 'apply_intake',
  labelKey: 'intakeAssessment.next.reviewAndFile',
  enabled: true,
};
/* EINGANG-02A-2B — reine Information: ablegen genügt. Nur Beschriftung, keine neue Aktion. */
const NEXT_FILE_ONLY: DocumentSummaryActionRef = {
  id: 'later',
  labelKey: 'intakeAssessment.next.fileOnly',
  enabled: true,
};

/* EINGANG-02B — Prüfaktion je bekanntem Finanzstand einer Mahnung. */
const MAHNUNG_HANDLUNG: Record<DunningFinanceState, IntakeAssessmentActionNeed> = {
  open: 'check_dunning',
  paid: 'check_payment_status',
  partially_paid: 'check_remaining_claim',
  reference_unclear: 'check_invoice_reference',
  court: 'check_court_dunning',
};

const PFLICHT_HANDLUNG: Partial<Record<BusinessDeadlineType, IntakeAssessmentActionNeed>> = {
  payment_due: 'check_payment',
  response_due: 'reply',
  document_submission_due: 'submit_documents',
};

/**
 * EINGANG-02A-2B — was der semantische Kern über eine Handlung ohne Datum weiss.
 * Nur für „sonstige" Rollen (Behörde, Versicherung, Schreiben); Rechnungen und
 * Gutschriften haben ihren eigenen Finanzweg.
 */
function resolveSemanticOpenAction(
  semantic: DocumentSemanticCore | null | undefined,
  hasCanonicalDeadline: boolean,
) {
  if (!semantic || hasCanonicalDeadline) return { relative: undefined, typedObligation: undefined, informationOnly: false };
  const relative = semantic.relativeDeadlines?.[0];
  /* Gebrauchshinweise einer Bescheinigung tragen keine Art; sie bleiben, wie sie waren. */
  const typedObligation = semantic.certificate?.type
    ? undefined
    : semantic.obligations.find((p) => p.who === 'own_company' && p.kind && !p.byWhen);
  return { relative, typedObligation, informationOnly: Boolean(semantic.informationOnly) };
}

/**
 * Nacharbeit 1 — der nächste Schritt einer Gutschrift, ohne Karte und ohne
 * Zusammenfassung (für den KI-Kontext). Dieselbe Rolle, dieselben Schritte wie
 * in `deriveIntakeAssessment`; für andere Dokumente `undefined`.
 */
export function resolveCreditNoteNextStepLabelKey(
  item: InboxItem,
  ownCompanyName: string | undefined,
  hasLinkedExpense: boolean,
): TranslationKey | undefined {
  const role = resolveRole(item, ownCompanyName);
  if (role === 'supplier_credit') return (hasLinkedExpense ? NEXT_OPEN_EXPENSE : NEXT_RECORD).labelKey;
  if (role === 'own_credit') return NEXT_REVIEW.labelKey;
  return undefined;
}

export function deriveIntakeAssessment(input: IntakeAssessmentInput): IntakeAssessment {
  const { item, summary, hasLinkedExpense } = input;
  const role = resolveRole(item, input.ownCompanyName);
  const deadline = resolveCanonicalAssessmentDeadline(item);
  const assignment = resolveAssignment(input);
  const reviewRole = role === 'own_credit' || role === 'invoice_correction' || role === 'self_billing_credit';
  const filed = FILED_STATUSES.has(item.status);
  const kindUnclear = !item.classifiedKind || item.classifiedKind === 'sonstiges';
  const open =
    role === 'other'
      ? resolveSemanticOpenAction(input.semantic, Boolean(deadline))
      : { relative: undefined, typedObligation: undefined, informationOnly: false };
  const openWithoutDate = Boolean(open.relative || open.typedObligation);
  /* EINGANG-02B — Mahnung/Zahlungserinnerung: Bezug und Zahlungsstand aus der vorhandenen Finanzwahrheit. */
  const dunning = role === 'other' ? resolveDunningFinanceTruth(item, input.semantic) : null;
  /* EINGANG-02C — Beschwerde/Reklamation/Mängelanzeige auf der neutralen Grundart. */
  const complaint = role === 'other' && !dunning ? resolveComplaint(item, input.semantic) : null;

  let actionNeed: IntakeAssessmentActionNeed;
  if (reviewRole) actionNeed = 'review';
  else if (role === 'supplier_credit') actionNeed = hasLinkedExpense ? 'none' : 'record';
  /*
   * Nacharbeit 1 — „Zahlen" nur, wenn die bestehende Finanzwahrheit es sagt:
   * Ohne Ausgabe verlangt der bestehende Aktionsvertrag zuerst „Ausgabe
   * erfassen"; mit Ausgabe nur bei offenem Betrag. Bezahlt/storniert → kein Zahlen.
   */
  else if (role === 'invoice' && !hasLinkedExpense) actionNeed = 'record';
  else if (role === 'invoice' && hasLinkedExpense && input.linkedExpenseOpen === true) actionNeed = 'pay';
  else if (role === 'invoice' && hasLinkedExpense && deadline?.type === 'payment_due') actionNeed = filed ? 'none' : 'archive';
  /*
   * EINGANG-02A-2B — eine sicher erkannte Zahlungsfrist eines Schreibens ist
   * „Zahlung prüfen", nicht bloss „Frist beachten". Gezahlt, erfasst oder
   * gebucht wird nichts.
   */
  else if (dunning) actionNeed = MAHNUNG_HANDLUNG[dunning.state];
  /* 02C — ein eigenes Schreiben setzt dem Empfänger Fristen, nicht uns. */
  else if (complaint?.direction === 'outgoing') actionNeed = 'none';
  else if (complaint) actionNeed = resolveComplaintAction(complaint, input.semantic, deadline?.type);
  else if (role === 'other' && deadline?.type === 'payment_due') actionNeed = 'check_payment';
  else if (deadline?.type === 'response_due') actionNeed = 'reply';
  else if (deadline?.type === 'document_submission_due') actionNeed = 'submit_documents';
  else if (deadline) actionNeed = 'observe_deadline';
  /* 02A-2B — Handlung ohne absolutes Datum: nie „Archivieren". */
  else if (open.relative) actionNeed = 'check_deadline';
  else if (open.typedObligation) actionNeed = PFLICHT_HANDLUNG[open.typedObligation.kind!] ?? 'review';
  else if (assignment.state === 'multiple' || assignment.state === 'likely') actionNeed = 'assign';
  else if (input.needsKindReview || kindUnclear) actionNeed = filed ? 'none' : 'review';
  /* 02A-2B — ausdrücklich reine Information: keine Aktion, Ablegen genügt. */
  else if (open.informationOnly) actionNeed = 'none';
  else actionNeed = filed ? 'none' : 'archive';

  const informationOnly = open.informationOnly && actionNeed === 'none' && !openWithoutDate;

  let nextStep: DocumentSummaryActionRef;
  if (reviewRole) nextStep = NEXT_REVIEW;
  else if (role === 'supplier_credit') nextStep = hasLinkedExpense ? NEXT_OPEN_EXPENSE : NEXT_RECORD;
  else if (informationOnly) nextStep = NEXT_FILE_ONLY;
  else nextStep = summary.primaryAction;

  let status: IntakeAssessmentStatus;
  if (reviewRole || input.needsKindReview || kindUnclear || assignment.state === 'multiple') status = 'pruefen';
  /* 02B — nur eine Mahnung mit sicherem Bezug auf eine offene Rechnung ist „sicher". */
  else if (dunning && dunning.state !== 'open') status = 'pruefen';
  /* 02A-2B — eigene Pflicht ohne sicheres Datum ist nie „sicher". */
  else if (openWithoutDate) status = 'pruefen';
  /* 02A-3 — eine verdächtige, nicht abgegrenzte Folgeseite: lieber prüfen als sicher. */
  else if ((input.semantic?.pageScope?.uncertainPageNumbers.length ?? 0) > 0) status = 'pruefen';
  else if (assignment.state === 'likely' || (deadline && !deadline.type)) status = 'wahrscheinlich';
  else status = 'sicher';

  const openDeadline: IntakeAssessment['openDeadline'] = open.relative
    ? { phrase: open.relative.phrase }
    : open.typedObligation
      ? { notStated: true }
      : undefined;

  const sender = item.sender?.trim();
  const documentNumber = resolveDocumentNumber(item, role);
  /*
   * WEISS-Nacharbeit — der Gutschriftsbetrag ist der beschriftete Gesamtbetrag
   * des Hauptdokuments, nicht das Erkennungsfeld `Betrag` (dort kann der
   * Nettobetrag stehen). Das Rohfeld bleibt unverändert.
   */
  const creditTotal =
    role === 'supplier_credit' || role === 'own_credit'
      ? resolveCreditNoteGrossTotal(resolveInboxDocumentText(item))
      : null;
  const kindLabelKey = complaint
    ? (`intakeAssessment.kind.complaint.${complaint.direction === 'outgoing' ? 'outgoing' : complaint.type}` as TranslationKey)
    : ROLE_KIND_LABEL[role];

  return {
    role,
    ...(kindLabelKey ? { kindLabelKey } : {}),
    ...(item.classifiedKind ? { classifiedKind: item.classifiedKind } : {}),
    ...(sender && !UNKNOWN_SENDER.test(sender) ? { sender } : {}),
    ...(documentNumber ? { documentNumber } : {}),
    ...(creditTotal !== null ? { creditTotal } : {}),
    assignment,
    deadline,
    ...(openDeadline ? { openDeadline } : {}),
    ...(informationOnly ? { informationOnly } : {}),
    ...(dunning ? { dunning } : {}),
    ...(complaint ? { complaint } : {}),
    actionNeed,
    nextStep,
    status,
    hasLinkedExpense,
  };
}

/**
 * Die sichtbare Karte folgt der Einschätzung:
 *   - Hauptaktion = nächster Schritt (Lieferantengutschrift: „Ausgabe erfassen"
 *     über den bestehenden `record_expense`-Weg; Prüffälle und eigene
 *     Gutschrift: nie „Ausgabe erfassen");
 *   - Frist-Fakt nur aus der kanonischen Frist;
 *   - Nummer-Fakt einer Gutschrift ist ihre eigene Nummer, nie die zitierte.
 */
export function applyIntakeAssessmentToSummary(
  summary: DocumentSummary,
  assessment: IntakeAssessment,
): DocumentSummary {
  const credit = assessment.role === 'supplier_credit' || assessment.role === 'own_credit';
  const reviewRole =
    assessment.role === 'own_credit' ||
    assessment.role === 'invoice_correction' ||
    assessment.role === 'self_billing_credit';

  const facts: DocumentSummaryFact[] = [];
  for (const fact of summary.facts) {
    if (fact.id === 'deadline') {
      if (!assessment.deadline) continue;
      facts.push({
        ...fact,
        value: assessment.deadline.display,
        labelKey:
          assessment.deadline.type === 'payment_due' ? 'documentExperience.fact.due' : 'documentExperience.fact.deadline',
        label: undefined,
      });
      continue;
    }
    if (credit && fact.id === 'invoiceNumber') {
      if (!assessment.documentNumber) continue;
      facts.push({ ...fact, value: assessment.documentNumber, labelKey: 'intakeAssessment.fact.creditNumber', label: undefined });
      continue;
    }
    if (credit && fact.id === 'amount') {
      facts.push({
        ...fact,
        /* WEISS-Nacharbeit — der sichere Gesamtbetrag geht dem Erkennungsfeld vor. */
        ...(assessment.creditTotal !== undefined ? { value: formatDunningAmount(assessment.creditTotal) } : {}),
        labelKey: 'intakeAssessment.fact.creditAmount',
        label: undefined,
      });
      continue;
    }
    facts.push(fact);
  }
  if (credit && assessment.creditTotal !== undefined && !facts.some((fact) => fact.id === 'amount')) {
    facts.push({
      id: 'amount',
      labelKey: 'intakeAssessment.fact.creditAmount',
      value: formatDunningAmount(assessment.creditTotal),
    });
  }

  let primaryAction = summary.primaryAction;
  let secondaryActions = summary.secondaryActions;
  const replacePrimary =
    assessment.role === 'supplier_credit' || (reviewRole && summary.primaryAction.id === 'record_expense');
  if (replacePrimary && primaryAction.id !== assessment.nextStep.id) {
    const previous = summary.primaryAction;
    primaryAction = assessment.nextStep;
    const keepPrevious = previous.id !== 'record_expense' && previous.id !== 'apply_intake';
    secondaryActions = [
      ...(keepPrevious ? [previous] : []),
      ...summary.secondaryActions.filter((action) => action.id !== previous.id && action.id !== primaryAction.id),
    ];
  } else if (replacePrimary) {
    primaryAction = { ...assessment.nextStep, enabled: summary.primaryAction.enabled };
  }
  if (reviewRole) {
    secondaryActions = secondaryActions.filter((action) => action.id !== 'record_expense');
    // Dieselbe Aktion (Ablage/Prüfung), nur die Beschriftung folgt dem nächsten Schritt.
    if (primaryAction.id === 'apply_intake') primaryAction = { ...primaryAction, labelKey: assessment.nextStep.labelKey };
  }

  /*
   * Nacharbeit 1 — der analysierte Arbeitsschritt einer Gutschrift kann aus der
   * angehängten Rechnung stammen („Rechnungsdaten prüfen …"); der nächste
   * Schritt steht dann nur in der Einschätzung.
   */
  const details = credit ? summary.details.filter((detail) => detail.id !== 'nextStep') : summary.details;

  return { ...summary, facts, primaryAction, secondaryActions, details };
}

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
}

/** Erklärender Satz für Sonderrollen; sonst bleibt der bisherige Satz. */
export function buildIntakeAssessmentLead(
  assessment: IntakeAssessment,
  summary: DocumentSummary,
  translate: (key: TranslationKey) => string,
): string | undefined {
  const sender = assessment.sender ?? '';
  switch (assessment.role) {
    case 'supplier_credit': {
      if (assessment.hasLinkedExpense) {
        return fill(translate('intakeAssessment.lead.supplierCreditRecorded'), { sender: sender || '—' });
      }
      /* WEISS-Nacharbeit — der sichere Gesamtbetrag zuerst, unabhängig davon, welche Zusammenfassung übergeben wird. */
      const amount =
        assessment.creditTotal !== undefined
          ? formatDunningAmount(assessment.creditTotal)
          : summary.facts.find((fact) => fact.id === 'amount')?.value?.trim();
      if (sender && amount) return fill(translate('intakeAssessment.lead.supplierCredit'), { sender, amount });
      return fill(translate('intakeAssessment.lead.supplierCreditNoAmount'), { sender: sender || 'Der Absender' });
    }
    case 'own_credit':
      return translate('intakeAssessment.lead.ownCredit');
    case 'invoice_correction':
      return translate('intakeAssessment.lead.invoiceCorrection');
    case 'self_billing_credit':
      return translate('intakeAssessment.lead.selfBillingCredit');
    default:
      /*
       * EINGANG-02B — der Satz über das Dokument bleibt („… erinnert an die
       * Zahlung der Rechnung …“); der Abgleich mit OfficeTakt kommt dazu.
       */
      if (assessment.complaint) {
        /*
         * EINGANG-02C — die Einordnung als Angabe des Absenders. Der allgemeine
         * Satz der neutralen Grundart („… noch nicht eindeutig einordnen")
         * widerspräche der erkannten Beschwerde und entfällt hier.
         */
        return translate(
          assessment.complaint.direction === 'outgoing'
            ? 'intakeAssessment.complaint.lead.outgoing'
            : 'intakeAssessment.complaint.lead.incoming',
        );
      }
      return assessment.dunning
        ? [buildDocumentLeadText(summary, translate), buildDunningExplanation(assessment.dunning, translate)].filter(Boolean).join(' ')
        : undefined;
  }
}

/**
 * EINGANG-02B — die Mahnung in einem Satz neben der bekannten Finanzwahrheit.
 * Behauptet weder, dass die Forderung berechtigt ist, noch dass eine Zahlung
 * sicher erfolgt ist — „als bezahlt markiert" heisst genau das.
 */
export function buildDunningExplanation(
  dunning: DunningFinanceTruth,
  translate: (key: TranslationKey) => string,
): string {
  const werte: Record<string, string> = {
    invoice: dunning.invoiceNumber ?? '—',
    claim: dunning.claimAmount !== undefined ? formatDunningAmount(dunning.claimAmount) : '—',
    paid: dunning.paidAmount !== undefined ? formatDunningAmount(dunning.paidAmount) : '—',
    open: dunning.openAmount !== undefined ? formatDunningAmount(dunning.openAmount) : '—',
  };
  const key: Record<DunningFinanceState, TranslationKey> = {
    open: 'intakeAssessment.dunning.lead.open',
    paid: 'intakeAssessment.dunning.lead.paid',
    partially_paid: 'intakeAssessment.dunning.lead.partiallyPaid',
    reference_unclear: 'intakeAssessment.dunning.lead.referenceUnclear',
    court: 'intakeAssessment.dunning.lead.court',
  };
  return fill(translate(key[dunning.state]), werte);
}

/** EINGANG-02B — derselbe Satz für den Bedeutungsbereich (nur bei Mahnung/Zahlungserinnerung). */
export function resolveDunningMeaningNote(
  item: InboxItem,
  semantic: DocumentSemanticCore | null | undefined,
  translate: (key: TranslationKey) => string,
): string | undefined {
  const dunning = resolveDunningFinanceTruth(item, semantic);
  return dunning ? buildDunningExplanation(dunning, translate) : undefined;
}

/** Fertige Zeile der Zuordnung. */
export function formatIntakeAssessmentAssignment(
  assessment: IntakeAssessment,
  translate: (key: TranslationKey) => string,
): string {
  const { state, target } = assessment.assignment;
  if (state === 'none') return translate('intakeAssessment.assignment.none');
  if (state === 'multiple') return translate('intakeAssessment.assignment.multiple');
  const key: TranslationKey =
    state === 'confirmed'
      ? 'intakeAssessment.assignment.confirmed'
      : state === 'exact'
        ? 'intakeAssessment.assignment.exact'
        : 'intakeAssessment.assignment.likely';
  return fill(translate(key), { target: target ?? '—' });
}

/** EINGANG-02A-2B — Zeile einer Handlung ohne absolutes Datum. */
export function formatIntakeAssessmentOpenDeadline(
  openDeadline: NonNullable<IntakeAssessment['openDeadline']>,
  translate: (key: TranslationKey) => string,
): string {
  if ('phrase' in openDeadline) {
    return fill(translate('intakeAssessment.deadline.relative'), { phrase: openDeadline.phrase });
  }
  return translate('intakeAssessment.deadline.notStated');
}

export function formatIntakeAssessmentDeadline(
  deadline: IntakeAssessmentDeadline,
  translate: (key: TranslationKey) => string,
): string {
  return fill(translate(deadline.labelKey), { date: deadline.display });
}
