/**
 * GO-LIVE-SECURITY-01 — verbindliche Aktionen an Rechnungen und Dokumenten.
 *
 * Mitglieder bereiten vor; den Versand vermerken, den Leistungszeitraum
 * bestätigen und Dokumente löschen dürfen nur Inhaber und Verwaltung. Die
 * Texte stehen dort, wo sonst die Aktion stünde, und erklären nach einer
 * Abweisung, warum sich nichts geändert hat.
 */
export const deWorkspaceRole = {
  'invoice.sent.roleHint': 'Den Versand vermerken oder korrigieren nur Inhaber und Verwaltung.',
  'invoice.sent.error.forbidden':
    'Den Versand vermerken nur Inhaber und Verwaltung. Die Rechnung bleibt unverändert.',
  'invoice.sent.roleAligned':
    'Ein Versandvermerk auf diesem Gerät war nicht freigegeben. Die Rechnung zeigt wieder den Stand der Cloud.',
  'invoice.servicePeriodRoleHint':
    'Den Leistungszeitraum bestätigen nur Inhaber und Verwaltung. Bis dahin bleiben PDF und Druck gesperrt.',
  'invoice.servicePeriodConfirmForbidden':
    'Den Leistungszeitraum bestätigen nur Inhaber und Verwaltung. Die Bestätigung wurde nicht übernommen, PDF und Druck bleiben gesperrt.',
  'invoice.servicePeriodRoleAligned':
    'Eine Bestätigung des Leistungszeitraums auf diesem Gerät war nicht freigegeben und wurde zurückgenommen. PDF und Druck bleiben gesperrt, bis Inhaber oder Verwaltung bestätigen.',
  'invoice.output.verifying':
    'Die Bestätigung des Leistungszeitraums wird mit der Cloud abgeglichen. Druck und PDF sind gleich danach möglich.',
  'invoice.output.unverified':
    'Die Bestätigung des Leistungszeitraums ließ sich nicht mit der Cloud abgleichen. Druck, PDF und ZUGFeRD sind erst danach möglich – bitte mit Internetverbindung erneut prüfen.',
  'invoice.output.retry': 'Erneut prüfen',
  'document.delete.roleHint': 'Dokumente löschen nur Inhaber und Verwaltung.',
  'document.delete.forbidden': 'Dokumente löschen nur Inhaber und Verwaltung. Das Dokument bleibt erhalten.',
  /*
   * GO-LIVE-SECURITY-01 / ABSCHLUSS — Geld und Buchhaltung: Zahlungen, Storno,
   * Kontierung, Monatsabschluss und Ausgaben. Der Server weist Mitglieder ab
   * (finance_forbidden_role); die Oberfläche bietet die Aktion deshalb gar nicht
   * erst an, statt einen Scheinerfolg zu zeigen.
   */
  'invoice.finance.roleHint': 'Zahlungen erfassen und Rechnungen stornieren nur Inhaber und Verwaltung.',
  'invoice.approve.roleHint':
    'Rechnungen freigeben nur Inhaber und Verwaltung. Der Entwurf bleibt gespeichert und kann dort freigegeben werden.',
  'payment.forbidden': 'Zahlungen erfassen nur Inhaber und Verwaltung. Es wurde nichts gebucht.',
  'payment.roleReverted':
    'Die Cloud hat die Zahlung nicht angenommen: Es fehlt die Berechtigung oder die Freigabe des Kontos. Die Zahlung wurde auf diesem Gerät zurückgenommen.',
  'accounting.roleHint': 'Kontieren nur Inhaber und Verwaltung.',
  'accounting.period.roleHint': 'Monate abschließen und wieder öffnen nur Inhaber und Verwaltung.',
  'expense.roleHint': 'Ausgaben erfassen, ändern und bezahlen nur Inhaber und Verwaltung.',
  'invoice.print.blockedNotice':
    'Diese Rechnung kann derzeit nicht gedruckt werden: Druck und PDF sind gesperrt, bis die Hinweise auf der Rechnungsseite erledigt sind (etwa die Bestätigung des Leistungszeitraums durch Inhaber oder Verwaltung).',
} as const;
