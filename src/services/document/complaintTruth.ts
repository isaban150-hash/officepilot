/**
 * EINGANG-02C — eine Beschwerde neben dem, was OfficeTakt sicher weiss.
 *
 * Liest nur, was der semantische Kern (`complaint`, Pflichten, Fristen)
 * bereits ermittelt hat, und leitet daraus die Prüfhandlung, die Aufgabe und
 * die sichtbaren Sätze ab. Alles bleibt Angabe des Absenders: kein Mangel
 * anerkannt, keine Haftung, keine Gutschrift, keine Zahlung, keine Antwort.
 */
import type { TranslationKey } from '../../i18n';
import type { BusinessDeadlineType } from '../../types/businessInterpretation';
import type {
  DocumentSemanticCore,
  SemanticComplaint,
  SemanticComplaintDemand,
  SemanticComplaintDemandKind,
} from '../../types/documentSemanticCore';
import type { ClassifiedDocumentKind, InboxItem } from '../../types/models';
import { formatDunningAmount } from './dunningFinanceTruth';

/*
 * Nur auf der neutralen Grundart eines Schreibens. Eine echte Rechnung, ein
 * Mängel- oder Abnahmeprotokoll und Behördenpost behalten ihren eigenen Weg.
 */
const BESCHWERDE_GRUNDARTEN: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'sonstiges',
  'schriftverkehr',
  'brief',
  'email_pdf',
]);

/** Die Beschwerde eines Eingangs — oder `null`, wenn keine vorliegt oder die Art einen eigenen Weg hat. */
export function resolveComplaint(
  item: Pick<InboxItem, 'classifiedKind'>,
  semantic: DocumentSemanticCore | null | undefined,
): SemanticComplaint | null {
  const complaint = semantic?.complaint;
  if (!complaint) return null;
  if (item.classifiedKind && !BESCHWERDE_GRUNDARTEN.has(item.classifiedKind)) return null;
  return complaint;
}

export type ComplaintAction = 'check_complaint' | 'prepare_statement' | 'check_remedy' | 'check_claim' | 'submit_documents';

const GELD: ReadonlySet<SemanticComplaintDemandKind> = new Set([
  'damages',
  'reimbursement',
  'reduction',
  'retention',
  'payment',
]);

const PFLICHT_HANDLUNG: Partial<Record<BusinessDeadlineType, ComplaintAction>> = {
  response_due: 'prepare_statement',
  service_due: 'check_remedy',
  document_submission_due: 'submit_documents',
  payment_due: 'check_claim',
};

/**
 * Die Prüfhandlung einer eingehenden Beschwerde: zuerst die Art der
 * kanonischen Frist (eine echte eigene Pflicht), dann eine eigene Pflicht
 * ohne Datum, dann eine Geldforderung, sonst „Beschwerde prüfen".
 */
export function resolveComplaintAction(
  complaint: SemanticComplaint,
  semantic: DocumentSemanticCore | null | undefined,
  deadlineType?: BusinessDeadlineType,
): ComplaintAction {
  const eigene = (semantic?.obligations ?? []).filter((p) => p.who === 'own_company' && p.kind);
  const geld = complaint.demands.some((d) => GELD.has(d.kind));
  if (deadlineType && PFLICHT_HANDLUNG[deadlineType]) {
    const gedeckt = eigene.some((p) => p.kind === deadlineType);
    if (gedeckt || !geld) return PFLICHT_HANDLUNG[deadlineType]!;
  }
  if (deadlineType && geld) return 'check_claim';
  const pflicht = eigene.find((p) => p.kind && PFLICHT_HANDLUNG[p.kind]);
  if (pflicht?.kind) return PFLICHT_HANDLUNG[pflicht.kind]!;
  if (geld) return 'check_claim';
  return 'check_complaint';
}

/* ------------------------------------------------------------------ */
/* Aufgaben                                                            */
/* ------------------------------------------------------------------ */

export const COMPLAINT_TASK_TITLE: Record<ComplaintAction, string> = {
  check_complaint: 'Beschwerde prüfen',
  prepare_statement: 'Stellungnahme vorbereiten',
  check_remedy: 'Nachbesserung prüfen',
  check_claim: 'Forderung prüfen',
  submit_documents: 'Unterlagen senden',
};

/** Titel je eigener Pflicht einer Beschwerde (02A-2C-Mehrpflicht, gleiche Schlüssel). */
export const COMPLAINT_OBLIGATION_TITLE: Partial<Record<BusinessDeadlineType, string>> = {
  response_due: COMPLAINT_TASK_TITLE.prepare_statement,
  service_due: COMPLAINT_TASK_TITLE.check_remedy,
  document_submission_due: COMPLAINT_TASK_TITLE.submit_documents,
  payment_due: COMPLAINT_TASK_TITLE.check_claim,
};

