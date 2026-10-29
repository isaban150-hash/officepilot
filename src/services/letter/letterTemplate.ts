import type { CompanyProfile } from '../../types/models';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.21, V-01.4) — Vorbelegung des Brieftexts für einen **neuen** Brief aus Anrede und
 * Grußformel des Betriebs („Einstellungen › Dokumente und Zahlungen › Briefe“). Zwischen beiden bleibt Platz für den
 * eigentlichen Text. Ohne Vorgaben bleibt der Text leer; bestehende Briefe und Vorbelegungen aus einer Antwort ändern
 * sich nicht.
 */
export function buildLetterBodyTemplate(profile: Pick<CompanyProfile, 'letterSalutation' | 'letterClosing'>): string {
  const salutation = (profile.letterSalutation ?? '').trim();
  const closing = (profile.letterClosing ?? '').trim();
  if (!salutation && !closing) return '';
  if (!closing) return `${salutation}\n\n`;
  if (!salutation) return `\n\n${closing}`;
  return `${salutation}\n\n\n\n${closing}`;
}
