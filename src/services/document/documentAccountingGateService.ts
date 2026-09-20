/**
 * DOKUMENTVERSTAENDNIS-01B — die Buchungsschranke. P0.
 *
 * Bis hierher war der Schutz vor einer falschen Buchung **artenbasiert**: eine
 * Positivliste mit genau zwei Dokumentarten (`mahnung`, `zahlungserinnerung`)
 * in `documentFinanceReferenceService`. Alles andere durfte über
 * `createExpenseFromInbox` zu einer Ausgabe werden.
 *
 * Der Fehler daran ist nicht die Liste, sondern ihre Abhängigkeit: Sie greift
 * nur, wenn die Klassifikation stimmt — und genau die versagt bei unbekannten
 * Schreiben. Eine Mängelanzeige mit dem Satz „behalten wir 5.000,00 EUR ein"
 * wurde als „Sonstiges" erkannt und war damit vom Schutz nicht erfasst.
 *
 * Diese Schranke fragt zuerst, was im Text **steht**. Die bisherige Artenliste
 * bleibt bestehen und wird zusätzlich ausgewertet — sie ist jetzt die zweite
 * Verteidigungslinie statt der einzigen. Es entsteht **keine zweite
 * Finanzlogik**: Wo ein Bezug zu einem vorhandenen Beleg richtig ist, führt der
 * Weg unverändert in `documentFinanceReferenceService`.
 */
import type { DocumentSemanticCore } from '../../types/documentSemanticCore';
import { isFinanceReferenceOnlyKind } from '../documentFinanceReferenceService';
import type { ClassifiedDocumentKind } from '../../types/models';

export type AccountingGateDecision =
  /** Keine Buchung. Das Schreiben ist kein Beleg und fordert kein Geld. */
  | 'blocked'
  /** Keine neue Ausgabe — der Bezugsbeleg existiert bereits. */
  | 'reference_only'
  /** Buchung darf vorgeschlagen werden; bestätigt werden muss sie trotzdem. */
  | 'needs_confirmation';

export interface AccountingGateResult {
  decision: AccountingGateDecision;
  /** Warum — in Klartext, für Anzeige und Nachvollziehbarkeit. */
  reasons: string[];
  /** Woher die Entscheidung stammt: aus der Bedeutung oder aus der Dokumentart. */
  source: 'semantic' | 'kind' | 'fallback';
}

export interface AccountingGateInput {
  core?: DocumentSemanticCore | null;
  classifiedKind?: ClassifiedDocumentKind;
}

/**
 * Entscheidet, was mit einem eingegangenen Dokument buchhalterisch geschehen
 * darf. Die Schranke erlaubt nie mehr, als die schwächste Quelle hergibt.
 */
export function resolveAccountingGate(input: AccountingGateInput): AccountingGateResult {
  const { core, classifiedKind } = input;

  /*
   * Die Artenliste zuerst, aber nur in **verschärfender** Richtung: Was sie als
   * Verweisdokument kennt, bleibt eines — auch wenn die Textanalyse grosszügiger
   * wäre. Der bestehende, erprobte Schutz wird dadurch nie schwächer.
   */
  if (isFinanceReferenceOnlyKind(classifiedKind)) {
    return {
      decision: 'reference_only',
      reasons: ['Dieses Schreiben verweist auf einen bereits vorhandenen Beleg.'],
      source: 'kind',
    };
  }

  if (!core) {
    /*
     * Ohne semantischen Kern wird nicht geraten. Buchen bleibt möglich, aber nur
     * mit Bestätigung — das entspricht dem bisherigen Verhalten und macht
     * nichts unsicherer.
     */
    return {
      decision: 'needs_confirmation',
      reasons: ['Der Inhalt liess sich nicht auswerten. Bitte vor dem Buchen selbst prüfen.'],
      source: 'fallback',
    };
  }

  switch (core.accounting.relevance) {
    case 'none':
      return { decision: 'blocked', reasons: core.accounting.reasons, source: 'semantic' };
    case 'reference_only':
      return { decision: 'reference_only', reasons: core.accounting.reasons, source: 'semantic' };
    case 'booking_candidate':
    default:
      return { decision: 'needs_confirmation', reasons: core.accounting.reasons, source: 'semantic' };
  }
}

/**
 * Die eine Frage, die jeder Weg zu einer neuen Ausgabe stellen muss.
 *
 * Bewusst als eigene, winzige Funktion: Sie ist an mehreren Stellen einzusetzen
 * und soll beim Lesen keinen Zweifel lassen, was sie bedeutet.
 */
export function mayCreateExpenseFromDocument(input: AccountingGateInput): boolean {
  return resolveAccountingGate(input).decision === 'needs_confirmation';
}