const FORDERUNG_TEXT: Record<SemanticComplaintDemandKind, string> = {
  remedy: 'Nachbesserung bzw. Mangelbeseitigung',
  statement: 'eine Stellungnahme',
  documents: 'Unterlagen',
  damages: 'Schadenersatz',
  reimbursement: 'Erstattung von Kosten',
  reduction: 'Minderung',
  retention: 'Einbehalt',
  payment: 'Zahlung',
};

function anzeigeDatum(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function forderungZusatz(demand: SemanticComplaintDemand): string {
  return [
    demand.amount !== undefined ? formatDunningAmount(demand.amount) : '',
    demand.byWhen ? `bis ${anzeigeDatum(demand.byWhen)}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Beschreibung einer Beschwerde-Aufgabe: Angaben des Absenders, ausdrücklich unbestätigt. */
export function buildComplaintTaskDescription(complaint: SemanticComplaint): string {
  const zeilen = complaint.reports.map((r) => `Laut Absender: „${r.snippet}"`);
  for (const demand of complaint.demands) {
    const zusatz = forderungZusatz(demand);
    zeilen.push(`Forderung laut Absender: ${FORDERUNG_TEXT[demand.kind]}${zusatz ? ` (${zusatz})` : ''}`);
  }
  zeilen.push('OfficeTakt bestätigt diese Angaben nicht und erkennt nichts an.');
  return zeilen.join('\n');
}

/* ------------------------------------------------------------------ */
/* Sichtbare Sätze                                                     */
/* ------------------------------------------------------------------ */

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
}

const FORDERUNG_KEY: Record<SemanticComplaintDemandKind, TranslationKey> = {
  remedy: 'documentMeaning.complaint.demand.remedy',
  statement: 'documentMeaning.complaint.demand.statement',
  documents: 'documentMeaning.complaint.demand.documents',
  damages: 'documentMeaning.complaint.demand.damages',
  reimbursement: 'documentMeaning.complaint.demand.reimbursement',
  reduction: 'documentMeaning.complaint.demand.reduction',
  retention: 'documentMeaning.complaint.demand.retention',
  payment: 'documentMeaning.complaint.demand.payment',
};

const BEZUG_KEY: Record<NonNullable<SemanticComplaint['references']>[number]['kind'], TranslationKey> = {
  order: 'documentMeaning.complaint.reference.order',
  invoice: 'documentMeaning.complaint.reference.invoice',
  case: 'documentMeaning.complaint.reference.case',
  offer: 'documentMeaning.complaint.reference.offer',
};

/**
 * Die Ebenen getrennt: was der Absender meldet (A), was er fordert oder
 * ankündigt (B, mit Frist C), welche Bezüge er nennt (D) — und dass OfficeTakt
 * nichts davon bestätigt (E).
 */
export function buildComplaintMeaningLines(
  complaint: SemanticComplaint,
  translate: (key: TranslationKey) => string,
): string[] {
  if (complaint.direction === 'outgoing') return [translate('documentMeaning.complaint.outgoing')];
  const zeilen: string[] = [];
  for (const meldung of complaint.reports) {
    zeilen.push(fill(translate('documentMeaning.complaint.reports'), { text: meldung.snippet }));
  }
  for (const demand of complaint.demands) {
    const zusatz = forderungZusatz(demand);
    const was = `${translate(FORDERUNG_KEY[demand.kind])}${zusatz ? ` (${zusatz})` : ''}`;
    const vorlage =
      demand.kind === 'retention' || demand.kind === 'reduction'
        ? 'documentMeaning.complaint.announces'
        : 'documentMeaning.complaint.demands';
    zeilen.push(fill(translate(vorlage), { what: was }));
  }
  for (const schritt of complaint.escalation ?? []) {
    const was = translate(
      schritt === 'substitute_performance'
        ? 'documentMeaning.complaint.escalation.substitutePerformance'
        : 'documentMeaning.complaint.escalation.legalAction',
    );
    zeilen.push(fill(translate('documentMeaning.complaint.announces'), { what: was }));
  }
  if (complaint.references?.length) {
    const bezuege = complaint.references.map((b) => `${translate(BEZUG_KEY[b.kind])} ${b.number}`).join(', ');
    zeilen.push(fill(translate('documentMeaning.complaint.references'), { refs: bezuege }));
  }
  zeilen.push(translate('documentMeaning.complaint.notConfirmed'));
  return zeilen;
}

/** Der Betrag, den der Absender selbst nennt (Einbehalt, Schadenersatz, Minderung …) — nie ein zitierter Rechnungsbetrag. */
export function resolveComplaintAmount(complaint: SemanticComplaint): number | undefined {
  return complaint.demands.find((d) => d.amount !== undefined && GELD.has(d.kind))?.amount;
}
