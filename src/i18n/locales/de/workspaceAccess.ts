/**
 * EINRICHTUNG-01 (AP1) — Betriebslizenz und Zugang.
 *
 * Nur-Lesen (Vertrag 1.3, E5): Die Lizenz gehört dem Inhaber des Betriebs. Ist sie nicht wirksam, bleibt alles
 * lesbar; gespeicherte Dateien lassen sich herunterladen und drucken, Inhaber und Admins können sichern. Die Texte
 * sagen je Rolle, was geht und wer es ändern kann.
 *
 * Keine Lizenz für einen eigenen Betrieb (Z-03.1): ein Hinweis mit nächstem Schritt statt einer Einrichtung, deren
 * Eingaben nicht gespeichert werden könnten.
 */
export const deWorkspaceAccess = {
  'workspaceAccess.readOnly.title': 'Nur-Lesen',
  'workspaceAccess.readOnly.owner':
    'Die Lizenz Ihres Betriebs ist nicht wirksam. Sie können alles ansehen, gespeicherte Dateien herunterladen und drucken und eine Datensicherung erstellen. Ändern, Senden und neue Belege sind erst nach der Verlängerung wieder möglich.',
  'workspaceAccess.readOnly.admin':
    'Die Lizenz dieses Betriebs ist nicht wirksam. Sie können alles ansehen, gespeicherte Dateien herunterladen und drucken und eine Datensicherung erstellen. Ändern und Senden sind wieder möglich, sobald der Inhaber die Lizenz verlängert hat.',
  'workspaceAccess.readOnly.member':
    'Die Lizenz dieses Betriebs ist nicht wirksam. Sie können alles ansehen und gespeicherte Dateien herunterladen und drucken. Ändern und Senden sind wieder möglich, sobald der Inhaber die Lizenz verlängert hat.',
  'workspaceAccess.readOnly.control': 'Im Nur-Lesen-Betrieb nicht verfügbar.',
  'workspaceAccess.readOnly.settings':
    'Die Lizenz des Betriebs ist nicht wirksam. Die Einstellungen lassen sich ansehen, aber erst nach der Verlängerung wieder ändern.',
  'workspaceAccess.readOnly.route':
    'Hier werden Daten angelegt oder geändert. Solange die Lizenz des Betriebs nicht wirksam ist, steht diese Seite nicht zur Verfügung.',
  'workspaceAccess.readOnly.home': 'Zur Startseite',
  'workspaceAccess.noLicense.title': 'Noch kein Betrieb',
  'workspaceAccess.noLicense.body':
    'Ihr Konto ist freigegeben, für einen eigenen Betrieb fehlt aber noch eine Lizenz. Es wurde nichts angelegt.',
  'workspaceAccess.noLicense.next':
    'Nächster Schritt: Folgen Sie der Einladung in einen bestehenden Betrieb, oder bitten Sie um eine Lizenz für Ihren eigenen Betrieb. Danach prüfen Sie hier erneut.',
  'workspaceAccess.noLicense.retry': 'Erneut prüfen',
  'workspaceAccess.noLicense.logout': 'Abmelden',
} as const;
