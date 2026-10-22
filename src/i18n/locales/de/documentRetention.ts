/**
 * DOKUMENTE-01 / D-017 — Aufbewahrung und Löschschutz.
 *
 * Die Texte nennen die gesetzliche Mindestfrist, nie einen Entsorgungszeitpunkt:
 * Auch nach ihrem rechnerischen Ende kann die Frist laufen (§ 147 Abs. 3 AO).
 * Keine Rechtsberatung.
 */
export const deDocumentRetention = {
  'document.retention.title': 'Aufbewahrung',
  'document.retention.class.buchungsbeleg': 'Buchungsbeleg',
  'document.retention.class.geschaeftsbrief': 'Geschäftsbrief',
  'document.retention.class.pruefen': 'Aufbewahrung prüfen',
  'document.retention.running': '{klasse}: gesetzliche Aufbewahrung {jahre} Jahre, mindestens bis {datum}.',
  'document.retention.running.locked': 'Löschen ist bis dahin gesperrt.',
  'document.retention.expired':
    '{klasse}: Die gesetzliche Mindestfrist von {jahre} Jahren endete rechnerisch am {datum}.',
  'document.retention.expired.hint':
    'Sie läuft weiter, solange das Dokument für eine noch offene Steuerfestsetzung von Bedeutung ist (§ 147 Abs. 3 AO). Löschen nur nach dieser Prüfung.',
  'document.retention.review': 'Für diese Dokumentart kennt OfficeTakt keine feste gesetzliche Frist.',
  'document.retention.review.hint':
    'OfficeTakt schlägt keine Entsorgung vor. Ob das Dokument aufbewahrt werden muss, klären Sie bitte selbst, zum Beispiel mit Ihrer Steuerberatung.',
  'document.retention.reasonLabel': 'Einstufung',
  'document.retention.reason.zahlungsnachweis': 'Nachweis einer Zahlung',
  'document.retention.reason.ausgabenbeleg': 'Beleg einer Ausgabe',
  'document.retention.reason.rechnungsbeleg': 'Beleg einer eigenen Rechnung',
  'document.retention.reason.rechnung_nicht_festgeschrieben': 'Rechnung noch nicht festgeschrieben',
  'document.retention.reason.belegart': 'Rechnung oder Beleg',
  'document.retention.reason.geschaeftsbrief': 'Auftrag, Vertrag, Nachtrag oder Mahnung',
  'document.retention.reason.keine_feste_regel': 'Dokumentart ohne feste Frist',
  'document.retention.basis.buchungsbeleg':
    'Grundlage: § 147 Abs. 1 Nr. 4, Abs. 3 AO, § 257 Abs. 1 Nr. 4, Abs. 4 HGB, § 14b Abs. 1 UStG.',
  'document.retention.basis.geschaeftsbrief':
    'Grundlage: § 147 Abs. 1 Nr. 2 und 3, Abs. 3 AO, § 257 Abs. 1 Nr. 2 und 3, Abs. 4 HGB.',
  'document.retention.paper':
    'Bewahren Sie auch das Papieroriginal auf: OfficeTakt sichert kein ersetzendes Scannen zu.',
  'document.retention.disclaimer': 'Hinweis, keine Rechtsberatung.',
  'document.retention.downgradeBlocked':
    'Während der gesetzlichen Aufbewahrungsfrist lässt sich die Einstufung als Beleg oder Geschäftsbrief nicht aufheben.',
  'document.delete.blocked.retention':
    'Dieses Dokument unterliegt einer gesetzlichen Aufbewahrungsfrist und kann bis zu deren Ende nicht gelöscht werden.',
  'document.delete.blocked.retentionUntil': 'Gesetzliche Aufbewahrung bis {datum} – Löschen ist bis dahin gesperrt.',
  'document.delete.retention.confirmRequired':
    'Bitte bestätigen Sie zuerst, dass Sie die Aufbewahrung dieses Dokuments geprüft haben.',
  'document.delete.retention.reviewPruefen':
    'Für dieses Dokument kennt OfficeTakt keine feste Aufbewahrungsfrist. Löschen Sie es nur, wenn Sie geprüft haben, dass es nicht mehr aufbewahrt werden muss.',
  'document.delete.retention.reviewExpired':
    'Die gesetzliche Mindestfrist endete rechnerisch am {datum}. Löschen Sie das Dokument nur, wenn Sie geprüft haben, dass es für keine offene Steuerfestsetzung mehr von Bedeutung ist.',
  'document.deleteConfirmReviewed': 'Aufbewahrung geprüft – endgültig löschen',
  'companyRelevance.recognizedKind':
    'Erkannt: {art}. Ohne andere Auswahl bleibt diese Dokumentart erhalten.',
  'sync.failure.reason.retention':
    'Das Dokument unterliegt einer gesetzlichen Aufbewahrungsfrist; die Cloud hat es nicht gelöscht.',
} as const;
