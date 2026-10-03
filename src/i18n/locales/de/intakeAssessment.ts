/**
 * EINGANG-01D-2 — die sichtbare Einschätzung eines Eingangs.
 *
 * Kurz und sachlich: was es ist, von wem, wozu es gehört, bis wann, was zu tun
 * ist. Keine Steuerberatung, keine erfundenen Sicherheiten.
 */
export const deIntakeAssessment = {
  'intakeAssessment.title': 'Einschätzung',
  'intakeAssessment.label.kind': 'Dokument',
  'intakeAssessment.label.sender': 'Absender',
  'intakeAssessment.label.number': 'Nummer',
  'intakeAssessment.label.assignment': 'Zuordnung',
  'intakeAssessment.label.deadline': 'Frist',
  'intakeAssessment.label.action': 'Aktionsbedarf',
  'intakeAssessment.label.nextStep': 'Nächster Schritt',
  'intakeAssessment.label.status': 'Erkennung',

  'intakeAssessment.kind.supplierCredit': 'Lieferantengutschrift',
  'intakeAssessment.kind.ownCredit': 'Gutschrift Ihres Betriebs',
  'intakeAssessment.kind.invoiceCorrection': 'Rechnungskorrektur',
  'intakeAssessment.kind.selfBillingCredit': 'Abrechnungsgutschrift',

  'intakeAssessment.assignment.confirmed': 'Zugeordnet: {target}',
  'intakeAssessment.assignment.exact': 'Passender Vorgang: {target}',
  'intakeAssessment.assignment.likely': 'Vorschlag: {target} – bitte prüfen',
  'intakeAssessment.assignment.multiple': 'Mehrere mögliche Vorgänge – bitte prüfen',
  'intakeAssessment.assignment.none': 'Noch nicht zugeordnet',

  'intakeAssessment.deadline.payment_due': 'Zahlung bis {date}',
  'intakeAssessment.deadline.response_due': 'Antwort bis {date}',
  'intakeAssessment.deadline.document_submission_due': 'Unterlagen bis {date}',
  'intakeAssessment.deadline.service_due': 'Leistung bis {date}',
  'intakeAssessment.deadline.termination_notice': 'Kündigung bis {date}',
  'intakeAssessment.deadline.untyped': 'Frist {date}',
  /* EINGANG-02A-2B — Handlung ohne absolutes Datum; nichts wird berechnet. */
  'intakeAssessment.deadline.relative': '{phrase} – Datum nicht berechnet, bitte prüfen',
  'intakeAssessment.deadline.notStated': 'Keine Frist genannt – bitte prüfen',

  'intakeAssessment.action.none': 'Keine Aktion',
  'intakeAssessment.action.review': 'Prüfen',
  'intakeAssessment.action.reply': 'Antworten',
  'intakeAssessment.action.pay': 'Zahlen',
  'intakeAssessment.action.submit_documents': 'Unterlagen einreichen',
  'intakeAssessment.action.observe_deadline': 'Frist beachten',
  'intakeAssessment.action.assign': 'Zuordnen',
  'intakeAssessment.action.record': 'Erfassen',
  'intakeAssessment.action.archive': 'Archivieren',
  'intakeAssessment.action.check_payment': 'Zahlung prüfen',
  'intakeAssessment.action.check_deadline': 'Frist prüfen',
  /* EINGANG-02B — eingehende Mahnung: prüfen, nie zahlen. */
  'intakeAssessment.action.check_dunning': 'Mahnung/Forderung prüfen',
  'intakeAssessment.action.check_payment_status': 'Mahnung gegen Zahlungsstatus prüfen',
  'intakeAssessment.action.check_remaining_claim': 'Restforderung prüfen',
  'intakeAssessment.action.check_invoice_reference': 'Rechnungsbezug prüfen',
  'intakeAssessment.action.check_court_dunning': 'Mahnbescheid prüfen',
  /* EINGANG-02C — Beschwerde: prüfen, vorbereiten — nie anerkennen, zahlen oder gutschreiben. */
  'intakeAssessment.action.check_complaint': 'Beschwerde prüfen',
  'intakeAssessment.action.prepare_statement': 'Stellungnahme vorbereiten',
  'intakeAssessment.action.check_remedy': 'Nachbesserung prüfen',
  'intakeAssessment.action.check_claim': 'Forderung prüfen',
  'intakeAssessment.kind.complaint.complaint': 'Beschwerde',
  'intakeAssessment.kind.complaint.reclamation': 'Reklamation',
  'intakeAssessment.kind.complaint.defect_notice': 'Mängelanzeige',
  'intakeAssessment.kind.complaint.defect_claim': 'Mängelrüge',
  'intakeAssessment.kind.complaint.objection': 'Beanstandung',
  'intakeAssessment.kind.complaint.remedy_request': 'Aufforderung zur Nachbesserung',
  'intakeAssessment.kind.complaint.damage_claim': 'Schadenersatzforderung',
  'intakeAssessment.kind.complaint.outgoing': 'Eigenes Schreiben (Reklamation)',
  'intakeAssessment.complaint.lead.incoming':
    'Der Absender beanstandet eine Leistung oder stellt eine Forderung. OfficeTakt bestätigt diese Angaben nicht und erkennt nichts an – bitte prüfen.',
  'intakeAssessment.complaint.lead.outgoing':
    'Eigenes Schreiben Ihres Betriebs an den Empfänger – keine Beschwerde gegen Ihren Betrieb.',
  'intakeAssessment.dunning.lead.open': 'Die Mahnung bezieht sich auf {invoice}. In OfficeTakt sind noch {open} offen.',
  'intakeAssessment.dunning.lead.paid':
    'Die Mahnung bezieht sich auf {invoice}. Die Rechnung ist in OfficeTakt bereits als bezahlt markiert. Zahlungsstatus prüfen.',
  'intakeAssessment.dunning.lead.partiallyPaid':
    'Die Mahnung fordert {claim}. In OfficeTakt sind {paid} als bezahlt erfasst; bekannter Rest: {open}. Restforderung prüfen.',
  'intakeAssessment.dunning.lead.referenceUnclear':
    'Die Mahnung lässt sich keiner erfassten Rechnung sicher zuordnen. Rechnungsbezug prüfen.',
  'intakeAssessment.dunning.lead.court':
    'Gerichtlicher Mahnbescheid. Bitte prüfen und die Frist laut Schreiben beachten – OfficeTakt bewertet die Forderung nicht.',
  'intakeAssessment.label.dunningReference': 'Rechnungsbezug',
  'intakeAssessment.dunning.referenceUnclear': 'Nicht sicher zugeordnet – bitte prüfen',
  'intakeAssessment.label.dunningClaim': 'Forderung laut Mahnung',
  'intakeAssessment.label.dunningPrincipal': 'Hauptforderung',
  'intakeAssessment.label.dunningFees': 'Mahnkosten',
  'intakeAssessment.label.dunningInterest': 'Verzugszinsen',
  'intakeAssessment.label.dunningPaid': 'Bezahlt laut OfficeTakt',
  'intakeAssessment.label.dunningOpen': 'Offen laut OfficeTakt',
  'intakeAssessment.label.bankReconciliation': 'Bankabgleich',
  'intakeAssessment.bankReconciliation.unavailable': 'In OfficeTakt noch nicht verfügbar',

  'intakeAssessment.next.recordCredit': 'Gutschrift als Ausgabe erfassen',
  'intakeAssessment.next.openExpense': 'Erfasste Ausgabe öffnen',
  'intakeAssessment.next.reviewAndFile': 'Prüfen und Ablage bestätigen',
  'intakeAssessment.next.fileOnly': 'Ablegen – keine Aktion erforderlich',

  'intakeAssessment.status.sicher': 'Sicher',
  'intakeAssessment.status.wahrscheinlich': 'Wahrscheinlich',
  'intakeAssessment.status.pruefen': 'Prüfen',

  'intakeAssessment.fact.creditAmount': 'Gutschriftsbetrag',
  'intakeAssessment.fact.creditNumber': 'Gutschrift-Nr.',

  'intakeAssessment.lead.supplierCredit':
    '{sender} schreibt Ihnen {amount} gut. Daraus entsteht keine Zahlung von Ihnen – bitte als Gutschrift erfassen.',
  'intakeAssessment.lead.supplierCreditNoAmount':
    '{sender} hat Ihnen eine Gutschrift geschickt. Daraus entsteht keine Zahlung von Ihnen – bitte als Gutschrift erfassen.',
  'intakeAssessment.lead.supplierCreditRecorded': 'Lieferantengutschrift von {sender} – bereits als Ausgabe erfasst.',
  'intakeAssessment.lead.ownCredit':
    'Diese Gutschrift hat Ihr eigener Betrieb ausgestellt. Sie ist keine Ausgabe – bitte prüfen und ablegen.',
  'intakeAssessment.lead.invoiceCorrection':
    'Rechnungskorrektur erkannt. Sie bezieht sich auf eine vorhandene Rechnung und wird nicht automatisch als Ausgabe gebucht – bitte prüfen.',
  'intakeAssessment.lead.selfBillingCredit':
    'Abrechnungsgutschrift erkannt: Hier rechnet der Kunde über Ihre Leistung ab. Das ist keine Ausgabe – bitte prüfen.',
} as const;
