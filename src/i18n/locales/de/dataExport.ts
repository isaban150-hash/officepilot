/** EINRICHTUNG-01 (AP7; Vertrag 1.24) — „Daten › Export“: lesbarer Datenexport. */
export const deDataExport = {
  'dataExport.subtitle': 'Alle Daten dieses Betriebs lesbar als ZIP-Datei: Tabellen (CSV), Originaldateien und gespeicherte PDFs.',
  'dataExport.intro':
    'Der Export ist für Menschen und andere Programme gedacht. Er ist keine Sicherung zum Wiederherstellen und kein Steuerberater-Paket; er setzt keinen Abschluss- oder Übergabestatus.',
  'dataExport.local': 'Lokaler Betrieb ohne Cloud: Der Export enthält die Daten auf diesem Gerät.',
  'dataExport.notAllowed': 'Den Export können nur Inhaber und Administratoren dieses Betriebs erstellen.',
  'dataExport.prepare': 'Vollständigkeit prüfen',
  'dataExport.prepare.hint':
    'Die Prüfung lädt den aktuellen Stand vom Server und alle Dateien. Offene Änderungen sendet sie nicht; sie nennt sie.',
  'dataExport.cancel': 'Abbrechen',
  'dataExport.progress.binding': 'Konto, Betrieb und Rolle werden geprüft …',
  'dataExport.progress.pull': 'Aktueller Stand wird vom Server geladen …',
  'dataExport.progress.check': 'Vollständigkeit wird geprüft …',
  'dataExport.progress.files': 'Dateien: {done} von {total}',
  'dataExport.progress.emails': 'Gesendete E-Mails und Anhänge: {done} von {total}',
  'dataExport.progress.csv': 'Tabellen werden erstellt …',
  'dataExport.progress.zip': 'ZIP-Datei wird erstellt: {done} %',
  'dataExport.progress.download': 'Download wird gestartet …',
  'dataExport.result.complete': 'Die Prüfung ist ohne Befund: Der Export ist vollständig.',
  'dataExport.result.gaps': 'Der Export wäre unvollständig. Die Prüfung hat diese Lücken gefunden:',
  'dataExport.result.gapsHint':
    'Sie können die Lücken zuerst beheben (etwa auf der Seite Synchronisation) oder einen ausdrücklich unvollständigen Export mit Lückenliste erstellen.',
  'dataExport.result.syncLink': 'Zur Synchronisation',
  'dataExport.result.size': 'Voraussichtliche Größe: {size}',
  'dataExport.sizeWarning':
    'Der Export ist größer als etwa 1 GB. Er entsteht im Browser und kann lange dauern oder auf diesem Gerät scheitern.',
  'dataExport.create': 'Export erstellen',
  'dataExport.createWithGaps': 'Export mit Lückenliste erstellen',
  'dataExport.success':
    'Der Download wurde gestartet: {name}. Bitte prüfen Sie, ob die Datei in Ihrem Download-Ordner angekommen ist.',
  'dataExport.successIncomplete':
    'Der Download des unvollständigen Exports wurde gestartet: {name}. Die Lücken stehen in luecken.csv und in der Übersicht.',
  'dataExport.cancelled': 'Der Export wurde abgebrochen. Es wurde keine Datei erstellt.',
  'dataExport.bindingChanged':
    'Der Export wurde abgebrochen, weil sich Konto, Betrieb oder Rolle geändert haben. Es wurde keine Datei erstellt.',
  'dataExport.failed': 'Der Export konnte nicht erstellt werden. Es wurde keine Datei erstellt. Bitte erneut versuchen.',
  'dataExport.gap.sync_open': 'Offene Änderungen: {count}',
  'dataExport.gap.sync_rejected': 'Abgewiesene Änderungen: {count}',
  'dataExport.gap.sync_held': 'Zurückgehaltene Änderungen: {count}',
  'dataExport.gap.pull_skipped': 'Kein frischer Abzug vom Server, weil zuerst offene Änderungen abgeglichen werden müssen.',
  'dataExport.gap.pull_failed': 'Der aktuelle Stand konnte nicht vollständig vom Server geladen werden.',
  'dataExport.gap.persist_failed': 'Das letzte Speichern auf diesem Gerät ist gescheitert.',
  'dataExport.gap.file_unavailable': 'Datei nicht verfügbar: {detail}',
  'dataExport.gap.finance_unconfirmed': 'Finanzzustand nicht bestätigt: {detail}',
  'dataExport.gap.emails_unavailable': 'Die gesendeten E-Mails konnten nicht geladen werden.',
  'dataExport.gap.emails_truncated': 'Nur die 500 neuesten gesendeten E-Mails sind enthalten; ältere fehlen.',
} as const;
