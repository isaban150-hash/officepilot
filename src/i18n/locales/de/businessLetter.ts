/**
 * BRIEFE-01C — Texte für Geschäftsschreiben.
 *
 * Bewusst die Sprache eines Handwerksbetriebs: „Schreiben", „Empfänger",
 * „Fertigstellen" — keine Systembegriffe, keine Kennungen, keine Fehlercodes.
 */
export const deBusinessLetter = {
  'businessLetter.area.title': 'Schreiben',
  'businessLetter.area.subtitle': 'Geschäftsschreiben an Kunden, Ämter und Partner',
  'businessLetter.area.new': 'Neues Geschäftsschreiben',
  'businessLetter.area.empty': 'Noch keine Schreiben',
  'businessLetter.area.emptyHint':
    'Hier sammeln sich Ihre Geschäftsschreiben. Legen Sie das erste an.',
  'businessLetter.area.search': 'Betreff oder Empfänger suchen…',
  'businessLetter.area.searchEmpty': 'Kein Schreiben gefunden.',

  'businessLetter.status.draft': 'Entwurf',
  'businessLetter.status.finalized': 'Fertiggestellt',

  'businessLetter.editor.newTitle': 'Neues Geschäftsschreiben',
  'businessLetter.editor.editTitle': 'Geschäftsschreiben bearbeiten',
  'businessLetter.editor.recipientSection': 'Empfänger',
  'businessLetter.editor.recipientKind': 'An wen geht das Schreiben?',
  'businessLetter.editor.recipientCustomer': 'Kunde aus dem Kundenstamm',
  'businessLetter.editor.recipientFree': 'Anderer Empfänger',
  'businessLetter.editor.customer': 'Kunde',
  'businessLetter.editor.customerPlaceholder': 'Kunde wählen',
  'businessLetter.editor.customerHint':
    'Die Anschrift wird übernommen und lässt sich hier noch ändern.',
  'businessLetter.editor.vorgang': 'Auftrag (optional)',
  'businessLetter.editor.vorgangNone': 'Keinem Auftrag zugeordnet',
  'businessLetter.editor.name': 'Name',
  'businessLetter.editor.company': 'Firma (optional)',
  'businessLetter.editor.street': 'Straße und Hausnummer',
  'businessLetter.editor.zip': 'PLZ',
  'businessLetter.editor.city': 'Ort',
  'businessLetter.editor.country': 'Land (optional)',
  'businessLetter.editor.contentSection': 'Schreiben',
  'businessLetter.editor.letterDate': 'Briefdatum',
  'businessLetter.editor.subject': 'Betreff',
  'businessLetter.editor.subjectPlaceholder': 'Worum geht es?',
  'businessLetter.editor.body': 'Text',
  'businessLetter.editor.bodyPlaceholder': 'Schreiben Sie hier Ihren Brieftext.',
  'businessLetter.editor.save': 'Entwurf speichern',
  'businessLetter.editor.finalize': 'Fertigstellen',
  'businessLetter.editor.cancel': 'Abbrechen',
  'businessLetter.editor.finalizeHint':
    'Nach dem Fertigstellen steht der Inhalt fest und kann nicht mehr geändert werden.',

  'businessLetter.detail.title': 'Geschäftsschreiben',
  'businessLetter.detail.recipient': 'Empfänger',
  'businessLetter.detail.letterDate': 'Briefdatum',
  'businessLetter.detail.subject': 'Betreff',
  'businessLetter.detail.body': 'Text',
  'businessLetter.detail.customer': 'Kunde',
  'businessLetter.detail.vorgang': 'Auftrag',
  'businessLetter.detail.edit': 'Bearbeiten',
  'businessLetter.detail.finalizedHint':
    'Dieses Schreiben ist fertiggestellt. Der Inhalt bleibt unverändert erhalten.',
  'businessLetter.detail.notFound': 'Dieses Schreiben gibt es nicht mehr.',
  'businessLetter.detail.back': 'Zu den Schreiben',

  'businessLetter.customer.section': 'Geschäftsschreiben',
  'businessLetter.customer.create': 'Geschäftsschreiben erstellen',
  'businessLetter.customer.empty': 'Noch keine Schreiben an diesen Kunden.',
  'businessLetter.vorgang.section': 'Geschäftsschreiben',
  'businessLetter.vorgang.create': 'Geschäftsschreiben erstellen',
  'businessLetter.vorgang.empty': 'Noch keine Schreiben zu diesem Auftrag.',

  'businessLetter.toast.saved': 'Entwurf gespeichert.',
  'businessLetter.toast.finalized': 'Schreiben fertiggestellt.',

  /* Verständliche Meldungen statt roher Fehlerschlüssel. */
  'businessLetter.subjectRequired': 'Bitte geben Sie einen Betreff ein.',
  'businessLetter.bodyRequired': 'Bitte schreiben Sie einen Text.',
  'businessLetter.recipientRequired': 'Bitte geben Sie einen Empfänger an.',
  'businessLetter.notFound': 'Dieses Schreiben wurde nicht gefunden.',
  'businessLetter.finalizedImmutable':
    'Dieses Schreiben ist bereits fertiggestellt und kann nicht mehr geändert werden.',
  'businessLetter.alreadyFinalized': 'Dieses Schreiben ist bereits fertiggestellt.',
  'businessLetter.incompleteForFinalize':
    'Betreff und Text müssen ausgefüllt sein, bevor Sie fertigstellen können.',
  'businessLetter.companyProfileMissing':
    'Bitte hinterlegen Sie zuerst Ihre Firmendaten in den Einstellungen.',
  'businessLetter.workspaceRequired': 'Ihr Arbeitsbereich ist noch nicht bereit.',

  /* BRIEFE-01D — Dokument und Ablage. */
  'businessLetter.pdf.view': 'PDF ansehen',
  'businessLetter.pdf.download': 'PDF herunterladen',
  'businessLetter.pdf.previewTitle': 'Vorschau',
  'businessLetter.pdf.failed':
    'Das Dokument konnte nicht erstellt werden. Bitte versuchen Sie es noch einmal.',
  'businessLetter.detail.archive': 'Ablage',
  'businessLetter.detail.archiveOpen': 'Im Dokumentenarchiv öffnen',
  'businessLetter.archiveDraftNotAllowed':
    'Ein Entwurf wird noch nicht abgelegt. Stellen Sie das Schreiben zuerst fertig.',
  'businessLetter.archiveFailed': 'Das Schreiben konnte nicht abgelegt werden.',
  'document.category.geschaeftsschreiben': 'Geschäftsschreiben',

  /* DOKUMENTVERSTAENDNIS-01B */
  'document.accounting.notABookingDocument':
    'Dieses Schreiben ist kein Buchungsbeleg. Es fordert kein Geld vom Betrieb.',
} as const;
