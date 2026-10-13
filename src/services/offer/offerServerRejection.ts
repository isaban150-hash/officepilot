/**
 * FINANZ-CORE-01A (ANG-14) — Servertexte der Angebots-RPCs in Nutzersprache.
 *
 * Bisher hing der rohe Servertext in Klammern an der Meldung, etwa
 * „(Versionskonflikt offer:3)" oder die Check-Constraint-Meldung eines
 * Angebotsjahrs vor 2000. Hier wird er einer übersetzten Meldung zugeordnet; ein
 * unbekannter Text fällt auf die allgemeine Meldung des Aufrufers zurück und wird
 * nie gezeigt.
 */
import type { TranslationKey } from '../../i18n';

export type OfferServerAction = 'finalize' | 'accept';

/** Ein Verbindungsfehler (Browser, Supabase-Client), kein fachliches Nein. */
export function isOfferNetworkMessage(message: string): boolean {
  return /Failed to fetch|Network|Load failed/.test(message);
}

/** `navigator.onLine === false` ist verlässlich; `true` heißt nur „vielleicht". */
export function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Der Server kennt einen neueren Stand des Angebots (anderes Gerät). */
export function isOfferVersionConflictMessage(message: string): boolean {
  return /Versionskonflikt/.test(message);
}

type Rule = readonly [RegExp, TranslationKey];

const FINALIZE_RULES: readonly Rule[] = [
  [/Keine Schreibberechtigung|Kein Zugriff|Nicht angemeldet/, 'offer.finalize.forbidden'],
  [/Summen/, 'offer.server.totalsMismatch'],
  [/Steuerstatus/, 'offer.finalize.blocked.tax_status_unclear'],
  [/Kunde/, 'offer.finalize.blocked.customer_missing'],
  [/Betreff/, 'offer.finalize.blocked.title_missing'],
  [/Gueltigkeit/, 'offer.finalize.blocked.valid_until_missing'],
  [/negativer Preis/, 'offer.finalize.blocked.position_invalid'],
  [/Position/, 'offer.finalize.blocked.positions_missing'],
];

const ACCEPT_RULES: readonly Rule[] = [
  [/Keine Schreibberechtigung|Kein Zugriff|Nicht angemeldet/, 'offer.accept.roleHint'],
  [/Zustand|ohne Nummer|ohne Kunden|ohne Positionen/, 'offer.accept.notAcceptable'],
];

const SHARED_RULES: readonly Rule[] = [
  [/year_check|check constraint/i, 'offer.server.dateInvalid'],
  [/geloescht|nicht gefunden/, 'offer.server.deleted'],
];

/** Die übersetzte Meldung zu einem Servertext; `null` für einen unbekannten Text. */
export function offerServerRejectionKey(message: string, action: OfferServerAction): TranslationKey | null {
  const text = message ?? '';
  const rules = [...(action === 'finalize' ? FINALIZE_RULES : ACCEPT_RULES), ...SHARED_RULES];
  for (const [pattern, key] of rules) {
    if (pattern.test(text)) return key;
  }
  return null;
}
