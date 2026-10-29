/** EINRICHTUNG-01 (AP3; O-01 bis O-05, EIN-13, EIN-34) — Einrichtungsassistent und seine Sperren. */
export const deSetupFlow = {
  'setupFlow.field.legalForm': 'Rechtsform (optional)',
  'setupFlow.field.country': 'Land',
  'setupFlow.field.phone': 'Telefon (optional)',
  'setupFlow.resumed': 'Ihr gespeicherter Entwurf wurde geladen. Sie machen dort weiter, wo Sie aufgehört haben.',
  'setupFlow.completing': 'Wird abgeschlossen …',
  'setupFlow.retry': 'Erneut versuchen',
  'setupFlow.numberRange.network':
    'Die letzte Rechnungsnummer ließ sich ohne Verbindung nicht beim Server hinterlegen. Die Einrichtung ist noch nicht abgeschlossen; Ihre Eingaben bleiben erhalten.',
  'setupFlow.numberRange.forbidden':
    'Der Server hat die letzte Rechnungsnummer abgelehnt (Rolle oder Lizenz). Die Einrichtung ist noch nicht abgeschlossen; Ihre Eingaben bleiben erhalten.',
  'setupFlow.numberRange.failed':
    'Die letzte Rechnungsnummer ließ sich nicht beim Server hinterlegen. Die Einrichtung ist noch nicht abgeschlossen; Ihre Eingaben bleiben erhalten.',
  'setupFlow.member.title': 'Der Betrieb wird noch eingerichtet',
  'setupFlow.member.hint': 'Die Einrichtung übernimmt der Inhaber oder ein Admin dieses Betriebs.',
  'setupFlow.member.next': 'Sobald sie abgeschlossen ist, können Sie mit „Erneut prüfen“ weiterarbeiten.',
  'setupFlow.license.title': 'Die Betriebslizenz ist nicht wirksam',
  'setupFlow.license.hint': 'Die Einrichtung ist wieder möglich, sobald die Lizenz dieses Betriebs wirksam ist.',
  'setupFlow.unknown.title': 'Ihre Rolle in diesem Betrieb ist nicht bestätigt',
  'setupFlow.unknown.hint':
    'Ohne bestätigte Rolle öffnet OfficeTakt die Einrichtung nicht. Bitte prüfen Sie es erneut, sobald eine Verbindung besteht.',
  'setupFlow.companyRejected.message':
    'Der Server hat die letzte Änderung der Firmendaten abgelehnt. Sie gilt nur auf diesem Gerät; Firmenname und Betriebsname auf dem Server bleiben unverändert.',
  'setupFlow.companyRejected.open': 'Firmendaten prüfen',
  'setupFlow.team.hint': 'Mitarbeitende kommen über eine Einladung dazu. Das geht auch später unter Einstellungen › Team.',
  'setupFlow.team.finishAndInvite': 'Abschließen und Team einladen',
} as const;
