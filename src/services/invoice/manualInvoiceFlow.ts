/**
 * MANUAL-INVOICE-UI-01B1B — die fachlichen Regeln des vierschrittigen Flows.
 *
 * Rein: kein React, kein Store. Die Seite ist nur der Container; was hier
 * steht, entscheidet, welcher Schritt erreichbar ist und ob eine Position
 * vollständig ist. Fachliche Daten leben im `InvoiceDraft`, nie nur im
 * Oberflächenzustand.
 */
import type { InvoiceDraft, InvoiceDraftPosition, OrderUnit } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { ORDER_UNITS } from '../orderUnits';
import { buildGlobalInvoiceDetailPath, buildOpenInvoicesPath } from '../invoiceNavigation';

export type ManualInvoiceStep = 'customer' | 'positions' | 'details' | 'review';

export const MANUAL_INVOICE_STEPS: readonly ManualInvoiceStep[] = [
  'customer',
  'positions',
  'details',
  'review',
];

export const MANUAL_INVOICE_ROUTE = '/rechnungen/neu';
export const MANUAL_INVOICE_STEP_PARAM = 'step';

/**
 * MANUAL-INVOICE-UI-01B2 — wohin es nach der Freigabe geht.
 *
 * Auf die globale Detailseite nur, wenn die Rechnung **lokal nachweislich**
 * als freie Rechnung (`vorgangId === null`) im Speicher liegt; das ist der
 * Beweis der lokalen Persistenz, nicht das Ergebnisobjekt des Aufrufs. Fehlt
 * dieser Beweis, führt der Weg auf die Übersicht — nie auf eine Detailseite,
 * die noch nicht sicher existiert.
 */
export function resolveManualInvoicePostFinalizePath(
  invoiceId: string,
  located: { vorgangId: string | null } | undefined,
): string {
  if (located && located.vorgangId === null && invoiceId.trim().length > 0) {
    return buildGlobalInvoiceDetailPath(invoiceId);
  }
  return buildOpenInvoicesPath();
}

export function isManualInvoiceStep(value: string | null): value is ManualInvoiceStep {
  return value !== null && (MANUAL_INVOICE_STEPS as readonly string[]).includes(value);
}

/** V1: Kundenpflicht — ein Entwurf hat einen Kunden, wenn er dessen Kennung trägt. */
export function hasManualInvoiceCustomer(draft: Pick<InvoiceDraft, 'customerId' | 'customerBilling'>): boolean {
  return Boolean(draft.customerId?.trim()) && Boolean(draft.customerBilling?.name?.trim());
}

export type ManualPositionIssue = 'description' | 'quantity' | 'unitPrice' | 'unit';

/**
 * Vollständigkeit einer freien Position. Keine stillen Korrekturen: Was hier
 * fehlt, wird gemeldet, nicht ersetzt. Der Preis darf 0 sein (kostenlose
 * Zeile, wie im Auftragsweg), aber nicht negativ und nicht unendlich.
 */
export function validateManualPosition(
  position: Pick<InvoiceDraftPosition, 'description' | 'quantity' | 'unitPrice' | 'unit'>,
): ManualPositionIssue[] {
  const issues: ManualPositionIssue[] = [];
  if (!position.description.trim()) issues.push('description');
  if (!Number.isFinite(position.quantity) || position.quantity <= 0) issues.push('quantity');
  if (!Number.isFinite(position.unitPrice) || position.unitPrice < 0) issues.push('unitPrice');
  if (!(ORDER_UNITS as readonly string[]).includes(position.unit)) issues.push('unit');
  return issues;
}

export function isValidManualUnit(value: string): value is OrderUnit {
  return (ORDER_UNITS as readonly string[]).includes(value);
}

export function hasCompleteManualPositions(draft: Pick<InvoiceDraft, 'positions'>): boolean {
  return (
    draft.positions.length > 0 &&
    draft.positions.every((position) => validateManualPosition(position).length === 0)
  );
}

/**
 * Bis zu welchem Schritt die Daten tragen. Der Schritt „details" braucht
 * keine eigene Vollständigkeit — die Vorschau prüft über
 * `validateInvoiceDraftForApproval`; erreichbar ist sie, sobald Positionen
 * und Steuerentscheidung stehen.
 */
export function resolveReachableManualStep(input: {
  draft: InvoiceDraft | null;
  taxDecisionSettled: boolean;
}): ManualInvoiceStep {
  const { draft, taxDecisionSettled } = input;
  if (!draft || !hasManualInvoiceCustomer(draft)) return 'customer';
  if (!hasCompleteManualPositions(draft)) return 'positions';
  if (!taxDecisionSettled) return 'details';
  return 'review';
}

/**
 * Ein `?step=` aus der Adresse wird **geprüft**, nicht geglaubt — dieselbe
 * Haltung wie `resolveResumableInvoiceWizardStep`. Ein gesperrter Entwurf
 * (Finalisierung läuft oder ist erledigt) landet in der Vorschau, wo der
 * Zustand erklärt wird.
 */
export function resolveResumableManualStep(input: {
  requested: ManualInvoiceStep | null;
  draft: InvoiceDraft | null;
  taxDecisionSettled: boolean;
  finalizationLocked: boolean;
}): ManualInvoiceStep {
  const reachable = resolveReachableManualStep(input);
  if (input.finalizationLocked && input.draft) return 'review';
  // Ohne Wunsch aus der Adresse: der erste Schritt, der noch etwas braucht.
  if (!input.requested) return reachable;
  return MANUAL_INVOICE_STEPS.indexOf(input.requested) <= MANUAL_INVOICE_STEPS.indexOf(reachable)
    ? input.requested
    : reachable;
}

export function manualStepTitleKey(step: ManualInvoiceStep): TranslationKey {
  return `manualInvoice.step.${step}` as TranslationKey;
}
