/**
 * EINRICHTUNG-01 (App-Eigenprüfung; Vertrag 1.31, E-9) — Notfall-Importseite `/local-recovery/import` (Zielsicherung
 * und Quarantäne) und ihr Einstieg auf `/local-recovery`. Die deutschen Texte sind unverändert die bisherigen festen
 * Texte der Seite; technische Werte (Schlüssel, Prüfsummen, Gründe aus den Notfalldiensten) bleiben unübersetzt.
 */
export const deLocalRecoveryImport = {
  'localRecovery.importLink': 'Zielsicherung und Quarantäne vorbereiten',
  'localRecovery.importNote':
    'Der Link öffnet eine getrennte Notfallseite. Dort wird ausschließlich der vorhandene lokale Bestand gesichert und quarantänisiert — es wird nichts importiert und nichts ersetzt.',
  'localRecoveryImport.title': 'Zielsicherung und Quarantäne',
  'localRecoveryImport.intro':
    'Diese Seite sichert ausschließlich den vorhandenen lokalen Bestand dieser Adresse und legt eine örtliche Quarantänekopie an. Es wird nichts importiert, nichts ersetzt und kein Cloud-Abgleich gestartet.',
  'localRecoveryImport.label.origin': 'Adresse',
  'localRecoveryImport.markers.title': 'Vorhandene Quarantänevorgänge',
  'localRecoveryImport.label.status': 'Status',
  'localRecoveryImport.label.token': 'Kennung',
  'localRecoveryImport.label.storageKey': 'Speicherschlüssel',
  'localRecoveryImport.markers.note':
    'Vorhandene Vorgänge werden hier nur angezeigt. Diese Seite entfernt niemals einen Marker, eine Hülle oder eine Datei.',
  'localRecoveryImport.step1.title': '1. Zielbereich auswählen',
  'localRecoveryImport.step1.hint':
    'Es wird nichts vorausgewählt. Wählen Sie den Bereich ausdrücklich aus — auch dann, wenn nur einer angeboten wird.',
  'localRecoveryImport.noTargets': 'Auf dieser Adresse liegt kein gültiger Arbeitsbereich.',
  'localRecoveryImport.label.workspace': 'Arbeitsbereich',
  'localRecoveryImport.value.unknown': 'unbekannt',
  'localRecoveryImport.label.setupCompany': 'Firma (Einrichtung)',
  'localRecoveryImport.value.none': 'ohne Angabe',
  'localRecoveryImport.label.profileCompany': 'Firma (Profil)',
  'localRecoveryImport.label.savedAt': 'Gespeichert am',
  'localRecoveryImport.label.counts': 'Vorgänge / Dokumente',
  'localRecoveryImport.label.selected': 'Gewählter Bereich',
  'localRecoveryImport.resumed.text':
    'Die Seite wurde nach dem Herunterladen der Sicherung verworfen. Zielbereich und erwartete Prüfsumme sind bekannt geblieben. Es wurde nichts quarantänisiert und nichts geschrieben.',
  'localRecoveryImport.label.expectedArchiveSha': 'Erwartetes Archiv-SHA-256',
  'localRecoveryImport.label.backupFilename': 'Dateiname der Sicherung',
  'localRecoveryImport.label.targetSavedAt': 'Stand des Zielbereichs',
  'localRecoveryImport.resumed.hint':
    'Die heruntergeladene Datei kann anhand dieser Prüfsumme verglichen werden. Für die Quarantäne muss die Sicherung erneut vorbereitet, die Datei erneut ausgewählt und die Quarantäne erneut bestätigt werden — die vorherige Bestätigung gilt nicht weiter.',
  'localRecoveryImport.staging.blocked':
    'Für diesen Bereich läuft bereits ein unvollständiger Quarantänevorgang. Er wird hier nur angezeigt und nicht angetastet.',
  'localRecoveryImport.label.startedAt': 'Begonnen am',
  'localRecoveryImport.label.archiveSha': 'Archiv-SHA-256',
  'localRecoveryImport.label.expectedFiles': 'Erwartete Dateien',
  'localRecoveryImport.step2.action': '2. Zielsicherung erzeugen',
  'localRecoveryImport.label.files': 'Dateien',
  'localRecoveryImport.step3.action': '3. Sicherung herunterladen',
  'localRecoveryImport.fileInput.label': 'Die soeben heruntergeladene Zielsicherung erneut auswählen',
  'localRecoveryImport.reselect.hint':
    'Nicht die wiederherzustellende Sicherung. In diesem Schritt wird nichts importiert.',
  'localRecoveryImport.step4.action': '4. Die soeben heruntergeladene Zielsicherung erneut auswählen',
  'localRecoveryImport.verify.result':
    'Die gewählte Datei stimmt vollständig mit der erzeugten Sicherung überein: Archivprüfwert, Rohzustandsprüfwert, Bereich, Zeitpunkt und alle {count} Dateiprüfwerte.',
  'localRecoveryImport.step5.action': '5. Lokale Quarantänekopie anlegen',
  'localRecoveryImport.quarantine.busy': 'Die Quarantänekopie wird angelegt. Bitte diese Seite nicht schließen.',
  'localRecoveryImport.report.title': 'Abschlussbericht',
  'localRecoveryImport.label.targetStorageKey': 'Ziel-Speicherschlüssel',
  'localRecoveryImport.label.targetScopeKey': 'Ziel-Bereichsschlüssel',
  'localRecoveryImport.label.rawSha': 'Rohzustands-SHA-256',
  'localRecoveryImport.label.quarantineToken': 'Quarantäne-Kennung',
  'localRecoveryImport.label.markerKey': 'Marker-Schlüssel',
  'localRecoveryImport.label.stateKey': 'Hüllen-Schlüssel',
  'localRecoveryImport.label.quarantineScopeKey': 'Quarantäne-Dateibereich',
  'localRecoveryImport.label.completedAt': 'Zeitpunkt',
  'localRecoveryImport.label.fileRefId': 'FileRef-ID',
  'localRecoveryImport.label.dataKey': 'Datenschlüssel',
  'localRecoveryImport.label.mimeType': 'MIME-Typ',
  'localRecoveryImport.label.size': 'Größe',
  'localRecoveryImport.value.bytes': '{size} Byte',
  'localRecoveryImport.label.sha256': 'SHA-256',
  'localRecoveryImport.report.note':
    'Die lokale Zielsicherung wurde quarantänisiert. Es wurde nichts importiert, nichts ersetzt und kein Cloud-Abgleich gestartet.',
  'localRecoveryImport.targetChangeWarning':
    'Während des Vorgangs oder danach wurde eine Änderung am Zielbereich oder ein weiterer Quarantänevorgang für dieses Ziel erkannt. Dieser Stand ist für keinen weiteren Schritt freigegeben. Beginnen Sie später vollständig neu.',
  'localRecoveryImport.readonlyNote':
    'Diese Seite führt keinen Import durch, ersetzt keinen Bestand, entfernt keinen Quarantänevorgang, startet keine Synchronisierung und wechselt nicht in die normale Anwendung.',
  'localRecoveryImport.msg.stagingCreated':
    'Für diesen Bereich wurde inzwischen ein unvollständiger Quarantänevorgang angelegt. Der vorbereitete Stand wurde verworfen.',
  'localRecoveryImport.msg.targetChangedElsewhere':
    'Der Zielbereich wurde von einer anderen Ansicht verändert. Der Vorgang wurde verworfen. Bitte wählen Sie den Bereich erneut ausdrücklich aus.',
  'localRecoveryImport.msg.confirmBeforeBackupFailed':
    'Die Anmeldung ließ sich vor der Sicherung nicht bestätigen. Es wurde nichts erzeugt.',
  'localRecoveryImport.msg.prepareFailedReason': 'Die Zielsicherung konnte nicht erzeugt werden: {reason}',
  'localRecoveryImport.msg.prepareFailed': 'Die Zielsicherung konnte nicht erzeugt werden.',
  'localRecoveryImport.msg.downloadFailed':
    'Der Download konnte nicht ausgelöst werden. Es wurde nichts gespeichert — bitte erneut versuchen.',
  'localRecoveryImport.msg.reselectMismatch':
    'Die gewählte Datei ist nicht die soeben erzeugte Zielsicherung ({reason}). Es wurde nichts gespeichert und nichts importiert. Bitte erzeugen Sie die Sicherung erneut.',
  'localRecoveryImport.msg.reselectUnreadable':
    'Die gewählte Datei konnte nicht gelesen werden. Es wurde nichts gespeichert.',
  'localRecoveryImport.msg.confirmBeforeQuarantineFailed':
    'Die Anmeldung ließ sich vor der Quarantäne nicht bestätigen. Es wurde nichts verändert.',
  'localRecoveryImport.msg.quarantineFailedReason': 'Die Quarantänekopie wurde nicht angelegt: {reason}',
  'localRecoveryImport.msg.quarantineFailed': 'Die Quarantänekopie wurde nicht angelegt.',
  'localRecoveryImport.msg.targetChangedSinceBackup':
    'Der lokale Zielbestand hat sich seit der letzten Sicherung verändert. Der Ablauf beginnt neu.',
} as const;
