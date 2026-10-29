/**
 * P1-KORREKTURBLOCK A-04 — Steueraufteilung und Vorsteuerabzug einer Ausgabe: Formular, Detail, Sperren und
 * Hinweise. Unbekannte Werte heissen „offen“ und werden nie als 0 € Steuer ausgegeben.
 */
export const deExpenseTaxSplit = {
  'expense.taxSplit.label': 'Netto und Steuer auf dem Beleg',
  'expense.taxSplit.option.belegt': 'Netto und Steuer stehen auf dem Beleg (ein Steuersatz)',
  'expense.taxSplit.option.gemischt': 'Mehrere Steuersätze auf dem Beleg – Netto und Steuer als Summen',
  'expense.taxSplit.option.offen': 'Noch offen – Netto und Steuer sind (noch) nicht bekannt',
  'expense.taxSplit.amountsHint':
    'Netto oder Steuer genau so eintragen, wie es auf dem Beleg steht. Der andere Wert ergibt sich aus dem Brutto. Aus dem Steuersatz wird nichts geschätzt.',
  'expense.taxSplit.mixedHint':
    'Tragen Sie die Summe aller Nettobeträge und die Summe aller Steuerbeträge vom Beleg ein.',
  'expense.taxSplit.openHint':
    'Netto und Vorsteuer bleiben leer – nichts wird geschätzt oder als 0 € Steuer übernommen. Eine tatsächlich erfolgte Zahlung können Sie trotzdem erfassen. Bis Sie die Werte vom Originalbeleg nachtragen, bleiben Auftragszuordnung und die Bestätigung der Kontierung gesperrt, und der Monat lässt sich nicht abschließen. In Datenexport und Monatsmappe stehen Netto und Steuer leer, mit Hinweis.',
  'expense.taxSplit.legacyHint':
    'Altbestand: Gespeichert sind Netto = Brutto und 0,00 € Steuer – bei diesem Steuerstatus stammt das möglicherweise nicht vom Beleg. Tragen Sie Netto oder Steuer vom Beleg ein oder wählen Sie „Noch offen“. Ohne Eingabe bleiben die gespeicherten Werte unverändert.',
  'expense.taxSplit.amountsRequired':
    'Bitte Netto oder Steuer vom Beleg eintragen – oder „Noch offen“ wählen, wenn die Aufteilung (noch) nicht bekannt ist.',
  'expense.taxSplit.zeroTaxForTaxableStatus':
    '0,00 € Steuer passt nicht zu 19 % oder 7 %. Steht auf dem Beleg keine Umsatzsteuer, wählen Sie den passenden Steuerstatus (z. B. steuerfrei, Kleinunternehmer, §13b). Steht Umsatzsteuer darauf, die Sie nicht abziehen dürfen: Steuer eintragen und „Nicht abziehbar“ wählen. Ist die Aufteilung unbekannt, wählen Sie „Noch offen“.',
  'expense.taxSplit.zeroTaxUnclear':
    '0,00 € Steuer ist beim Steuerstatus „Unklar“ keine Klärung. Steht auf dem Beleg keine Umsatzsteuer, wählen Sie den passenden Steuerstatus (steuerfrei, Kleinunternehmer / keine ausgewiesene Umsatzsteuer, §13b). Steht Umsatzsteuer darauf, die Sie nicht abziehen dürfen: Steuer eintragen und „Nicht abziehbar“ wählen. Wissen Sie es noch nicht, wählen Sie „Noch offen“.',
  'expense.taxSplit.openNeedsTax':
    'Eine offene Steueraufteilung wird mit Netto und Steuer vom Beleg geklärt. Weist der Beleg keine Umsatzsteuer aus, wählen Sie den passenden Steuerstatus (z. B. steuerfrei, Kleinunternehmer, §13b); sonst bleibt die Aufteilung „Noch offen“.',
  'expense.taxSplit.closedPeriod':
    'Dieser Monat ist mit einer älteren Abschlussfassung abgeschlossen, die Steueraufteilung und Vorsteuerabzug noch nicht bindet. Änderungen daran sind erst nach dem Wiederöffnen des Monats möglich (neue Revision).',
  'expense.taxSplit.openWithAllocations':
    'Diese Ausgabe ist Aufträgen zugeordnet. Eine offene Steueraufteilung hat kein belegtes Netto – bitte zuerst die Zuordnung entfernen oder Netto und Steuer eintragen.',
  'expense.inputTaxDeduction.label': 'Vorsteuerabzug',
  'expense.inputTaxDeduction.option.voll': 'Voll abziehbar',
  'expense.inputTaxDeduction.option.teilweise': 'Teilweise abziehbar',
  'expense.inputTaxDeduction.option.keiner': 'Nicht abziehbar',
  'expense.inputTaxDeduction.hint':
    'Nur ändern, wenn die Vorsteuer nicht oder nur teilweise abgezogen werden darf (z. B. Bewirtung, private Mitnutzung). Im Zweifel mit dem Steuerberater klären.',
  'expense.inputTaxDeduction.amountLabel': 'Abziehbarer Vorsteuerbetrag',
  'expense.inputTaxDeduction.amountInvalid':
    'Bei „Teilweise abziehbar“ den abziehbaren Betrag eintragen: größer als 0 und kleiner als die Steuer.',
  'expense.payment.taxReviewOpenNotice':
    'Die Steuerprüfung dieses Belegs ist offen: Netto und Vorsteuer sind noch nicht eingetragen. Eine tatsächlich erfolgte Zahlung können Sie trotzdem erfassen. Kontierung und Monatsabschluss bleiben gesperrt, bis Sie Netto und Vorsteuer vom Beleg nachtragen.',
  'expense.payment.taxReviewAck': 'Die Zahlung ist tatsächlich erfolgt (z. B. laut Kontoauszug oder Kassenbeleg).',
  'expense.payment.taxReviewAckRequired': 'Bitte bestätigen Sie, dass die Zahlung tatsächlich erfolgt ist.',
  'expense.payment.statusTaxReviewOpen': '{status} – Steuerprüfung offen',
  'expense.allocation.taxSplitOpen':
    'Die Steueraufteilung dieser Ausgabe ist offen – ohne belegtes Netto ist keine Auftragszuordnung möglich. Bitte zuerst Netto und Steuer eintragen.',
  'bankConfirm.taxReviewOpenNotice':
    'Die Steuerprüfung dieses Belegs ist offen. Die Bankzahlung wird zugeordnet; Kontierung und Monatsabschluss bleiben gesperrt, bis Netto und Vorsteuer am Beleg eingetragen sind.',
  'accounting.reason.taxSplitOpen':
    'Netto und Vorsteuer sind am Beleg noch nicht eingetragen (Steueraufteilung offen). Bitte zuerst am Beleg nachtragen, dann kontieren.',
  'accounting.reason.taxSplitEntered':
    'Netto und Vorsteuer sind jetzt am Beleg eingetragen. Bitte die Kontierung prüfen und bestätigen.',
  'accounting.confirmNeedsTaxSplit':
    'Zum Bestätigen fehlt die Steueraufteilung des Belegs. Bitte Netto und Vorsteuer am Beleg eintragen.',
  'accounting.action.enterTaxSplit': 'Netto und Steuer am Beleg eintragen',
  'accountingPeriod.blocker.tax_split_open': 'Ausgaben mit offener Steueraufteilung: {count}',
  'accountingPeriod.blocker.tax_split_open_payment': 'Zahlungen auf Belege mit offener Steuerprüfung (anderer Monat): {count}',
  'expense.fieldTaxSplit': 'Steueraufteilung',
  'expense.taxSplit.state.belegt': 'Netto und Steuer eingetragen',
  'expense.taxSplit.state.gemischt': 'Netto und Steuer eingetragen, mehrere Steuersätze (Summen)',
  'expense.taxSplit.state.steuerfrei': 'Keine Umsatzsteuer (laut Steuerstatus)',
  'expense.taxSplit.state.offen': 'Offen – Netto und Vorsteuer nicht belegt',
  'expense.taxSplit.state.altbestand_pruefen': 'Bitte prüfen – 0,00 € Steuer gespeichert (Altbestand)',
  'expense.taxSplit.notProvided': 'nicht belegt',
  'expense.fieldInputTaxDeduction': 'Vorsteuerabzug',
  'expense.inputTaxDeduction.partialValue': 'Teilweise abziehbar: {amount}',
  'expense.taxSplit.detailOpenNotice':
    'Steueraufteilung offen: Netto und Vorsteuer sind nicht belegt und werden nirgends als Wert geführt – in Datenexport und Monatsmappe stehen sie leer. Eine tatsächlich erfolgte Zahlung können Sie erfassen. Auftragszuordnung, die Bestätigung der Kontierung und der Monatsabschluss bleiben gesperrt, bis Sie Netto und Vorsteuer vom Originalbeleg nachtragen.',
  'expense.taxSplit.detailLegacyNotice':
    'Bitte prüfen: Gespeichert sind 0,00 € Steuer bei Steuerstatus „{status}“ und Netto = Brutto. Diese Aufteilung stammt möglicherweise nicht vom Beleg. Die Werte bleiben unverändert, bis Sie sie korrigieren.',
  'expense.taxSplit.detailLegacyLocked':
    'Wegen gebuchter Zahlungen sind die Beträge fest: Korrektur nur über Zahlungsrücknahme oder Storno und Neuerfassung.',
  'expense.taxSplit.enterAction': 'Netto und Steuer eintragen',
  'expense.taxSplit.nextAction':
    'Als Nächstes: Netto und Vorsteuer vom Originalbeleg eintragen. Erst danach lassen sich Kontierung und Monatsabschluss abschließen. Eine bereits erfolgte Zahlung können Sie schon jetzt erfassen.',
  'expense.taxSplit.nextActionPaid':
    'Zahlung erfasst – Steuerprüfung offen. Als Nächstes: Netto und Vorsteuer vom Originalbeleg eintragen; danach lassen sich Kontierung und Monatsabschluss abschließen.',
  'expense.taxSplit.overviewOpen': 'Steuer offen',
  'expense.taxSplit.overviewLegacy': 'Steuer prüfen',
  'expense.edit.grossLockedTaxReviewHint':
    'Nach der erfassten Zahlung bleibt der Bruttobetrag fest. Netto und Vorsteuer vom Beleg – oder einen Steuerstatus ohne Umsatzsteuer – können Sie jetzt nachtragen.',
  /* P1 A-04 (Nacharbeit WEISS, Abschlussgültigkeit) — abgeschlossen, Stand unverändert, aber ein Sperrgrund besteht. */
  'accountingPeriod.state.recheck_required': 'Erneute Prüfung erforderlich',
  'accountingPeriod.recheckHint':
    'Erneute Prüfung erforderlich: Der gespeicherte Abschluss (Revision {revision}) passt weiterhin zu den gebundenen Daten, doch inzwischen besteht ein Sperrgrund – {reasons}. Bis er behoben ist, ist der Abschluss nicht gültig, und die Übergabe an den Steuerberater ist gesperrt. Danach gilt der Abschluss wieder; eine neue Revision entsteht dabei nicht.',
  'accountingExport.blocker.closure_recheck_required':
    'Der Monat ist abgeschlossen, doch inzwischen besteht ein Sperrgrund. Der Abschluss muss erneut geprüft werden – bitte beheben Sie zuerst die oben genannten Punkte.',
  'handover.state.recheck_required':
    'Erneute Prüfung erforderlich – der Abschluss ist unverändert, aber es besteht ein neuer Sperrgrund. Bitte beheben Sie ihn zuerst.',
  'handover.closure.recheck': 'Abgeschlossen (Revision {revision}) – erneute Prüfung erforderlich',
} as const;
