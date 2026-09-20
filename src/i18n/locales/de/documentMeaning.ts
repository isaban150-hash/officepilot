/**
 * DOKUMENTVERSTAENDNIS-01C — die Sprache des Verstehen-Bereichs.
 *
 * Alle Texte sind für einen Handwerker geschrieben, nicht für einen
 * Sachbearbeiter: kurze Sätze, keine Fachbegriffe, keine Abkürzungen, keine
 * technischen Werte. Wo OfficeTakt etwas nicht weiss, sagt es das auch.
 */
export const deDocumentMeaning = {
  'documentMeaning.title': 'Das steht in diesem Schreiben',
  'documentMeaning.certificate': 'Art der Bescheinigung',
  'documentMeaning.certificate.constructionExemption':
    'Freistellungsbescheinigung für Bauleistungen (Bauabzugsteuer)',
  'documentMeaning.certificate.reverseChargeStatus':
    'Bescheinigung zur Steuerschuldnerschaft bei Bau- oder Gebäudereinigungsleistungen',
  'documentMeaning.certificate.domesticEstablishment':
    'Bescheinigung über die Ansässigkeit im Inland',
  'documentMeaning.subject': 'Betreff',
  'documentMeaning.purpose': 'Kurz erklärt',
  'documentMeaning.action.question': 'Muss ich etwas tun?',
  'documentMeaning.action.yes': 'Ja',
  'documentMeaning.action.no': 'Nein',
  'documentMeaning.action.unclear': 'Nicht sicher erkannt',
  'documentMeaning.obligations': 'Was muss ich tun?',
  'documentMeaning.obligations.by': 'bis',
  'documentMeaning.deadlines': 'Termine und Fristen',
  'documentMeaning.deadlines.action': 'Handlungsfrist',
  'documentMeaning.deadlines.info': 'Nur zur Kenntnis',
  'documentMeaning.amounts': 'Beträge im Schreiben',
  'documentMeaning.accounting': 'Buchführung',
  'documentMeaning.accounting.none': 'Keine neue Ausgabe',
  'documentMeaning.accounting.noneHint':
    'Aus diesem Schreiben entsteht kein Beleg für die Buchführung.',
  'documentMeaning.accounting.reference': 'Gehört zu einem vorhandenen Beleg',
  'documentMeaning.accounting.referenceHint':
    'Der Betrag steht bereits in Ihren Büchern. Eine zweite Ausgabe wäre doppelt.',
  'documentMeaning.accounting.candidate': 'Kann als neuer Beleg übernommen werden',
  'documentMeaning.accounting.candidateHint':
    'Bitte prüfen Sie den Beleg, bevor Sie ihn übernehmen.',
  'documentMeaning.customer': 'Wahrscheinlicher Kunde',
  'documentMeaning.vorgang': 'Wahrscheinlicher Auftrag',
  'documentMeaning.candidate.uncertain': 'Bitte prüfen',
  'documentMeaning.candidate.confirm': 'Zuordnung bestätigen',
  'documentMeaning.candidate.choose': 'Bitte wählen Sie selbst aus.',
  'documentMeaning.nextStep': 'Nächster Schritt',
  'documentMeaning.next.confirmAndAnswer': 'Zuordnung bestätigen und Antwort vorbereiten.',
  'documentMeaning.next.answerRequired': 'Antwort vorbereiten und Fristen im Blick behalten.',
  'documentMeaning.next.checkExistingRecord': 'Zugehörigen Beleg prüfen.',
  'documentMeaning.next.reviewAndBook': 'Beleg prüfen und als Ausgabe übernehmen.',
  'documentMeaning.next.fileOnly': 'Dokument ablegen. Aktuell keine Handlung erforderlich.',
  'documentMeaning.next.reviewYourself': 'Bitte sehen Sie sich das Schreiben selbst an.',
  'documentMeaning.uncertain': 'Das konnte OfficePilot nicht sicher erkennen',
  'documentMeaning.uncertain.noSubject': 'Der Betreff steht nicht eindeutig im Schreiben.',
  'documentMeaning.uncertain.recipient':
    'Ob das Schreiben an Ihren Betrieb gerichtet ist, war nicht eindeutig zu erkennen.',
  'documentMeaning.uncertain.noAssignment': 'Kunde und Auftrag konnten nicht zugeordnet werden.',
  'documentMeaning.disclaimer':
    'OfficePilot liest das Schreiben maschinell. Bitte prüfen Sie wichtige Angaben im Original.',

  /* DOKUMENT-ASSISTENT-01F — Wiedervorlagen. */
  'documentReminder.proposalTitle': 'Wiedervorlage am',
  'documentReminder.documentDeadline': 'Frist im Schreiben:',
  'documentReminder.confirm': 'Wiedervorlage anlegen',
  'documentReminder.created': 'Die Wiedervorlage wurde angelegt.',
  'documentReminder.alreadyExists': 'Diese Wiedervorlage besteht bereits.',
  'documentReminder.chooseDeadline':
    'Das Schreiben nennt mehrere Fristen. Bitte sagen Sie, welche gemeint ist.',

  /* DOKUMENT-ASSISTENT-01G — Antwortentwurf. */
  'documentReply.recipient': 'Empfänger:',
  'documentReply.recipientUnknown': 'noch nicht bestimmt',
  'documentReply.missingAddress':
    'Für einen Brief fehlt noch die Anschrift. Sie können sie im Briefeditor ergänzen.',
  'documentReply.missingEmail':
    'Für eine E-Mail ist keine Adresse hinterlegt. Sie können sie im nächsten Schritt angeben.',
  'documentReply.chooseChannel': 'Wie möchten Sie antworten?',
  'documentReply.asLetter': 'Als Brief weiterbearbeiten',
  'documentReply.asEmail': 'Als E-Mail weiterbearbeiten',
  'documentReply.nothingSentYet':
    'Es wurde noch nichts versendet und nichts fertiggestellt. Sie prüfen den Text im nächsten Schritt.',
} as const;
