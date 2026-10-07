/**
 * CLOUD-SYNC S5 — Texte zum Rechnungsentwurf auf mehreren Geräten.
 *
 * Die Sprache eines Handwerksbetriebs: „Entwurf", „anderes Gerät",
 * „übernehmen", „verwerfen" — keine Systembegriffe, keine Kennungen, keine
 * Fehlercodes. Nichts wird still zusammengeführt; jeder Text sagt, was mit
 * welcher Fassung geschieht.
 */
export const deInvoiceDraftCloud = {
  'invoiceDraftCloud.conflict.version.title': 'Der Rechnungsentwurf wurde auf einem anderen Gerät geändert.',
  'invoiceDraftCloud.conflict.version.body':
    'Die Fassung auf diesem Gerät und die Fassung aus der Cloud weichen voneinander ab. Es wird nichts automatisch zusammengeführt. Bis zu Ihrer Entscheidung ist der Entwurf gesperrt.',
  'invoiceDraftCloud.conflict.deleted.title': 'Dieser Rechnungsentwurf wurde auf einem anderen Gerät verworfen.',
  'invoiceDraftCloud.conflict.deleted.body':
    'Ein verworfener Entwurf wird nicht wiederhergestellt. Sie können den Inhalt dieses Geräts als neuen Entwurf fortsetzen oder das Verwerfen bestätigen.',
  'invoiceDraftCloud.conflict.finalized.title':
    'Dieser Rechnungsentwurf wurde auf einem anderen Gerät bereits freigegeben.',
  'invoiceDraftCloud.conflict.finalized.body':
    'Aus diesem Entwurf ist bereits eine Rechnung entstanden. Änderungen auf diesem Gerät werden nicht übernommen, und es entsteht keine zweite Rechnung.',
  'invoiceDraftCloud.conflict.slot.title': 'Für diese Rechnung gibt es bereits einen Entwurf von einem anderen Gerät.',
  'invoiceDraftCloud.conflict.slot.body':
    'Zwei Entwürfe für dieselbe Rechnung werden nicht zusammengeführt. Entscheiden Sie, welcher weitergeführt wird; der andere wird verworfen.',
  'invoiceDraftCloud.action.takeCloud': 'Cloud-Fassung übernehmen',
  'invoiceDraftCloud.action.keepMine': 'Meine Fassung behalten',
  'invoiceDraftCloud.action.continueAsNew': 'Als neuen Entwurf fortsetzen',
  'invoiceDraftCloud.action.acceptDiscard': 'Verwerfen bestätigen',
  'invoiceDraftCloud.action.openInvoice': 'Rechnung öffnen',
  'invoiceDraftCloud.action.acknowledge': 'Verstanden',
  'invoiceDraftCloud.action.adoptOther': 'Entwurf des anderen Geräts übernehmen',
  'invoiceDraftCloud.action.keepOwnDiscardOther': 'Meinen Entwurf behalten',
  'invoiceDraftCloud.action.cancel': 'Abbrechen',
  'invoiceDraftCloud.confirm.takeCloud.title': 'Cloud-Fassung übernehmen?',
  'invoiceDraftCloud.confirm.takeCloud.body':
    'Die Fassung auf diesem Gerät wird durch die Cloud-Fassung ersetzt; Ihre Änderungen hier gehen dabei verloren. Eine Bestätigung nach §13b muss gegebenenfalls erneut erfolgen.',
  'invoiceDraftCloud.confirm.keepMine.title': 'Meine Fassung behalten?',
  'invoiceDraftCloud.confirm.keepMine.body':
    'Die Fassung dieses Geräts wird gegen den zuletzt geladenen Cloud-Stand gespeichert und ersetzt dort die andere Fassung. Hat sich die Cloud inzwischen erneut geändert, werden Sie wieder gefragt.',
  'invoiceDraftCloud.confirm.acceptDiscard.title': 'Verwerfen bestätigen?',
  'invoiceDraftCloud.confirm.acceptDiscard.body':
    'Der Entwurf wird auch auf diesem Gerät entfernt. Rechnungen sind davon nicht betroffen.',
  'invoiceDraftCloud.confirm.continueAsNew.title': 'Als neuen Entwurf fortsetzen?',
  'invoiceDraftCloud.confirm.continueAsNew.body':
    'Der Inhalt dieses Geräts wird als neuer Entwurf weitergeführt. Der verworfene Entwurf bleibt verworfen.',
  'invoiceDraftCloud.confirm.adoptOther.title': 'Entwurf des anderen Geräts übernehmen?',
  'invoiceDraftCloud.confirm.adoptOther.body':
    'Ihr Entwurf auf diesem Gerät wird durch den Entwurf des anderen Geräts ersetzt; sein Inhalt geht dabei verloren.',
  'invoiceDraftCloud.confirm.keepOwn.title': 'Meinen Entwurf behalten?',
  'invoiceDraftCloud.confirm.keepOwn.body':
    'Der Entwurf des anderen Geräts wird verworfen, Ihrer wird weitergeführt. Verworfene Entwürfe lassen sich nicht wiederherstellen.',
  'invoiceDraftCloud.discard.action': 'Entwurf verwerfen',
  'invoiceDraftCloud.discard.title': 'Entwurf verwerfen?',
  'invoiceDraftCloud.discard.body':
    'Der Entwurf wird verworfen — auch auf Ihren anderen Geräten — und kann nicht wiederhergestellt werden. Bereits freigegebene Rechnungen bleiben unberührt.',
  // Solange Entwürfe noch nicht geräteübergreifend abgeglichen werden.
  'invoiceDraftCloud.discard.bodyLocal':
    'Der Entwurf wird verworfen und kann nicht wiederhergestellt werden. Bereits freigegebene Rechnungen bleiben unberührt.',
  'invoiceDraftCloud.discard.failed': 'Der Entwurf konnte nicht verworfen werden. Bitte erneut versuchen.',
  'invoiceDraftCloud.decision.failed': 'Die Entscheidung konnte nicht gespeichert werden. Bitte erneut versuchen.',
  'invoiceDraftCloud.decision.slotTaken':
    'Für diese Rechnung gibt es inzwischen einen anderen Entwurf. Bitte zuerst über diesen entscheiden.',
  'invoiceDraftCloud.approve.notSynced':
    'Der Entwurf ist noch nicht vollständig in der Cloud. Bitte kurz warten und erneut freigeben — es wurde nichts freigegeben.',
  'invoiceDraftCloud.approve.conflict':
    'Für diesen Entwurf ist noch eine Entscheidung offen (anderes Gerät). Bitte zuerst entscheiden.',
  'invoiceDraftCloud.approve.ended': 'Dieser Entwurf ist bereits beendet. Es wurde nichts freigegeben.',
  'invoiceDraftCloud.approve.changedElsewhere':
    'Der Entwurf wurde inzwischen auf einem anderen Gerät geändert oder verworfen. Es wurde keine Rechnung erstellt. Bitte den Stand prüfen.',
  'invoiceDraftCloud.approve.finalizedElsewhere':
    'Dieser Entwurf wurde bereits auf einem anderen Gerät freigegeben. Es wurde keine zweite Rechnung erstellt.',
} as const;
