/** EINRICHTUNG-01 (AP8; Vertrag 1.29; Abschluss 22 zu E-13) — „Daten › Daten auf diesem Gerät“. */
export const deDeviceData = {
  'deviceData.subtitle': 'Was dieses Konto auf diesem Gerät gespeichert hat, und wie Sie es entfernen.',
  'deviceData.local':
    'Im lokalen Betrieb ohne Cloud liegen alle Daten nur auf diesem Gerät. Ein Entfernen ist hier nicht vorgesehen, weil es keine zweite Kopie gibt; sichern Sie Ihre Daten über „Sicherung“.',
  'deviceData.own.title': 'Bestände dieses Kontos',
  'deviceData.own.empty': 'Auf diesem Gerät ist für dieses Konto nichts gespeichert.',
  'deviceData.accountArea': 'Kontobereich ohne Betrieb',
  'deviceData.size': 'Größe: {size}',
  'deviceData.saved': 'Zuletzt gespeichert: {date}',
  'deviceData.lastSync': 'Letzter Abgleich: {date}',
  'deviceData.open': 'Offene Änderungen: {count}',
  'deviceData.rejected': 'Abgewiesene Änderungen: {count}',
  'deviceData.others': 'Weitere Konten mit Daten auf diesem Gerät: {count}. Ihre Daten bleiben beim Entfernen erhalten.',
  'deviceData.remove.title': 'Daten von diesem Gerät entfernen',
  'deviceData.remove.text':
    'Entfernt alle Daten dieses Kontos auf diesem Gerät: gespeicherte Bestände, Dateien, Entwürfe und Zugriffsauskünfte. Danach werden Sie auf diesem Gerät abgemeldet. Ihre Daten in der Cloud bleiben unverändert.',
  'deviceData.remove.ready':
    'Alle Bestände sind in dieser Sitzung vollständig abgeglichen, und nichts liegt nur auf diesem Gerät. Sie können die Daten entfernen.',
  'deviceData.remove.blocked':
    'Auf diesem Gerät liegen Daten, die nicht nachweislich in der Cloud gespeichert sind. Sie werden nicht entfernt, solange das so ist — auch nicht mit einer Sicherungsdatei: Im Cloud-Betrieb lässt sich eine Sicherung derzeit nicht zurückspielen.',
  'deviceData.checking': 'Die Entwürfe auf diesem Gerät werden geprüft …',
  'deviceData.block.unsynced':
    'Nicht abgeglichene oder abgewiesene Änderungen, unbestätigte Zahlungen oder eine begonnene Freigabe. Bitte zuerst abgleichen bzw. die Abweisung klären.',
  'deviceData.block.not_verified':
    'In dieser Sitzung ist kein vollständiger Abgleich dieses Betriebs nachgewiesen, oder er hat sich seitdem geändert. Wechseln Sie zu dem Betrieb und prüfen Sie dort den Abgleich.',
  'deviceData.block.unreadable': 'Der gespeicherte Bestand lässt sich nicht lesen und deshalb nicht prüfen.',
  'deviceData.block.local_only':
    'Daten, die nur auf diesem Gerät geführt und nie abgeglichen werden (Kontobereich ohne Betrieb oder früherer Mailimport).',
  'deviceData.block.draft':
    'Entwürfe, die nur auf diesem Gerät liegen (Rechnung, Upload, Kundenzuordnung, Versand oder Einrichtung). Bitte abschließen oder verwerfen.',
  'deviceData.block.check_failed': 'Die Entwürfe auf diesem Gerät ließen sich nicht prüfen.',
  'deviceData.backup.noUnlock':
    'Sicherung „{name}“ vom {date} liegt vor. Sie ersetzt den Abgleich nicht, weil sie sich im Cloud-Betrieb derzeit nicht zurückspielen lässt.',
  'deviceData.verify.action': 'Abgleich jetzt prüfen',
  'deviceData.verify.hint':
    'Gleicht den aktiven Betrieb vollständig ab und hält fest, dass danach nichts offen ist. Andere Betriebe prüfen Sie nach einem Wechsel zu ihnen.',
  'deviceData.verify.ok': 'Der aktive Betrieb ist vollständig abgeglichen.',
  'deviceData.verify.failed':
    'Der Abgleich ist nicht vollständig gelungen oder es ist noch etwas offen. Es wird nichts entfernt.',
  'deviceData.way.sync': 'Zur Synchronisation',
  'deviceData.way.backup': 'Zur Sicherung',
  'deviceData.remove.action': 'Daten entfernen',
  'deviceData.remove.dialogTitle': 'Daten dieses Kontos von diesem Gerät entfernen?',
  'deviceData.remove.dialogText':
    'Alle Daten dieses Kontos auf diesem Gerät werden entfernt und Sie werden abgemeldet. Geben Sie zur Bestätigung das Wort {word} ein.',
  'deviceData.remove.word': 'ENTFERNEN',
  'deviceData.remove.wordLabel': 'Bestätigungswort',
  'deviceData.error.otherTabs':
    'Ein anderer Tab mit diesem Konto hat sich nicht abgemeldet. Schließen Sie andere Tabs und versuchen Sie es erneut. Es wurde nichts entfernt.',
  'deviceData.error.blocked':
    'Bei der erneuten Prüfung vor dem Entfernen wurden Daten gefunden, die nur auf diesem Gerät liegen. Es wurde nichts entfernt.',
  'deviceData.error.failed': 'Die Daten konnten nicht entfernt werden. Bitte erneut versuchen.',
} as const;
