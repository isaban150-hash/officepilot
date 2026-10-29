/**
 * STEUERBERATER-06A — anlegen, ändern, bestätigen.
 *
 * Die eine Regel, an der alles hängt: **Vorschlag ≠ Übernahme.** Ein
 * automatisch erzeugter Eintrag beginnt bei `needs_review` oder
 * `needs_clarification`, nie bei `confirmed`. Bestätigt wird ausschliesslich
 * über `confirmAccountingAssignment` — eine eigene Aktion, kein Nebeneffekt des
 * Speicherns.
 *
 * Und die zweite: Eine bestätigte Kontierung, an der sich fachlich etwas
 * ändert, verliert ihre Bestätigung. Sonst stünde „bestätigt" an etwas, das
 * niemand in dieser Form bestätigt hat.
 */
import { generateUuid } from '../sync/syncMetaService';
import { persistAll } from '../persistenceService';
import { enqueueSyncOutbox } from '../sync/syncOutboxService';
import {
  appendAccountingAssignment,
  getAccountingAssignmentById,
  getAccountingAssignmentForSource,
  replaceAccountingAssignment,
} from './accountingStore';
import { getChartOfAccounts } from './accountingSettingsService';
import { isAccountingTaxInLineWithSource, isResolvedAccountingTaxTreatment } from './accountingCanonical';
import { suggestExpenseAccounting, suggestInvoiceAccounting } from './accountingSuggestionService';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';
import type {
  AccountingAssignment,
  AccountingAssignmentStatus,
  AccountingSourceType,
  AccountingSuggestion,
  AccountingTaxTreatment,
} from '../../types/accounting';

export type AccountingResult =
  | { success: true; assignment: AccountingAssignment }
  | { success: false; errorKey: string };

