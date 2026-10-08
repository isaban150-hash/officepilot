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
  /* EINGANG-02B */
  'documentMeaning.financeNote': 'Abgleich mit OfficeTakt',
  /* EINGANG-02C — Angaben des Absenders, nie bestätigte Wahrheit. */
  'documentMeaning.complaint': 'Laut Absender',
  'documentMeaning.complaint.reports': 'Der Absender meldet: „{text}"',
  'documentMeaning.complaint.demands': 'Der Absender fordert: {what}',
  'documentMeaning.complaint.announces': 'Der Absender kündigt an: {what}',
  'documentMeaning.complaint.references': 'Genannter Bezug: {refs}',
  'documentMeaning.complaint.notConfirmed': 'OfficeTakt bestätigt diese Angaben nicht und erkennt nichts an.',
  'documentMeaning.complaint.outgoing':
    'Eigenes Schreiben Ihres Betriebs. Es ist keine Beschwerde gegen Ihren Betrieb; Forderungen und Fristen darin richten sich an den Empfänger.',
  'documentMeaning.complaint.demand.remedy': 'Nachbesserung bzw. Mangelbeseitigung',
  'documentMeaning.complaint.demand.statement': 'eine Stellungnahme',
  'documentMeaning.complaint.demand.documents': 'Unterlagen',
  'documentMeaning.complaint.demand.damages': 'Schadenersatz',
  'documentMeaning.complaint.demand.reimbursement': 'Erstattung von Kosten',
  'documentMeaning.complaint.demand.reduction': 'eine Minderung',
  'documentMeaning.complaint.demand.retention': 'einen Einbehalt',
  'documentMeaning.complaint.demand.payment': 'Zahlung',
  'documentMeaning.complaint.escalation.substitutePerformance': 'eine Ersatzvornahme',
  'documentMeaning.complaint.escalation.legalAction': 'anwaltliche bzw. gerichtliche Schritte',
  'documentMeaning.complaint.reference.order': 'Auftrag',
  'documentMeaning.complaint.reference.invoice': 'Rechnung',
  'documentMeaning.complaint.reference.case': 'Vorgang',
  'documentMeaning.complaint.reference.offer': 'Angebot',
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
  // BROWSER-ACCEPTANCE-FIX 01 / A3 — eigene, verknüpfte Ausgangsrechnung
  'documentMeaning.customer.assigned': 'Kunde',
  'documentMeaning.vorgang.assigned': 'Auftrag',
  'documentMeaning.candidate.fromInvoice': 'Aus der Rechnung übernommen',
  'documentMeaning.accounting.ownInvoice': 'Eigene Rechnung – bereits erfasst',
  'documentMeaning.accounting.ownInvoiceHint': 'Der Betrag steht in Ihrer Rechnung. Hier ist nichts neu zu buchen.',
  'documentMeaning.accounting.employeePayment': 'Mitarbeiterzahlung – bereits erfasst',
  'documentMeaning.accounting.employeePaymentHint':
    'Die Auszahlung steht unter Mitarbeiterzahlungen. Keine Ausgabe, keine Buchung, kein Kunde und kein Auftrag.',
  'documentMeaning.nextStep': 'Nächster Schritt',
  'documentMeaning.next.confirmAndAnswer': 'Zuordnung bestätigen und Antwort vorbereiten.',
  'documentMeaning.next.answerRequired': 'Antwort vorbereiten und Fristen im Blick behalten.',
  'documentMeaning.next.checkExistingRecord': 'Zugehörigen Beleg prüfen.',
  'documentMeaning.next.reviewAndBook': 'Beleg prüfen und als Ausgabe übernehmen.',
  'documentMeaning.next.fileOnly': 'Dokument ablegen. Aktuell keine Handlung erforderlich.',
  'documentMeaning.next.reviewYourself': 'Bitte sehen Sie sich das Schreiben selbst an.',
  'documentMeaning.uncertain': 'Das konnte OfficeTakt nicht sicher erkennen',
  'documentMeaning.uncertain.noSubject': 'Der Betreff steht nicht eindeutig im Schreiben.',
  'documentMeaning.uncertain.recipient':
    'Ob das Schreiben an Ihren Betrieb gerichtet ist, war nicht eindeutig zu erkennen.',
  'documentMeaning.uncertain.noAssignment': 'Kunde und Auftrag konnten nicht zugeordnet werden.',
  /* EINGANG-02A-2B */
  'documentMeaning.uncertain.relativeDeadline':
    'Die Frist steht nur relativ im Schreiben (z. B. „nach Zugang"). Das genaue Datum bitte selbst prüfen – OfficeTakt rechnet es nicht aus.',
  'documentMeaning.uncertain.noDeadline': 'Eine Handlung wird verlangt, aber das Schreiben nennt keine Frist.',
  'documentMeaning.disclaimer':
    'OfficeTakt liest das Schreiben maschinell. Bitte prüfen Sie wichtige Angaben im Original.',

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
