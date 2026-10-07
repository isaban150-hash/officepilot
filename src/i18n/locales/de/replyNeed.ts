/**
 * P1 EINGANGSSCHREIBEN — Texte zum Antwortbedarf und zur Antwort-Brücke.
 *
 * Sprache eines Büros: „Antwort erforderlich", „Antwort vorbereiten", „Keine
 * Antwort nötig". Keine Systembegriffe, keine Kennungen. Kein Text verspricht
 * einen Versand, den der Benutzer nicht ausdrücklich bestätigt hat.
 */
export const deReplyNeed = {
  'replyNeed.required': 'Antwort erforderlich',
  'replyNeed.requiredUntil': 'Antwort erforderlich bis {date}',
  'replyNeed.reason.responseDeadline': 'Laut Schreiben wird eine Antwort bis zu diesem Datum erwartet.',
  'replyNeed.reason.communicationRequest': 'Im Schreiben wird um eine Rückmeldung gebeten.',
  'replyNeed.reason.userReopened': 'Sie haben die Antwort als offen vorgemerkt.',
  'replyNeed.draftHint': 'Ein Entwurf ist vorbereitet — als beantwortet gilt das Schreiben erst nach Ihrer Bestätigung.',
  'replyNeed.recipient.customer': 'Antwort an {name} (Kunde aus dem Vorgang)',
  'replyNeed.recipient.sender': 'Antwort an {name} (Absender laut Schreiben)',
  'replyNeed.recipient.unknown': 'Empfänger nicht sicher erkannt – bitte im Entwurf ergänzen.',
  'replyNeed.prepare': 'Antwort vorbereiten',
  'replyNeed.asLetter': 'Als Brief',
  'replyNeed.asEmail': 'Als E-Mail',
  'replyNeed.noReply': 'Keine Antwort nötig',
  'replyNeed.noReplyToast': 'Festgehalten: Keine Antwort nötig.',
  'replyNeed.answered': 'Beantwortet',
  'replyNeed.channel.letter': 'per Brief',
  'replyNeed.channel.email': 'per E-Mail',
  'replyNeed.openAnswer': 'Antwort öffnen',
  'replyNeed.sourceUntitled': 'Eingangsschreiben',
  'replyNeed.letter.sourceHint': 'Antwort auf das Eingangsschreiben „{title}".',
  'replyNeed.letter.detailLabel': 'Antwort auf',
  'replyNeed.letter.confirmTitle': 'Als Antwort erfassen?',
  'replyNeed.letter.confirmMessage':
    'Der Brief ist fertiggestellt. Soll er als Antwort auf „{title}" erfasst werden? Dann gilt das Schreiben als beantwortet. Versenden Sie den Brief bitte wie gewohnt.',
  'replyNeed.letter.confirmYes': 'Als beantwortet erfassen',
  'replyNeed.letter.confirmNo': 'Noch offen lassen',
  'replyNeed.letter.recordedToast': 'Das Eingangsschreiben gilt jetzt als beantwortet.',
  'replyNeed.email.sourceHint': 'Antwort auf das Eingangsschreiben „{title}". Gesendet wird erst nach Ihrer Bestätigung.',
} as const;
