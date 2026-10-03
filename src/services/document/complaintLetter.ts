/**
 * EINGANG-02C Nacharbeit 1 — wann ein Schreiben als Beschwerde gelesen wird.
 *
 * Ein sicherer Beschwerdetitel allein genügt nicht: Trägt das Schreiben einen
 * Behörden- oder Versicherungsbriefkopf (02A-1), bleibt dessen institutionelle
 * Wahrheit maßgeblich — „Beanstandung" vom Bauamt ist ein Behördenschreiben,
 * „Ihre Beschwerde ist eingegangen" vom Finanzamt keine Beschwerde gegen uns.
 * Es gibt keine zweite Institutionserkennung; gelesen wird die aus 02A-1.
 */
import { hasComplaintTitle } from './complaintText';
import { resolveInstitutionalLetterhead } from './institutionalSenderTruth';

/** 02A-1 hat Vorrang: ein sicherer Behörden- oder Versicherungsbriefkopf. */
export function hasInstitutionalPrecedence(text: string, options: { ownCompanyName?: string } = {}): boolean {
  return Boolean(resolveInstitutionalLetterhead(text, options));
}

/** Ein Beschwerdeschreiben: sicherer Beschwerdetitel und kein institutioneller Briefkopf. */
export function isComplaintLetter(text: string, options: { ownCompanyName?: string } = {}): boolean {
  return hasComplaintTitle(text) && !hasInstitutionalPrecedence(text, options);
}
