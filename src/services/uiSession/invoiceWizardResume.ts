/**
 * INVOICE-WIZARD-FULL-SAFE-RESUME-01B — die sicheren Bedienzustände des
 * Rechnungsassistenten für den Neuaufbau nach einem App-Wechsel.
 *
 * Abgrenzung, die diesen Baustein klein hält: Alles fachlich Wesentliche —
 * Positionsmengen, Steuerart, Datumswerte, Skontotext, Rechnungsart — liegt
 * bereits im `InvoiceDraft` und kommt von dort zurück. Hier landet **kein**
 * einziger dieser Werte. Es geht ausschliesslich um die Bedienentscheidung
 * „Vertragsskonto übernehmen: ja/nein", die heute nur im React-Zustand lebt.
 *
 * Bewusst eine ausdrückliche Entscheidung statt einer Ableitung aus
 * `draft.skontoText`: Ein Freitext ist keine belastbare Auswahl. Wer denselben
 * Satz von Hand tippt, hat damit nichts entschieden.
 *
 * Sicherheitskritische Bestätigungen — die §13b-Bestätigung an erster Stelle —
 * gehören hier ausdrücklich **nicht** hinein und werden nie wiederhergestellt.
 */
import type { UiSessionSnapshot } from '../../types/uiSessionSnapshot';

export type ContractSkontoChoice = 'yes' | 'no';

/** Ein Namensraum, damit die Werte nicht mit anderen Seiten kollidieren. */
export const INVOICE_WIZARD_RESUME_KEYS = {
  contractSkontoChoice: 'invoiceWizard.contractSkontoChoice',
  contractSkontoPercent: 'invoiceWizard.contractSkontoPercent',
  contractSkontoDays: 'invoiceWizard.contractSkontoDays',
  draftIdentity: 'invoiceWizard.draftIdentity',
} as const;

/** Genau die strukturellen Merkmale des Angebots — kein Textvergleich. */
export interface ContractSkontoOfferIdentity {
  percent: number;
  days: number;
}

export interface InvoiceWizardResumeContext {
  /** Scope, Workspace, Vorgang und Rechnungsart in einem Wert. */
  draftIdentity: string;
  offer: ContractSkontoOfferIdentity | null;
}

/**
 * MANUAL-INVOICE-UI-01B1A — die Sitzungsidentität eines Entwurfs, kanonisch
 * an einer Stelle.
 *
 * Für Vorgangsentwürfe ist das byteidentisch die bisherige `#`-Verkettung aus
 * `RechnungPage`. Für die Rechnung ohne Auftrag ein JSON-Array mit typisiertem
 * Tupel an der Vorgangsstelle: Es beginnt mit `[`, die Verkettung mit dem
 * Scope-Schlüssel — die beiden Formen können sich nicht überschneiden.
 */
export function buildInvoiceWizardDraftIdentity(locator: {
  sourceScopeKey: string;
  workspaceId: string;
  vorgangId: string | null;
  invoiceType: string;
}): string {
  if (locator.vorgangId === null) {
    return JSON.stringify([
      locator.sourceScopeKey,
      locator.workspaceId,
      ['manual-invoice', 1],
      locator.invoiceType,
    ]);
  }
  return `${locator.sourceScopeKey}#${locator.workspaceId}#${locator.vorgangId}#${locator.invoiceType}`;
}

export type InvoiceWizardStep = 'positions' | 'preview' | 'edit';

/**
 * MANUAL-INVOICE-UI-01B1A — aus `RechnungPage` herausgezogen, unverändert.
 *
 * Ein `?step=` aus der Adresse wird **geprüft**, nicht geglaubt: Ohne
 * Entwurf gibt es nur den Einstieg; die Vorschau setzt eine getroffene
 * Steuerentscheidung voraus; Bearbeiten ist nach Beginn der Finalisierung
 * gesperrt. Gilt für Vorgangs- und freie Entwürfe gleich.
 */
export function resolveResumableInvoiceWizardStep(input: {
  requested: InvoiceWizardStep | null;
  hasDraft: boolean;
  taxDecisionSettled: boolean;
  finalizationLocked: boolean;
}): InvoiceWizardStep {
  const { requested, hasDraft, taxDecisionSettled, finalizationLocked } = input;
  if (!requested || requested === 'positions' || !hasDraft) return 'positions';
  if (requested === 'preview') return taxDecisionSettled ? 'preview' : 'positions';
  return taxDecisionSettled && !finalizationLocked ? 'edit' : 'positions';
}

/**
 * Die sicheren Werte für die laufende Sitzung. Ohne Vertragsangebot gibt es
 * nichts zu merken — dann bleibt der Ablagebereich leer.
 */
export function buildInvoiceWizardResumeValues(
  context: InvoiceWizardResumeContext & { choice: ContractSkontoChoice },
): Record<string, string | number | boolean | null> {
  if (!context.offer) return {};
  return {
    [INVOICE_WIZARD_RESUME_KEYS.contractSkontoChoice]: context.choice,
    [INVOICE_WIZARD_RESUME_KEYS.contractSkontoPercent]: context.offer.percent,
    [INVOICE_WIZARD_RESUME_KEYS.contractSkontoDays]: context.offer.days,
    [INVOICE_WIZARD_RESUME_KEYS.draftIdentity]: context.draftIdentity,
  };
}

/**
 * Was darf aus dem Schnappschuss zurückkommen?
 *
 * `null` heisst „nichts Belastbares gefunden" — der Aufrufer bleibt dann beim
 * Ausgangszustand. Zurückgewiesen wird alles, was zu einem anderen fachlichen
 * Zusammenhang gehört: anderer Entwurf, anderer Vorgang, andere Rechnungsart,
 * oder ein Vertragsangebot mit anderem Prozentsatz bzw. anderer Frist. Ein
 * nachträglich geänderter Vertrag darf eine alte Zustimmung nicht erben.
 */
export function readInvoiceWizardContractSkontoChoice(
  snapshot: UiSessionSnapshot | null,
  context: InvoiceWizardResumeContext,
): ContractSkontoChoice | null {
  if (!snapshot || !context.offer) return null;
  const values = snapshot.drafts?.values;
  if (!values) return null;

  if (values[INVOICE_WIZARD_RESUME_KEYS.draftIdentity] !== context.draftIdentity) return null;
  if (values[INVOICE_WIZARD_RESUME_KEYS.contractSkontoPercent] !== context.offer.percent) {
    return null;
  }
  if (values[INVOICE_WIZARD_RESUME_KEYS.contractSkontoDays] !== context.offer.days) return null;

  const choice = values[INVOICE_WIZARD_RESUME_KEYS.contractSkontoChoice];
  return choice === 'yes' || choice === 'no' ? choice : null;
}
