import type { TranslationKey } from '../../i18n';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.21, V-06.2) — die Fehler der beiden Nummernkreis-RPCs aus FINANZ-CORE-01A
 * (`set_workspace_invoice_number_format`, `set_workspace_invoice_number_start`) als übersetzter Text. Nie der Rohcode.
 * Die RPCs selbst bleiben unverändert.
 */
export function invoiceNumberRangeErrorKey(message: string | null | undefined): TranslationKey {
  const text = message ?? '';
  if (/license|lizenz/i.test(text)) return 'settings.numberRanges.error.license';
  if (/account_blocked|account_not_approved|session_not_active|Nicht angemeldet/i.test(text)) return 'settings.numberRanges.error.account';
  if (/forbidden_role|Keine Schreibberechtigung|Kein Zugriff|forbidden/i.test(text)) return 'settings.numberRanges.error.role';
  if (/invoice_number_start_locked|number_start_locked|gesperrt|locked/i.test(text)) return 'settings.numberRanges.error.locked';
  if (/Versionskonflikt|version_conflict/i.test(text)) return 'settings.numberRanges.error.conflict';
  if (/number_start_unsupported|PGRST202/i.test(text)) return 'settings.numberRanges.error.unsupported';
  if (/invalid|ungueltig|ungültig/i.test(text)) return 'settings.numberRanges.error.invalid';
  if (/network|fetch|Netz/i.test(text)) return 'settings.numberRanges.error.network';
  return 'settings.numberRanges.error.failed';
}
