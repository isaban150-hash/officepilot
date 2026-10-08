/**
 * P1 MITARBEITERZAHLUNGEN — Texte zu Mitarbeitern, Mitarbeiterzahlungen,
 * Auszahlungsquittung und Nachweis.
 *
 * Sprache eines Büros, keine Systembegriffe. „Mitarbeiter" meint hier immer
 * einen Menschen, an den gezahlt wird — nie ein Benutzerkonto (das heisst im
 * Produkt „Benutzer & Zugänge"). Kein Text behauptet eine Lohnbuchhaltung.
 */
export const deEmployeePayments = {
  'finanzen.group.employees': 'Mitarbeiter',
  'finanzen.employeePayments': 'Mitarbeiterzahlungen',
  'finanzen.employeePaymentsDesc': 'Lohn, Vorschuss, Auslagen und Reisekosten an Mitarbeiter erfassen',

  'employeePayments.title': 'Mitarbeiterzahlungen',
  'employeePayments.subtitle': 'Zahlungen an Mitarbeiter festhalten – keine Lohnabrechnung, keine Buchung.',
  'employeePayments.add': 'Mitarbeiterzahlung erfassen',
  'employeePayments.readOnly': 'Mitarbeiter und Mitarbeiterzahlungen verwalten dürfen nur Inhaber und Verwaltung.',
  'employeePayments.empty': 'Noch keine Mitarbeiterzahlungen erfasst.',
  'employeePayments.emptyFiltered': 'Keine Zahlungen für diese Auswahl.',
  'employeePayments.filter.month': 'Monat',
  'employeePayments.filter.allMonths': 'Alle Monate',
  'employeePayments.filter.employee': 'Mitarbeiter',
  'employeePayments.filter.allEmployees': 'Alle Mitarbeiter',
  'employeePayments.filter.kind': 'Zahlungsgrund',
  'employeePayments.filter.allKinds': 'Alle Zahlungsgründe',
  'employeePayments.filter.status': 'Status',
  'employeePayments.filter.allStatus': 'Alle',
  'employeePayments.status.active': 'Gültig',
  'employeePayments.status.reversed': 'Storniert',
  'employeePayments.list.label': 'Mitarbeiterzahlungen',

  'employeePayment.field.reference': 'Referenz',
  'employeePayment.field.employee': 'Mitarbeiter',
  'employeePayment.field.personnelNumber': 'Personalnummer',
  'employeePayment.field.kind': 'Zahlungsgrund',
  'employeePayment.field.kindHelp': 'Wofür wurde gezahlt?',
  'employeePayment.field.amount': 'Betrag',
  'employeePayment.field.date': 'Auszahlungsdatum',
  'employeePayment.field.method': 'Zahlungsweg',
  'employeePayment.field.methodHelp': 'Wie wurde ausgezahlt – bar, per Überweisung oder anders?',
  'employeePayment.field.wageMonth': 'Lohnmonat',
  'employeePayment.field.purpose': 'Verwendungszweck',
  'employeePayment.field.note': 'Notiz',
  'employeePayment.field.paidBy': 'Ausgezahlt durch',
  'employeePayment.field.proof': 'Nachweis',
  'employeePayment.field.receipt': 'Auszahlungsquittung',
  'employeePayment.field.status': 'Status',

  'employeePayment.kind.wage': 'Lohn/Gehalt',
  'employeePayment.kind.advance': 'Vorschuss',
  'employeePayment.kind.reimbursement': 'Auslagenerstattung',
  'employeePayment.kind.travel': 'Reisekosten',
  'employeePayment.kind.other': 'Sonstige Mitarbeiterzahlung',
  'employeePayment.kind.choose': 'Bitte wählen',
  'employeePayment.method.cash': 'Bar',
  'employeePayment.method.bank': 'Bank (Überweisung)',
  'employeePayment.method.other': 'Sonstige',
  'employeePayment.method.choose': 'Bitte wählen',
  'employeePayment.employee.choose': 'Mitarbeiter wählen',

  'employeePayment.form.title': 'Mitarbeiterzahlung erfassen',
  'employeePayment.form.next': 'Weiter zur Zusammenfassung',
  'employeePayment.form.cancel': 'Abbrechen',
  'employeePayment.form.notePlaceholderOther': 'Wofür wird gezahlt? (erforderlich)',
  'employeePayment.form.wageMonthHint': 'Optional: für welchen Monat der Lohn gezahlt wird.',
  'employeePayment.form.proofHint':
    'Optional. Für eine Barzahlung können Sie nach der Erfassung eine Auszahlungsquittung erstellen.',
  'employeePayment.form.noEmployees': 'Legen Sie zuerst unten einen Mitarbeiter an.',

  'employeePayment.summary.title': 'Zusammenfassung prüfen',
  'employeePayment.summary.intro':
    'Bitte prüfen Sie die Angaben. Erst mit „Zahlung jetzt erfassen" wird die Zahlung festgehalten; danach lässt sie sich nicht mehr ändern, nur stornieren.',
  'employeePayment.summary.confirm': 'Zahlung jetzt erfassen',
  'employeePayment.summary.back': 'Zurück zum Formular',
  'employeePayment.summary.proofPresent': 'Nachweis ausgewählt',
  'employeePayment.summary.proofMissingCash':
    'Noch kein Nachweis – nach der Erfassung können Sie eine Auszahlungsquittung erstellen und die unterschriebene Fassung hochladen.',
  'employeePayment.summary.proofMissing': 'Noch kein Nachweis – Sie können ihn später ergänzen.',

  'employeePayment.hint.advance': 'Dieser Vorschuss wird nicht als Aufwand behandelt.',
  'employeePayment.hint.wage': 'Die Lohnabrechnung selbst bucht Ihr Steuerberater. Hier wird nur die Auszahlung festgehalten.',
  'employeePayment.hint.reimbursement': 'Bitte den zugrunde liegenden Beleg prüfen und nicht zusätzlich als Ausgabe erfassen.',
  'employeePayment.hint.travel': 'Die steuerliche Behandlung der Reisekosten prüft Ihr Steuerberater.',
  'employeePayment.hint.other': 'Diese Zahlung wird dem Steuerberater zur Prüfung übergeben.',
  'employeePayment.hint.bank': 'Die Bankbewegung wird in dieser Version nicht automatisch zugeordnet.',
  'employeePayment.hint.noExpense': 'Es entsteht keine Ausgabe, keine Buchung und keine offene Verbindlichkeit.',
  'employeePayment.warning.payrollExpense':
    'Für {month} ist bereits eine Lohnabrechnung als Ausgabe gebucht ({count}). Bitte prüfen, damit Lohnkosten nicht doppelt erscheinen.',

  'employeePayment.toast.created': 'Mitarbeiterzahlung erfasst: {reference}',
  'employeePayment.toast.replayed': 'Diese Zahlung war bereits erfasst.',
  'employeePayment.toast.reversed': 'Zahlung storniert.',
  'employeePayment.toast.proofSaved': 'Nachweis gespeichert.',
  'employeePayment.toast.receiptCreated': 'Auszahlungsquittung erstellt.',

  'employeePayment.detail.open': 'Details',
  'employeePayment.detail.close': 'Schließen',
  'employeePayment.detail.reversedLine': 'Storniert am {date} – {reason}',
  'employeePayment.detail.cloudPending': 'Noch nicht in der Cloud bestätigt – wird beim nächsten Abgleich übertragen.',

  'employeePayment.receipt.create': 'Auszahlungsquittung erstellen',
  'employeePayment.receipt.open': 'Quittung öffnen',
  'employeePayment.receipt.download': 'Quittung herunterladen',
  'employeePayment.receipt.creating': 'Quittung wird erstellt …',
  'employeePayment.receipt.onlyCash': 'Eine Auszahlungsquittung gibt es nur für Barzahlungen.',
  'employeePayment.receipt.notAfterReversal': 'Nach dem Storno wird keine Quittung mehr erstellt.',
  'employeePayment.receipt.error': 'Die Quittung konnte nicht erstellt werden. Bitte versuchen Sie es erneut.',
  'employeePayment.receipt.fileMissing': 'Die Quittungsdatei ist auf diesem Gerät noch nicht verfügbar.',

  'employeePayment.proof.select': 'Vorhandenes Dokument als Nachweis wählen',
  'employeePayment.proof.save': 'Nachweis speichern',
  'employeePayment.proof.none': 'Kein Nachweis',
  'employeePayment.proof.open': 'Nachweis öffnen',
  'employeePayment.proof.uploadSigned': 'Unterschriebene Quittung hochladen',
  'employeePayment.proof.uploadIntro':
    'Fotografieren oder wählen Sie die unterschriebene Quittung. Sie wird archiviert und dieser Zahlung als Nachweis zugeordnet.',
  'employeePayment.proof.takePhoto': 'Foto aufnehmen',
  'employeePayment.proof.chooseFile': 'Datei wählen',
  'employeePayment.proof.processing': 'Dokument wird verarbeitet …',
  'employeePayment.proof.ready': 'Bereit: {name}',
  'employeePayment.proof.saveAsProof': 'Als Nachweis speichern',
  'employeePayment.proof.saved': 'Unterschriebene Quittung als Nachweis gespeichert.',
  'employeePayment.proof.duplicate': 'Dieses Dokument liegt bereits im Archiv und wird als Nachweis verwendet.',
  'employeePayment.proof.error': 'Der Nachweis konnte nicht gespeichert werden.',
  'employeePayment.proof.cancel': 'Abbrechen',

  'employeePayment.reverse.action': 'Stornieren',
  'employeePayment.reverse.title': 'Mitarbeiterzahlung stornieren',
  'employeePayment.reverse.intro':
    'Die Zahlung wird nicht gelöscht, sondern als storniert geführt. Quittung und Nachweis bleiben erhalten. Eine Korrektur erfassen Sie danach als neue Zahlung.',
  'employeePayment.reverse.reason': 'Grund für das Storno',
  'employeePayment.reverse.confirm': 'Storno bestätigen',
  'employeePayment.reverse.cancel': 'Abbrechen',

  'employeePayment.error.employeeRequired': 'Bitte einen Mitarbeiter wählen.',
  'employeePayment.error.employeeInactive': 'Dieser Mitarbeiter ist deaktiviert.',
  'employeePayment.error.kindRequired': 'Bitte den Zahlungsgrund wählen.',
  'employeePayment.error.amountInvalid': 'Bitte einen Betrag größer als 0 eingeben.',
  'employeePayment.error.amountPrecision': 'Bitte höchstens zwei Nachkommastellen eingeben.',
  'employeePayment.error.amountTooHigh': 'Der Betrag ist zu hoch.',
  'employeePayment.error.dateInvalid': 'Bitte ein gültiges Auszahlungsdatum eingeben.',
  'employeePayment.error.dateInFuture': 'Das Auszahlungsdatum darf nicht in der Zukunft liegen.',
  'employeePayment.error.methodRequired': 'Bitte den Zahlungsweg wählen.',
  'employeePayment.error.wageMonthOnlyForWage': 'Einen Lohnmonat gibt es nur bei Lohn/Gehalt.',
  'employeePayment.error.wageMonthInvalid': 'Bitte einen gültigen Lohnmonat wählen.',
  'employeePayment.error.textTooLong': 'Der Text ist zu lang.',
  'employeePayment.error.noteRequired': 'Bei einer sonstigen Zahlung ist eine Notiz erforderlich.',
  'employeePayment.error.proofNotFound': 'Der gewählte Nachweis ist nicht mehr vorhanden.',
  'employeePayment.error.idConflict': 'Diese Zahlung wurde bereits mit anderen Angaben erfasst.',
  'employeePayment.error.referenceConflict': 'Die Referenz ist bereits vergeben. Bitte erneut versuchen.',
  'employeePayment.error.workspaceMissing': 'Der Betrieb ist noch nicht eingerichtet.',
  'employeePayment.error.notFound': 'Zahlung nicht gefunden.',
  'employeePayment.error.reasonRequired': 'Bitte einen Grund angeben (mindestens 3 Zeichen).',
  'employeePayment.error.reasonTooLong': 'Der Grund ist zu lang.',
  'employeePayment.error.reversed': 'Die Zahlung ist storniert.',
  'employeePayment.error.proofIsReceipt':
    'Die erzeugte Quittung ist kein Nachweis. Bitte die unterschriebene Fassung hochladen.',
  'employeePayment.error.receiptNotFound': 'Die Quittung ist nicht verfügbar.',
  'employeePayment.error.receiptAlreadySet': 'Für diese Zahlung gibt es bereits eine Quittung.',
  'employeePayment.error.receiptOnlyCash': 'Eine Auszahlungsquittung gibt es nur für Barzahlungen.',
  'employeePayment.meaning.receiptOpen':
    'Quittung drucken, unterschreiben lassen und die unterschriebene Fassung bei der Zahlung hochladen.',
  'employeePayment.meaning.receiptDone': 'Keine Handlung nötig – die Auszahlung ist unter Mitarbeiterzahlungen erfasst und belegt.',
  'employeePayment.meaning.proofDone': 'Keine Handlung nötig – dieser unterschriebene Nachweis belegt die Auszahlung.',
  'employeePayment.meaning.proofFileOriginal':
    'Unterschriebenes Original abheften und unter „Ablage" bestätigen. Die Auszahlung selbst ist erfasst und belegt.',
  'employeePayment.meaning.reversed': 'Die Zahlung ist storniert. Quittung und Nachweis bleiben als Prüfspur erhalten.',
  'employeePayment.meaning.reversedFileOriginal':
    'Die Zahlung ist storniert. Das unterschriebene Original trotzdem abheften und unter „Ablage" bestätigen – es bleibt als Prüfspur erhalten.',
  'employeePayment.meaning.action.receiptOpen': 'Ja – Quittung unterschreiben lassen und als Nachweis hochladen.',
  'employeePayment.meaning.action.receiptDone': 'Nein – die Auszahlung ist erfasst und belegt.',
  'employeePayment.meaning.action.proofFileOriginal': 'Ja – unterschriebenes Original abheften.',
  'employeePayment.meaning.action.proofDone': 'Nein – der unterschriebene Nachweis belegt die Auszahlung.',
  'employeePayment.meaning.action.reversed': 'Nein – die Zahlung ist storniert.',
  'employeePayment.document.deleteProtected':
    'Gehört zu einer Mitarbeiterzahlung und bleibt als Beleg erhalten – Löschen ist nicht möglich.',
  'employeePayment.warning.possibleDuplicate':
    'Möglicherweise doppelt erfasst: Für diesen Mitarbeiter gibt es am {date} bereits eine gültige Zahlung mit demselben Zahlungsgrund, Betrag und Zahlungsweg ({references}). Erfassen Sie diese Zahlung nur, wenn tatsächlich ein zweites Mal ausgezahlt wurde.',
  'employeePayment.error.receiptInvalid': 'Diese Quittung gehört nicht zu dieser Zahlung.',
  'employeePayment.error.proofNotAllowed':
    'Ein Rechnungsdokument kann kein Nachweis einer Mitarbeiterzahlung sein.',

  'employees.section.title': 'Mitarbeiter',
  'employees.section.hint':
    'Nur für Zahlungen – keine Personalakte. Benutzerkonten verwalten Sie unter Einstellungen → Benutzer & Zugänge.',
  'employees.add': 'Mitarbeiter anlegen',
  'employees.name': 'Name',
  'employees.personnelNumber': 'Personalnummer (optional)',
  'employees.save': 'Speichern',
  'employees.cancel': 'Abbrechen',
  'employees.edit': 'Bearbeiten',
  'employees.deactivate': 'Deaktivieren',
  'employees.reactivate': 'Wieder aktivieren',
  'employees.inactive': 'Inaktiv',
  'employees.empty': 'Noch keine Mitarbeiter angelegt.',
  'employees.renameHint': 'Bereits erfasste Zahlungen behalten den Namen zum Zeitpunkt der Zahlung.',
  'employees.saved': 'Mitarbeiter gespeichert.',
  'employee.error.nameRequired': 'Bitte einen Namen eingeben.',
  'employee.error.nameTooLong': 'Der Name ist zu lang.',
  'employee.error.personnelNumberTooLong': 'Die Personalnummer ist zu lang.',
  'employee.error.personnelNumberTaken': 'Diese Personalnummer ist bereits vergeben.',
  'employee.error.notFound': 'Mitarbeiter nicht gefunden.',

  'employeePayment.document.receipt': 'Auszahlungsquittung zur Mitarbeiterzahlung {reference}',
  'employeePayment.document.proof': 'Nachweis zur Mitarbeiterzahlung {reference}',
  'employeePayment.document.meta': '{employee} · {amount} · {date}',
  'employeePayment.document.open': 'Zur Mitarbeiterzahlung',
  'employeePayment.document.reversed': 'Die zugehörige Mitarbeiterzahlung wurde am {date} storniert.',

  'payroll.hint.text':
    'Lohnauszahlungen erfassen Sie unter Finanzen → Mitarbeiterzahlungen. Die Lohnabrechnung selbst bucht Ihr Steuerberater.',
  'payroll.hint.link': 'Zu den Mitarbeiterzahlungen',
  'payroll.error.noExpense':
    'Eine Lohnabrechnung wird nicht als Ausgabe gebucht. Lohnauszahlungen erfassen Sie unter Finanzen → Mitarbeiterzahlungen.',
  'expense.personalHint':
    'Hinweis: Lohnabrechnungen nicht zusätzlich als Ausgabe erfassen. Lohn-/Gehaltsauszahlungen und Vorschüsse an Mitarbeiter gehören unter Finanzen → Mitarbeiterzahlungen.',

  'steuerberater.employeePayments.title': 'Mitarbeiterzahlungen',
  'steuerberater.employeePayments.summaryPayments': '{count} Zahlungen in diesem Monat',
  'steuerberater.employeePayments.summaryPaymentsOne': '1 Zahlung in diesem Monat',
  'steuerberater.employeePayments.summaryMissing': '{missing} Barzahlungen ohne unterschriebenen Nachweis',
  'steuerberater.employeePayments.summaryMissingOne': '1 Barzahlung ohne unterschriebenen Nachweis',
  'steuerberater.employeePayments.none': 'Keine Mitarbeiterzahlungen in diesem Monat.',
  'steuerberater.employeePayments.note':
    'Neutrale Übergabe: keine Lohnabrechnung, keine Sachkonten. Vorschüsse sind Forderungen, kein Aufwand.',
  'steuerberater.employeePayments.link': 'Zu den Mitarbeiterzahlungen',

  'sync.entity.employee': 'Mitarbeiter',
  'sync.entity.employee_payment': 'Mitarbeiterzahlung',

  'employeePayments.localOnly':
    'Mitarbeiterzahlungen werden derzeit nur auf diesem Gerät gespeichert. Die Übertragung in die Cloud folgt nach der Freischaltung.',
  'employeePayments.count': '{count} Zahlungen',
  'employeePayments.countOne': '1 Zahlung',

  'sync.employeeConflict.title': 'Mitarbeiter: Entscheidung nötig',
  'sync.employeeConflict.hint':
    'Online und auf diesem Gerät liegen unterschiedliche Stände dieses Mitarbeiters. Bitte entscheiden, welcher gelten soll.',
  'sync.employeeConflict.takeCloud': 'Online-Version verwenden',
  'sync.employeeConflict.keepLocal': 'Änderungen dieses Geräts behalten',
  'sync.employeeConflict.takeCloudTitle': 'Online-Version verwenden?',
  'sync.employeeConflict.takeCloudMessage':
    'Die Online-Version dieses Mitarbeiters wird übernommen. Die noch nicht übertragene Änderung dieses Geräts an diesem Mitarbeiter wird verworfen. Zahlungen bleiben unverändert.',
  'sync.employeeConflict.keepLocalTitle': 'Änderungen dieses Geräts behalten?',
  'sync.employeeConflict.keepLocalMessage':
    'Die Online-Version ist neuer. Wenn Sie die Änderung dieses Geräts behalten, wird daraus beim nächsten Synchronisieren eine neue Version in der Cloud.',
  'sync.employeeConflict.failed':
    'Die Entscheidung konnte nicht angewendet werden. Bitte die Verbindung prüfen und erneut versuchen. Es wurde nichts geändert.',
  'sync.employeeConflict.resolvedCloud': 'Online-Version übernommen.',
  'sync.employeeConflict.resolvedLocal': 'Änderung behalten. Sie wird beim nächsten Synchronisieren übertragen.',
  'employeePayment.proofStatus.present': 'Nachweis vorhanden',
  'employeePayment.proofStatus.missing': 'Ohne Nachweis',
  'employeePayment.detail.title': 'Mitarbeiterzahlung {reference}',
  'employeePayment.detail.heading': 'Mitarbeiterzahlung',
  'employeePayment.detail.createdAt': 'Erfasst am',
  'employeePayment.detail.receiptSection': 'Auszahlungsquittung',
  'employeePayment.detail.proofSection': 'Nachweis',
  'employeePayment.receipt.signHint':
    'Drucken, unterschreiben lassen und die unterschriebene Fassung als Nachweis hochladen.',
  'employeePayment.receipt.showInArchive': 'Im Archiv anzeigen',
  'employeePayment.receipt.none': 'Noch keine Quittung erstellt.',
  'employeePayment.proof.current': 'Aktueller Nachweis',
  'employeePayment.proof.noExpense':
    'Dieser Nachweis gehört zu einer Mitarbeiterzahlung und wird nicht als Ausgabe erfasst.',
  'employeePayment.proof.duplicateInbox':
    'Diese Datei liegt bereits im Eingang. Bitte legen Sie sie dort ab und wählen Sie sie dann als Nachweis.',
  'employeePayment.proof.tooLarge': 'Die Datei ist zu groß. Erlaubt sind höchstens 10 MB.',
  'employeePayment.proof.invalidType': 'Dieser Dateityp wird nicht unterstützt. Bitte ein PDF oder ein Foto wählen.',
  'employeePayment.proof.notPermitted': 'Nachweise zu Mitarbeiterzahlungen speichern dürfen nur Inhaber und Verwaltung.',
  'employeePayment.proof.notLinked':
    'Das Dokument wurde abgelegt, aber nicht als Nachweis verknüpft. Bitte wählen Sie es unten als Nachweis aus.',
  'employeePayment.proof.reversedLocked':
    'Die Zahlung ist storniert – der Nachweis bleibt erhalten und lässt sich nicht mehr ändern.',
  'employeePayment.summary.hints': 'Hinweise',
  'employeePayment.summary.saving': 'Zahlung wird erfasst …',
  'employeePayment.form.amountPlaceholder': '0,00',
  'employeePayment.form.paidByHint': 'Optional: wer das Geld übergeben hat.',
  'employees.addTitle': 'Neuer Mitarbeiter',
  'employees.editTitle': 'Mitarbeiter bearbeiten',
  'employees.create': 'Anlegen',
} as const;