/** Die Felder, die ein Nutzer ändern darf. */
export interface AccountingAssignmentInput {
  accountNumber?: string;
  accountLabel?: string;
  bookingText?: string;
  taxTreatment?: AccountingTaxTreatment;
  status?: Exclude<AccountingAssignmentStatus, 'confirmed'>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function enqueue(assignment: AccountingAssignment, operation: 'create' | 'update' | 'delete'): void {
  enqueueSyncOutbox({
    entityType: 'accounting_assignment',
    entityId: assignment.id,
    operation,
    version: 1,
  });
}

/**
 * Welche Felder machen eine Änderung **fachlich** aus?
 *
 * Sachkonto, Kontobezeichnung, Steuerbehandlung und Buchungstext — genau das,
 * was der Steuerberater liest. Ein geänderter Zeitstempel oder ein neuer
 * Vorschlagsgrund ist keine fachliche Änderung und soll keine Bestätigung
 * entwerten.
 */
export function isMaterialAccountingChange(
  before: Pick<AccountingAssignment, 'accountNumber' | 'accountLabel' | 'taxTreatment' | 'bookingText'>,
  after: Pick<AccountingAssignment, 'accountNumber' | 'accountLabel' | 'taxTreatment' | 'bookingText'>,
): boolean {
  return (
    before.accountNumber.trim() !== after.accountNumber.trim() ||
    before.accountLabel.trim() !== after.accountLabel.trim() ||
    before.taxTreatment !== after.taxTreatment ||
    before.bookingText.trim() !== after.bookingText.trim()
  );
}

function fromSuggestion(
  sourceType: AccountingSourceType,
  sourceId: string,
  suggestion: AccountingSuggestion,
): AccountingAssignment {
  const timestamp = nowIso();
  return {
    id: generateUuid(),
    sourceType,
    sourceId,
    // Eingefroren: eine spätere Umstellung des Betriebs deutet diese Zuordnung nicht um.
    chartOfAccounts: getChartOfAccounts(),
    accountNumber: suggestion.accountNumber,
    accountLabel: suggestion.accountLabel,
    taxTreatment: suggestion.taxTreatment,
    bookingText: suggestion.bookingText,
    suggestionReason: suggestion.reason,
    /*
     * Hier steht der Kern des Blocks: Der Status kommt aus dem Vorschlag, und
     * der Typ `AccountingSuggestion` lässt `confirmed` gar nicht zu. Ein
     * Vorschlag kann diese Zeile nicht bestätigen, auch nicht versehentlich.
     */
    status: suggestion.status,
    origin: 'suggested',
    suggestedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Legt die Kontierung eines Eingangsbelegs an, falls es noch keine gibt.
 *
 * Idempotent: Eine vorhandene Kontierung wird **nicht** überschrieben. Ein
 * erneuter Vorschlag darf eine bestätigte Zuordnung nicht verdrängen.
 */
export function ensureExpenseAccountingAssignment(expense: Expense): AccountingResult {
  const existing = getAccountingAssignmentForSource('expense', expense.id);
  if (existing) return { success: true, assignment: existing };

  const assignment = fromSuggestion(
    'expense',
    expense.id,
    suggestExpenseAccounting({ expense }),
  );
  const stored = appendAccountingAssignment(assignment);
  enqueue(stored, 'create');
  persistAll();
  return { success: true, assignment: stored };
}

/** Dasselbe für eine Ausgangsrechnung. */
export function ensureInvoiceAccountingAssignment(
  invoice: VorgangInvoice,
  customerName?: string,
): AccountingResult {
  const existing = getAccountingAssignmentForSource('invoice', invoice.id);
  if (existing) return { success: true, assignment: existing };

  const assignment = fromSuggestion(
    'invoice',
    invoice.id,
    suggestInvoiceAccounting({ invoice, customerName }),
  );
  const stored = appendAccountingAssignment(assignment);
  enqueue(stored, 'create');
  persistAll();
  return { success: true, assignment: stored };
}

/**
 * Übernimmt die Eingaben des Nutzers.
 *
 * Speichern ist **nicht** bestätigen. Wer ein Konto einträgt, hat damit noch
 * nichts zugesagt; der Eintrag bleibt prüfbedürftig, bis jemand ausdrücklich
 * bestätigt. Ein stilles Confirm-on-Save wäre genau die Abkürzung, vor der die
 * Confirm-first-Architektur schützt.
 */
export function updateAccountingAssignment(
  id: string,
  input: AccountingAssignmentInput,
): AccountingResult {
  const existing = findById(id);
  if (!existing) return { success: false, errorKey: 'accounting.notFound' };

  const next: AccountingAssignment = {
    ...existing,
    accountNumber: input.accountNumber ?? existing.accountNumber,
    accountLabel: input.accountLabel ?? existing.accountLabel,
    bookingText: input.bookingText ?? existing.bookingText,
    taxTreatment: input.taxTreatment ?? existing.taxTreatment,
    origin: 'manual',
    updatedAt: nowIso(),
  };

  /*
   * War die Kontierung bestätigt und ändert sich etwas fachlich Relevantes,
   * fällt sie auf „zu prüfen" zurück — samt Bestätigungsspur, die damit
   * ungültig wird. Die alte Bestätigung wird nicht still weitergetragen.
   *
   * Ohne fachliche Änderung bleibt sie bestätigt: Wer nur den Dialog öffnet
   * und wieder speichert, soll keine Prüfung auslösen.
   */
  if (existing.status === 'confirmed' && isMaterialAccountingChange(existing, next)) {
    next.status = 'needs_review';
    next.confirmedAt = undefined;
    next.confirmedBy = undefined;
  } else if (input.status && existing.status !== 'confirmed') {
    next.status = input.status;
  }

  const stored = replaceAccountingAssignment(id, next);
  if (!stored) return { success: false, errorKey: 'accounting.notFound' };
  enqueue(stored, 'update');
  persistAll();
  return { success: true, assignment: stored };
}

/**
 * 01H — welcher Vorschlagshinweis gerade noch gilt.
 *
 * `suggestionReason` wird beim Anlegen aus dem Vorschlag übernommen und bleibt
 * als Herkunft gespeichert. Angezeigt wird er aber nur, solange er zum
 * **aktuellen** Stand passt: „Sachkonto bitte eintragen" ist erledigt, sobald
 * ein Sachkonto dasteht — und gilt wieder, wenn es entfernt wird. Bis 01H blieb
 * der Satz stehen, bis die Kontierung bestätigt war.
 *
 * „Vorhanden" heisst dasselbe wie beim Bestätigen: nicht leer.
 */
export function resolveVisibleSuggestionReason(
  assignment: Pick<AccountingAssignment, 'status' | 'suggestionReason' | 'accountNumber'> &
    Partial<Pick<AccountingAssignment, 'taxTreatment'>>,
): string | null {
  if (!assignment.suggestionReason || assignment.status === 'confirmed') return null;
  if (
    assignment.suggestionReason === 'accounting.reason.noAccountCatalog' &&
    assignment.accountNumber.trim()
  ) {
    return null;
  }
  // FINANZ-CORE-01A (WEISS N06) — „Steuer unklar" ist erledigt, sobald die Kontierung eine geklärte Steuer trägt.
  if (
    assignment.suggestionReason === 'accounting.reason.taxUnclear' &&
    isResolvedAccountingTaxTreatment(assignment.taxTreatment)
  ) {
    return null;
  }
  return assignment.suggestionReason;
}

export interface ConfirmAccountingOptions {
  /** Wer bestätigt, soweit ein Nutzerkontext vorliegt. */
  confirmedBy?: string;
  /**
   * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — der aktuelle Steuerstatus des Belegs, soweit
   * der Aufrufer ihn kennt. Die Kontierung folgt ihm; eine abweichende Steuer wird nicht
   * bestätigt.
   */
  sourceTaxTreatment?: AccountingTaxTreatment;
  /**
   * P1-KORREKTURBLOCK A-04 — die Steueraufteilung des Belegs ist offen (Netto/Steuer sind Platzhalter).
   * Dann wird nicht bestätigt: Eine bestätigte Kontierung würde die Platzhalter als Buchung ausgeben.
   */
  sourceTaxSplitOpen?: boolean;
}

// FINANZ-CORE-01A (WEISS-Nacharbeit N06) — eine geklärte Steuerbehandlung; die Regel steht in `accountingCanonical`.
export { isResolvedAccountingTaxTreatment };

/**
 * Die ausdrückliche Bestätigung.
 *
 * Ohne Sachkonto wird abgewiesen — dieselbe Regel steht serverseitig in
 * `validate_workspace_accounting_payload`. Eine bestätigte Kontierung ohne
 * Konto wäre eine grüne Zeile ohne Buchung.
 *
 * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — ebenso ohne geklärte Steuerbehandlung:
 * Eine bestätigte, exportfähige Kontierung mit „unklar" versteckte eine offene
 * Steuerfrage hinter einem grünen Haken. Auch das prüft der Server. Und nicht mit
 * einer anderen Steuer als der des Belegs: Sonst stünde im Export „19 %" an einem
 * Beleg, der selbst noch „unklar" oder „7 %" sagt.
 */
export function confirmAccountingAssignment(
  id: string,
  options: ConfirmAccountingOptions = {},
): AccountingResult {
  const existing = findById(id);
  if (!existing) return { success: false, errorKey: 'accounting.notFound' };

  if (!existing.accountNumber.trim()) {
    return { success: false, errorKey: 'accounting.confirmNeedsAccount' };
  }
  if (!isResolvedAccountingTaxTreatment(existing.taxTreatment)) {
    return { success: false, errorKey: 'accounting.confirmNeedsTax' };
  }
  if (!isAccountingTaxInLineWithSource(existing.taxTreatment, options.sourceTaxTreatment)) {
    return { success: false, errorKey: 'accounting.confirmTaxMismatch' };
  }
  if (options.sourceTaxSplitOpen === true) {
    return { success: false, errorKey: 'accounting.confirmNeedsTaxSplit' };
  }

  const timestamp = nowIso();
  const next: AccountingAssignment = {
    ...existing,
    status: 'confirmed',
    confirmedAt: timestamp,
    confirmedBy: options.confirmedBy,
    updatedAt: timestamp,
  };

  const stored = replaceAccountingAssignment(id, next);
  if (!stored) return { success: false, errorKey: 'accounting.notFound' };
  enqueue(stored, 'update');
  persistAll();
  return { success: true, assignment: stored };
}

/**
 * Setzt eine Kontierung ausdrücklich auf „Klärung nötig".
 *
 * Eine eigene Aktion, damit ein Nutzer einen Zweifel festhalten kann, ohne
 * etwas zu erfinden.
 */
export function markAccountingAssignmentUnclear(id: string): AccountingResult {
  const existing = findById(id);
  if (!existing) return { success: false, errorKey: 'accounting.notFound' };

  const next: AccountingAssignment = {
    ...existing,
    status: 'needs_clarification',
    confirmedAt: undefined,
    confirmedBy: undefined,
    updatedAt: nowIso(),
  };
  const stored = replaceAccountingAssignment(id, next);
  if (!stored) return { success: false, errorKey: 'accounting.notFound' };
  enqueue(stored, 'update');
  persistAll();
  return { success: true, assignment: stored };
}

/** FINANZ-CORE-01A (WEISS-Nacharbeit N06) — was die Kontierung vom Beleg wissen muss. */
export interface AccountingSourceState {
  /** Der aktuelle Steuerstatus des Belegs — die Kontierung folgt ihm. */
  taxTreatment?: AccountingTaxTreatment;
  /** Hat sich der Beleg fachlich geändert? Ohne Angabe: ja. */
  changed?: boolean;
  /** P1-KORREKTURBLOCK A-04 — die Steueraufteilung des Belegs ist offen. Ohne Angabe: nein. */
  taxSplitOpen?: boolean;
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — Stand und Begründung, nachdem die
 * Kontierung dem Beleg gefolgt ist. Eine ungeklärte Steuer geht in die Klärung; eine
 * Bestätigung, die einem anderen Stand galt, fällt; eine andere offene Frage (Gutschrift,
 * ausdrücklich „Klärung nötig") bleibt stehen.
 */
function followSourceStatus(
  existing: AccountingAssignment,
  taxTreatment: AccountingTaxTreatment,
  sourceChanged: boolean,
  taxSplitOpen = false,
): Pick<AccountingAssignment, 'status' | 'suggestionReason' | 'confirmedAt' | 'confirmedBy'> {
  const revoked = { confirmedAt: undefined, confirmedBy: undefined };
  // P1-KORREKTURBLOCK A-04 — offene Steueraufteilung: in die Klärung, eine Bestätigung fällt.
  if (taxSplitOpen) {
    return { status: 'needs_clarification', suggestionReason: 'accounting.reason.taxSplitOpen', ...revoked };
  }
  if (!isResolvedAccountingTaxTreatment(taxTreatment)) {
    return { status: 'needs_clarification', suggestionReason: 'accounting.reason.taxUnclear', ...revoked };
  }
  if (existing.status === 'confirmed') {
    return {
      status: 'needs_review',
      suggestionReason: sourceChanged ? 'accounting.reason.sourceChanged' : 'accounting.reason.sourceTaxChanged',
      ...revoked,
    };
  }
  // A-04 — die Aufteilung ist inzwischen belegt: die Klärung ist erledigt, die Kontierung ist zu prüfen. Eigene
  // Begründung (Abschluss-Rundgang R-05): „nach der Bestätigung geändert“ stimmte nicht — bestätigt war hier nie etwas.
  if (existing.suggestionReason === 'accounting.reason.taxSplitOpen') {
    return { status: 'needs_review', suggestionReason: 'accounting.reason.taxSplitEntered', ...revoked };
  }
  if (existing.status === 'needs_clarification' && existing.suggestionReason !== 'accounting.reason.taxUnclear') {
    return {
      status: existing.status,
      suggestionReason: existing.suggestionReason,
      confirmedAt: existing.confirmedAt,
      confirmedBy: existing.confirmedBy,
    };
  }
  return { status: 'needs_review', suggestionReason: 'accounting.reason.sourceTaxChanged', ...revoked };
}

function followSource(
  existing: AccountingAssignment,
  source: AccountingSourceState,
): AccountingAssignment | null {
  const sourceChanged = source.changed ?? true;
  const taxTreatment = source.taxTreatment ?? existing.taxTreatment;
  const taxFollows = taxTreatment !== existing.taxTreatment;
  const revokes = sourceChanged && existing.status === 'confirmed';
  // P1-KORREKTURBLOCK A-04 — die Klärung folgt der Steueraufteilung in beide Richtungen.
  const splitOpen = source.taxSplitOpen === true;
  const inSplitClarification =
    existing.status === 'needs_clarification' && existing.suggestionReason === 'accounting.reason.taxSplitOpen';
  const splitFollows = splitOpen ? !inSplitClarification : existing.suggestionReason === 'accounting.reason.taxSplitOpen';
  if (!taxFollows && !revokes && !splitFollows) return null;
  const next: AccountingAssignment = {
    ...existing,
    taxTreatment,
    ...followSourceStatus(existing, taxTreatment, sourceChanged, splitOpen),
    updatedAt: nowIso(),
  };
  const stored = replaceAccountingAssignment(existing.id, next);
  if (!stored) return null;
  enqueue(stored, 'update');
  return stored;
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — der Beleg hat sich geändert. Die Kontierung
 * folgt ihm: Sie übernimmt seinen Steuerstatus (eine Steuerwahrheit je Beleg), und hat
 * er sich fachlich geändert (Betrag, Steuerstatus, Datum, Lieferant, Art), fällt eine
 * Bestätigung — sie galt dem alten Stand; die Kontierung steht wieder „zu prüfen" mit
 * einem Hinweis, warum. Gespeichert wird mit der Belegänderung (`persistAll` des Aufrufers).
 */
export function requireAccountingReviewAfterSourceChange(
  sourceType: AccountingSourceType,
  sourceId: string,
  source: AccountingSourceState = {},
): AccountingAssignment | null {
  const existing = getAccountingAssignmentForSource(sourceType, sourceId);
  if (!existing) return null;
  return followSource(existing, source);
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — der ausdrückliche Weg für einen Altbestand,
 * dessen Kontierung eine andere Steuer trägt als der Beleg: die Steuer des Belegs
 * übernehmen. Danach ist die Kontierung zu prüfen (oder zu klären) und neu zu bestätigen.
 */
export function adoptSourceTaxTreatment(
  id: string,
  sourceTaxTreatment: AccountingTaxTreatment,
): AccountingResult {
  const existing = findById(id);
  if (!existing) return { success: false, errorKey: 'accounting.notFound' };
  const stored = followSource(existing, { taxTreatment: sourceTaxTreatment, changed: false });
  if (stored) persistAll();
  return { success: true, assignment: stored ?? existing };
}

/** Der Speicher ist die einzige Quelle; hier wird nichts nachgebaut. */
function findById(id: string): AccountingAssignment | undefined {
  return getAccountingAssignmentById(id);
}
