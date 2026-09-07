/**
 * INVOICE-MOBILE-RESUME-01B — die §13b-Bestätigung überlebt einen App-Wechsel,
 * aber nur für genau diesen unveränderten Entwurf.
 *
 * Realbefund auf iPhone/Safari: Der Nutzer bestätigt §13b, geht in die
 * Vorschau, wechselt kurz zu einer anderen App — und findet nach der Rückkehr
 * wieder die Positionen vor, mit leerer Bestätigung. Ursache war nicht der
 * Entwurf (der liegt in IndexedDB und überlebt), sondern ein einziges
 * `useState(false)`: Ohne bestätigte Steuerentscheidung stuft die
 * Wiederaufnahme `step=preview` auf `positions` zurück **und schreibt diesen
 * Rückfall in die Adresse**. Danach war die Information, dass der Nutzer schon
 * weiter war, endgültig verloren.
 *
 * Dieser Dienst speichert deshalb genau eine Aussage:
 *
 *   „Für Entwurf X mit Inhalt Y hat der Nutzer §13b ausdrücklich bestätigt."
 *
 * **Kein globales Merken.** Die Bestätigung ist an Scope, Workspace, Vorgang,
 * Rechnungsart, `draftId` **und** `draftSha256` gebunden. Weicht auch nur eines
 * davon ab — anderer Entwurf, andere Rechnungsart, geänderter Inhalt,
 * fremder Workspace —, gilt sie als nicht vorhanden und muss neu gegeben
 * werden. Der Hash bindet den gesamten fachlichen Entwurf, weshalb hier keine
 * Teilmenge steuerrelevanter Felder gepflegt wird: Sicherheit vor Komfort.
 *
 * Ausdrücklich **nicht** gespeichert werden: der Schritt (der steht in der
 * Adresse), offene Dialoge, Validierungsergebnisse, Mengen-Zwischenstände,
 * Scrollpositionen — nichts, was sich aus dem Entwurf neu ableiten lässt oder
 * eine halbe Eingabe ist.
 *
 * Der Dienst ist origin- und scope-lokal, schreibt keine Fachdaten, berührt
 * weder Cloud-Payload noch `immutableInvoiceFingerprint` noch das
 * Entwurfsformat — und er **ersetzt keine Freigabeprüfung**. Ob eine
 * §13b-Rechnung tatsächlich hinausgehen darf, entscheidet unverändert
 * `workspaceInvoiceFinalizeRequestValidator`; dieser Dienst stellt lediglich
 * wieder her, was der Nutzer bereits gesagt hat.
 */
import type { InvoiceDocumentType } from '../../types/models';

export const REVERSE_CHARGE_CONFIRMATION_KIND =
  'officepilot-invoice-reverse-charge-confirmation' as const;
export const REVERSE_CHARGE_CONFIRMATION_VERSION = 1 as const;

/** Die Identität, an die eine Bestätigung gebunden ist. */
export interface ReverseChargeConfirmationContext {
  sourceScopeKey: string;
  workspaceId: string;
  vorgangId: string;
  invoiceType: InvoiceDocumentType;
  draftId: string;
  draftSha256: string;
}

export interface ReverseChargeConfirmation extends ReverseChargeConfirmationContext {
  kind: typeof REVERSE_CHARGE_CONFIRMATION_KIND;
  version: typeof REVERSE_CHARGE_CONFIRMATION_VERSION;
  confirmedAt: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Ein Schlüssel je Entwurfskontext — **kein** globaler Eintrag.
 *
 * Ohne diese Trennung könnten sich zwei Rechnungen desselben Vorgangs oder
 * zwei Vorgänge gegenseitig bestätigen. Die `draftId` steht bewusst mit im
 * Schlüssel: Ein neu erzeugter oder duplizierter Entwurf trägt eine andere und
 * findet den Eintrag des alten gar nicht erst.
 */
export function buildReverseChargeConfirmationKey(
  context: Pick<
    ReverseChargeConfirmationContext,
    'sourceScopeKey' | 'vorgangId' | 'invoiceType' | 'draftId'
  >,
): string {
  return [
    REVERSE_CHARGE_CONFIRMATION_KIND,
    context.sourceScopeKey,
    context.vorgangId,
    context.invoiceType,
    context.draftId,
  ].join(':');
}

/** Strenge Formprüfung — ein unvollständiger Eintrag gilt als nicht vorhanden. */
export function isValidReverseChargeConfirmation(
  value: unknown,
): value is ReverseChargeConfirmation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as ReverseChargeConfirmation;
  if (candidate.kind !== REVERSE_CHARGE_CONFIRMATION_KIND) return false;
  if (candidate.version !== REVERSE_CHARGE_CONFIRMATION_VERSION) return false;
  if (!isNonEmptyString(candidate.sourceScopeKey)) return false;
  if (!isNonEmptyString(candidate.workspaceId)) return false;
  if (!isNonEmptyString(candidate.vorgangId)) return false;
  if (!isNonEmptyString(candidate.invoiceType)) return false;
  if (!isNonEmptyString(candidate.draftId)) return false;
  if (!isNonEmptyString(candidate.draftSha256) || !SHA256_HEX.test(candidate.draftSha256)) {
    return false;
  }
  if (!isNonEmptyString(candidate.confirmedAt)) return false;
  return true;
}

