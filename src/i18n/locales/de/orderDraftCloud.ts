/**
 * CLOUD-SYNC S6 — Texte zu Auftrags- und Nachtragsentwürfen auf mehreren Geräten.
 *
 * Die Sprache eines Handwerksbetriebs: „Entwurf", „anderes Gerät",
 * „übernehmen", „verwerfen" — keine Systembegriffe, keine Kennungen, keine
 * Fehlercodes. Nichts wird still zusammengeführt; jeder Text sagt, was mit
 * welcher Fassung geschieht.
 */
export const deOrderDraftCloud = {
  'orderDraftCloud.badge.conflict': 'Abweichung',
  'orderDraftCloud.discardText': 'Der Entwurf wird auf allen Geräten Ihres Betriebs verworfen. Ein Auftrag ist noch nicht entstanden.',

  /* Auftragsentwurf: Konflikte */
  'orderDraftCloud.conflict.version.title': 'Dieser Entwurf wurde auf einem anderen Gerät geändert.',
  'orderDraftCloud.conflict.version.body':
    'Die Fassung auf diesem Gerät und die Fassung aus der Cloud weichen voneinander ab. Es wird nichts automatisch zusammengeführt. Bis zu Ihrer Entscheidung ist der Entwurf gesperrt.',
  'orderDraftCloud.conflict.deleted.title': 'Dieser Entwurf wurde auf einem anderen Gerät verworfen.',
  'orderDraftCloud.conflict.deleted.body':
    'Ein verworfener Entwurf wird nicht wiederhergestellt. Sie können den Inhalt dieses Geräts als neuen Entwurf behalten oder das Verwerfen annehmen.',
  'orderDraftCloud.conflict.consumed.title': 'Dieser Entwurf wurde bereits als Auftrag angelegt.',
  'orderDraftCloud.conflict.consumed.body':
    'Der Auftrag ist verbindlich und entstand aus der Fassung, die zu diesem Zeitpunkt in der Cloud stand. Ihre abweichenden Eingaben auf diesem Gerät sind darin nicht enthalten. Ergänzungen zum Auftrag erfolgen über Nachträge.',
  'orderDraftCloud.conflict.discardRejected.title': 'Ihr Verwerfen wurde nicht übernommen.',
  'orderDraftCloud.conflict.discardRejected.body':
    'Der Entwurf wurde inzwischen auf einem anderen Gerät geändert. Damit diese Änderung nicht ungesehen verloren geht, ist er wieder da. Sie können ihn behalten oder erneut verwerfen.',

  /* Aktionen */
  'orderDraftCloud.action.takeCloud': 'Cloud-Fassung übernehmen',
  'orderDraftCloud.action.keepMine': 'Meine Fassung behalten',
  'orderDraftCloud.action.continueAsNew': 'Als neuen Entwurf behalten',
  'orderDraftCloud.action.acceptDiscard': 'Verwerfen annehmen',
  'orderDraftCloud.action.closeDraft': 'Entwurf schließen',
  'orderDraftCloud.action.openOrder': 'Zum Auftrag',
  'orderDraftCloud.action.keepDraft': 'Entwurf behalten',
  'orderDraftCloud.action.discardAgain': 'Erneut verwerfen',

  /* Bestätigungen — jede Entscheidung erst nach ausdrücklicher Rückfrage */
  'orderDraftCloud.confirm.takeCloud.title': 'Cloud-Fassung übernehmen?',
  'orderDraftCloud.confirm.takeCloud.body':
    'Die Fassung auf diesem Gerät wird durch die Fassung aus der Cloud ersetzt. Ihre abweichenden Eingaben auf diesem Gerät gehen dabei verloren.',
  'orderDraftCloud.confirm.keepMine.title': 'Meine Fassung behalten?',
  'orderDraftCloud.confirm.keepMine.body':
    'Ihre Fassung wird gespeichert und ersetzt die Änderung des anderen Geräts. Hat sich der Entwurf dort inzwischen erneut geändert, werden Sie wieder gefragt.',
  'orderDraftCloud.confirm.acceptEnd.title': 'Entwurf auf diesem Gerät schließen?',
  'orderDraftCloud.confirm.acceptEnd.body': 'Der Entwurf verschwindet von diesem Gerät. Ihre abweichenden Eingaben gehen dabei verloren.',
  'orderDraftCloud.confirm.continueAsNew.title': 'Als neuen Entwurf behalten?',
  'orderDraftCloud.confirm.continueAsNew.body':
    'Ihr Inhalt wird als neuer, eigenständiger Entwurf fortgesetzt. Der bisherige Entwurf bleibt beendet und wird nicht wiederhergestellt.',
  'orderDraftCloud.confirm.discardAgain.title': 'Entwurf erneut verwerfen?',
  'orderDraftCloud.confirm.discardAgain.body': 'Der Entwurf wird in der aktuellen Fassung verworfen — auf allen Geräten.',
  'orderDraftCloud.decision.failed': 'Die Entscheidung konnte nicht gespeichert werden. Bitte erneut versuchen.',

  /* Editor: neuere Fassung, während hier ungespeicherte Eingaben stehen */
  'orderDraftCloud.remoteChanged.title': 'Dieser Entwurf wurde inzwischen auf einem anderen Gerät geändert.',
  'orderDraftCloud.remoteChanged.body':
    'Ihre ungespeicherten Eingaben auf diesem Gerät bleiben stehen. Laden Sie die neue Fassung oder behalten Sie bewusst Ihre Eingaben.',
  'orderDraftCloud.remoteChanged.load': 'Neue Fassung laden',
  'orderDraftCloud.remoteChanged.keep': 'Meine Eingaben behalten',
  'orderDraftCloud.remoteChanged.saveBlocked': 'Bitte entscheiden Sie zuerst, welche Fassung gilt.',

  /* Editor: der Entwurf wurde anderswo beendet, hier stehen noch ungespeicherte Eingaben */
  'orderDraftCloud.gone.title': 'Dieser Entwurf wurde inzwischen auf einem anderen Gerät beendet.',
  'orderDraftCloud.gone.body':
    'Ihre ungespeicherten Eingaben stehen noch hier. Sie können sie als neuen, eigenständigen Entwurf speichern.',
  'orderDraftCloud.gone.saveAsNew': 'Eingaben als neuen Entwurf speichern',

  /* Auftragsanlage */
  'orderDraftCloud.create.notSynced':
    'Der Entwurf ist noch nicht vollständig in der Cloud angekommen. Bitte prüfen Sie die Verbindung und versuchen Sie es erneut.',
  'orderDraftCloud.create.conflict': 'Der Entwurf weicht von der Fassung in der Cloud ab. Bitte entscheiden Sie zuerst über die Fassung.',
  'orderDraftCloud.create.ended': 'Dieser Entwurf wurde auf einem anderen Gerät verworfen. Es wird kein Auftrag angelegt.',
  'orderDraftCloud.create.alreadyCreated': 'Dieser Entwurf wurde bereits als Auftrag angelegt.',
  'orderDraftCloud.create.alreadyCreatedBody':
    'Es entsteht kein zweiter Auftrag. Abweichende Eingaben auf diesem Gerät sind im Auftrag nicht enthalten; Ergänzungen erfolgen über Nachträge.',

  /* Fehler aus dem Entwurfsspeicher */
  'order.draft.conflictOpen': 'Bitte entscheiden Sie zuerst über die abweichende Fassung dieses Entwurfs.',
  'order.draft.discardFailed':
    'Der Entwurf konnte nicht verworfen werden, weil das Speichern auf diesem Gerät fehlgeschlagen ist. Er ist unverändert erhalten.',

  /* Nachtragsentwurf */
  'orderAmendmentCloud.drafts.title': 'Offene Nachtragsentwürfe',
  'orderAmendmentCloud.drafts.select': 'Bearbeiten',
  'orderAmendmentCloud.drafts.active': 'In Bearbeitung',
  'orderAmendmentCloud.drafts.updated': 'Zuletzt geändert {date}',
  'orderAmendmentCloud.drafts.newAnother': 'Weiteren Nachtrag erstellen',
  'orderAmendmentCloud.conflict.version.title': 'Dieser Nachtragsentwurf wurde auf einem anderen Gerät geändert.',
  'orderAmendmentCloud.conflict.version.body':
    'Die Fassung auf diesem Gerät und die Fassung aus der Cloud weichen voneinander ab. Es wird nichts automatisch zusammengeführt. Bis zu Ihrer Entscheidung ist der Entwurf gesperrt.',
  'orderAmendmentCloud.conflict.deleted.title': 'Dieser Nachtragsentwurf wurde auf einem anderen Gerät verworfen.',
  'orderAmendmentCloud.conflict.deleted.body':
    'Ein verworfener Entwurf wird nicht wiederhergestellt. Sie können den Inhalt dieses Geräts als neuen Nachtragsentwurf behalten oder das Verwerfen annehmen.',
  'orderAmendmentCloud.conflict.consumed.title': 'Dieser Nachtrag wurde bereits auf einem anderen Gerät bestätigt.',
  'orderAmendmentCloud.conflict.consumed.body':
    'Der bestätigte Nachtrag ist verbindlich. Ihre abweichenden Eingaben auf diesem Gerät sind darin nicht enthalten. Sie können sie als neuen Nachtragsentwurf behalten.',
  'orderAmendmentCloud.conflict.discardRejected.title': 'Ihr Verwerfen wurde nicht übernommen.',
  'orderAmendmentCloud.conflict.discardRejected.body':
    'Der Nachtragsentwurf wurde inzwischen auf einem anderen Gerät geändert und ist deshalb wieder da. Sie können ihn behalten oder erneut verwerfen.',
  'orderAmendmentCloud.confirm.notSynced':
    'Der Nachtragsentwurf ist noch nicht vollständig in der Cloud angekommen. Bitte prüfen Sie die Verbindung und versuchen Sie es erneut.',
  'orderAmendmentCloud.confirm.conflict':
    'Der Nachtragsentwurf weicht von der Fassung in der Cloud ab. Bitte entscheiden Sie zuerst über die Fassung.',
  'orderAmendmentCloud.confirm.ended': 'Dieser Nachtragsentwurf wurde auf einem anderen Gerät verworfen. Es wird kein Nachtrag bestätigt.',
  'orderAmendmentCloud.confirm.consumed':
    'Dieser Nachtrag wurde bereits auf einem anderen Gerät bestätigt. Es entsteht kein zweiter Nachtrag.',
  'order_amendment_conflict_open': 'Bitte entscheiden Sie zuerst über die abweichende Fassung dieses Nachtragsentwurfs.',
  'order_amendment_persist_failed': 'Der Nachtragsentwurf konnte auf diesem Gerät nicht gespeichert werden. Es wurde nichts übernommen.',
};
