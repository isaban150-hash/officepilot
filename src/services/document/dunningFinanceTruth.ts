/**
 * EINGANG-02B — eine eingehende Mahnung neben der vorhandenen Finanzwahrheit.
 *
 * Verbindet nur, was schon da ist: den Bezug aus
 * `documentFinanceReferenceService` (Rechnungsnummer + Lieferant, Betrag nur
 * stützend) mit dem Zahlungsstand der Ausgabe (`Expense.payments`, bestehende
 * Berechnung) und mit dem, was die Mahnung selbst nennt (Kern, `dunning`).
 *
 * Nur lesen: keine Ausgabe, keine Zahlung, kein Zahlungsstatus, keine
 * Bestätigung eines Bezugs, keine Bewertung, ob die Mahnung berechtigt ist.
 * Einen Bankabgleich gibt es in OfficeTakt nicht — er wird nie behauptet.
 */
import type { DocumentSemanticCore, SemanticDunningStage } from '../../types/documentSemanticCore';
import type { InboxItem } from '../../types/models';
import {
  isFinanceReferenceOnlyKind,
  resolveDocumentFinanceReference,
  type DocumentFinanceMatchStatus,
} from '../documentFinanceReferenceService';

/**
 * open — Bezug sicher, in OfficeTakt offen;
 * paid — Bezug sicher, in OfficeTakt als bezahlt markiert;
 * partially_paid — Bezug sicher, teilweise bezahlt;
 * reference_unclear — kein sicherer Bezug (nicht gefunden, mehrdeutig, Widerspruch);
 * court — gerichtlicher Mahnbescheid (Stufe geht vor).
 */
export type DunningFinanceState = 'open' | 'paid' | 'partially_paid' | 'reference_unclear' | 'court';

export interface DunningFinanceTruth {
  state: DunningFinanceState;
  stage?: SemanticDunningStage;
  referenceStatus: DocumentFinanceMatchStatus;
  /** Die Rechnungsnummer der zugeordneten Ausgabe (nur bei sicherem Bezug). */
  invoiceNumber?: string;
  /** Betrag der bestehenden Rechnung, bezahlter und offener Betrag laut OfficeTakt. */
  invoiceGross?: number;
  paidAmount?: number;
  openAmount?: number;
  /** Was die Mahnung fordert: beschriftete Gesamtforderung, sonst der erkannte Betrag. */
  claimAmount?: number;
  principalAmount?: number;
  reminderFees?: number;
  interestAmount?: number;
  totalClaim?: number;
}

const SICHERER_BEZUG: ReadonlySet<DocumentFinanceMatchStatus> = new Set(['exact', 'paid_conflict', 'already_linked']);

export function resolveDunningFinanceTruth(
  item: InboxItem,
  semantic: DocumentSemanticCore | null | undefined,
): DunningFinanceTruth | null {
  if (!isFinanceReferenceOnlyKind(item.classifiedKind)) return null;
  const reference = resolveDocumentFinanceReference(item);
  const dunning = semantic?.dunning;
  const claimAmount = dunning?.totalClaim ?? reference.documentAmount ?? undefined;
  const matched = SICHERER_BEZUG.has(reference.status) ? reference.matched : null;
  const sicher = Boolean(matched && matched.paymentStatus !== 'storniert');

  let state: DunningFinanceState;
  if (dunning?.stage === 'court_dunning') state = 'court';
  else if (!sicher || !matched) state = 'reference_unclear';
  else if (matched.paidAmount > 0 && matched.openAmount <= 0) state = 'paid';
  else if (matched.paidAmount > 0) state = 'partially_paid';
  else state = 'open';

  return {
    state,
    ...(dunning?.stage ? { stage: dunning.stage } : {}),
    referenceStatus: reference.status,
    ...(sicher && matched
      ? {
          invoiceNumber: matched.invoiceNumber,
          invoiceGross: matched.grossAmount,
          paidAmount: matched.paidAmount,
          openAmount: matched.openAmount,
        }
      : {}),
    ...(claimAmount !== undefined && claimAmount !== null ? { claimAmount } : {}),
    ...(dunning?.principalAmount !== undefined ? { principalAmount: dunning.principalAmount } : {}),
    ...(dunning?.reminderFees !== undefined ? { reminderFees: dunning.reminderFees } : {}),
    ...(dunning?.interestAmount !== undefined ? { interestAmount: dunning.interestAmount } : {}),
    ...(dunning?.totalClaim !== undefined ? { totalClaim: dunning.totalClaim } : {}),
  };
}

const EURO = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
export function formatDunningAmount(value: number): string {
  return EURO.format(value);
}