function isCompleteContext(context: ReverseChargeConfirmationContext): boolean {
  return (
    isNonEmptyString(context.sourceScopeKey) &&
    isNonEmptyString(context.workspaceId) &&
    isNonEmptyString(context.vorgangId) &&
    isNonEmptyString(context.invoiceType) &&
    isNonEmptyString(context.draftId) &&
    isNonEmptyString(context.draftSha256) &&
    SHA256_HEX.test(context.draftSha256)
  );
}

/**
 * Schreibt die Bestätigung für genau diesen Kontext.
 *
 * Wird ausschliesslich aufgerufen, wenn der Nutzer das Kästchen **selbst**
 * anhakt. Es gibt keinen Pfad, auf dem OfficePilot sie von sich aus setzt.
 */
export function writeReverseChargeConfirmation(
  context: ReverseChargeConfirmationContext,
  now?: string,
): ReverseChargeConfirmation | null {
  if (!isCompleteContext(context)) return null;

  const confirmation: ReverseChargeConfirmation = {
    kind: REVERSE_CHARGE_CONFIRMATION_KIND,
    version: REVERSE_CHARGE_CONFIRMATION_VERSION,
    ...context,
    confirmedAt: now ?? new Date().toISOString(),
  };
  if (!isValidReverseChargeConfirmation(confirmation)) return null;

  try {
    localStorage.setItem(
      buildReverseChargeConfirmationKey(context),
      JSON.stringify(confirmation),
    );
  } catch {
    /*
     * Ohne Speicher bleibt es beim bisherigen Verhalten: Die Bestätigung gilt
     * für diese Sitzung und muss nach einem Neuaufbau erneut gegeben werden.
     * Das ist unbequem, aber niemals unsicher.
     */
    return null;
  }
  return confirmation;
}

/**
 * Gilt die gespeicherte Bestätigung für **genau** diesen Kontext?
 *
 * Jede Abweichung — fehlender Eintrag, fremde Version, anderer Entwurf,
 * geänderter Inhalt, anderer Workspace — führt zu `false`. Es gibt bewusst
 * keinen Zwischenwert und keine Kulanz.
 */
export function hasValidReverseChargeConfirmation(
  context: ReverseChargeConfirmationContext,
): boolean {
  if (!isCompleteContext(context)) return false;

  let raw: string | null;
  try {
    raw = localStorage.getItem(buildReverseChargeConfirmationKey(context));
  } catch {
    return false;
  }
  if (!raw) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isValidReverseChargeConfirmation(parsed)) return false;

  return (
    parsed.sourceScopeKey === context.sourceScopeKey &&
    parsed.workspaceId === context.workspaceId &&
    parsed.vorgangId === context.vorgangId &&
    parsed.invoiceType === context.invoiceType &&
    parsed.draftId === context.draftId &&
    parsed.draftSha256 === context.draftSha256
  );
}

/**
 * Entfernt die Bestätigung dieses Entwurfskontexts.
 *
 * Aufgerufen, wenn der Nutzer das Kästchen abwählt oder den Steuerstatus
 * wechselt. Der Schlüssel hängt nicht am Hash — sonst bliebe nach einer
 * Entwurfsänderung ein verwaister Eintrag zurück, den niemand mehr löschen
 * kann.
 */
export function clearReverseChargeConfirmation(
  context: Pick<
    ReverseChargeConfirmationContext,
    'sourceScopeKey' | 'vorgangId' | 'invoiceType' | 'draftId'
  >,
): void {
  try {
    localStorage.removeItem(buildReverseChargeConfirmationKey(context));
  } catch {
    // Ohne Speicher gibt es nichts zu entfernen.
  }
}
