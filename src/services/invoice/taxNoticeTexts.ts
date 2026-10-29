/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.21, V-02) — der eine Standardhinweis für steuerfreie Leistungen.
 *
 * Eine Quelle für die Vorbelegung neuer Profile (`DEFAULT_COMPANY_PROFILE.taxFreeNotice`) und den Rückfall auf
 * Rechnungen und Angeboten (`buildLegalNotices`): ein eigener Text des Betriebs geht vor, sonst gilt dieser.
 *
 * Bisher gab es zwei Fassungen: die Profilvorgabe „Die Leistung ist ohne Umsatzsteuer.“ und den Rückfall „Die Leistung
 * ist steuerfrei bzw. ohne Umsatzsteuer.“. Gilt jetzt nur noch die Profilvorgabe (sie tragen die meisten Profile); die
 * zweite Fassung wird weiter als Standardhinweis erkannt, damit ein älterer Entwurf beim Wechsel des Steuerstatus
 * richtig bereinigt wird. Freigegebene Belege behalten ihre Hinweise (FINANZ-CORE-01A).
 */
export const STANDARD_TAX_FREE_NOTICE = 'Die Leistung ist ohne Umsatzsteuer.';

export const LEGACY_TAX_FREE_NOTICES: readonly string[] = ['Die Leistung ist steuerfrei bzw. ohne Umsatzsteuer.'];

/** Ein Text, der nur die Standardfassung (heute oder früher) ist, gilt nicht als eigener Hinweis. */
export function isStandardTaxFreeNotice(value: string | undefined | null): boolean {
  const text = (value ?? '').trim();
  return text === STANDARD_TAX_FREE_NOTICE || LEGACY_TAX_FREE_NOTICES.includes(text);
}
