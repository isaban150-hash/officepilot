import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import {
  adoptCloudInvoiceSentStateAfterRoleDenial,
  captureInvoiceSentState,
  formatInvoiceSentViaLabel,
  INVOICE_SENT_VIA_OPTIONS,
  isInvoiceSentCloudSyncSilent,
  markInvoiceAsSent,
  revertInvoiceSentAfterRoleDenial,
  syncInvoiceSentToCloud,
  updateInvoiceSentDetails,
  type InvoiceSentCloudState,
  type InvoiceSentInput,
} from '../../services/invoiceSentService';
import { useOptionalAuth } from '../../context/AuthContext';
import { isSupabaseConfigured } from '../../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import { applyInvoiceSentSnapshotFromCloud } from '../../services/vorgangService';
import type { InvoiceSentSnapshot } from '../../services/invoice/invoiceSentSnapshot';
import { isSentDateAfterPaymentDue } from '../../services/invoicePaymentService';
import type { InvoiceSentVia, VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { getBusinessDay } from '../../services/businessDateService';

interface Props {
  /** MANUAL-INVOICE-UI-01B2 — `null` ist die freie Rechnung ohne Auftrag. */
  vorgangId: string | null;
  invoice: VorgangInvoice;
  translate: (key: TranslationKey) => string;
  onUpdated: (invoice: VorgangInvoice) => void;
  /**
   * INVOICE-SENT-CLOUD-DURABILITY-01B — der abgeleitete Cloud-Versandstand.
   * `null` heisst „noch nicht abgefragt" und wird wie `unknown` behandelt:
   * kein Beweis, keine Aussage.
   */
  cloudState?: InvoiceSentCloudState | null;
  onCloudStateChange?: (state: InvoiceSentCloudState) => void;
  /**
   * GO-LIVE-SECURITY-01 — die Detailseite hat auf dem Gerät eines Mitglieds
   * einen nicht freigegebenen Versandstand auf den Cloud-Stand zurückgesetzt.
   */
  roleAligned?: boolean;
}

type FormMode = 'closed' | 'mark' | 'correct' | 'confirm-mark' | 'confirm-correct';

function todayIso(): string {
  return getBusinessDay();
}

function formatDisplayDate(value: string): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}

export function InvoiceSentPanel({
  vorgangId,
  invoice,
  translate,
  onUpdated,
  cloudState = null,
  onCloudStateChange,
  roleAligned = false,
}: Props) {
  /*
   * GO-LIVE-SECURITY-01 — den Versand vermerken ist verbindlich: nur Inhaber
   * und Verwaltung. Mitglieder sehen den Stand und einen Rollenhinweis; die
   * Dienste prüfen dieselbe Rolle noch einmal vor jeder lokalen Änderung.
   */
  const authUser = useOptionalAuth()?.user;
  const actor = { userId: authUser?.id, cloudConfigured: isSupabaseConfigured() };
  const darfVermerken = resolveWorkspaceWriteAccess(actor).canWrite;
  const [roleDenied, setRoleDenied] = useState(false);
  const [mode, setMode] = useState<FormMode>('closed');
  const [sentAt, setSentAt] = useState(todayIso());
  const [sentVia, setSentVia] = useState<InvoiceSentVia>('email');
  const [sentNote, setSentNote] = useState('');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  useEffect(() => {
    if (mode !== 'mark' && mode !== 'correct') return;
    if (mode === 'mark') {
      setSentAt(todayIso());
      setSentVia('email');
      setSentNote('');
    } else {
      setSentAt(invoice.sentAt?.trim() || todayIso());
      setSentVia(invoice.sentVia ?? 'email');
      setSentNote(invoice.sentNote ?? '');
    }
    setErrorKey(null);
  }, [mode, invoice.id, invoice.sentAt, invoice.sentVia, invoice.sentNote]);

  const closeAll = () => {
    setMode('closed');
    setErrorKey(null);
  };

  const [cloudWarning, setCloudWarning] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);

  const buildInput = (): InvoiceSentInput => ({
    sentAt,
    sentVia,
    sentNote: sentNote.trim() || undefined,
  });

  const handleConfirm = () => {
    if (!darfVermerken) {
      setErrorKey('invoice.sent.error.forbidden');
      return;
    }
    const input = buildInput();
    // GO-LIVE-SECURITY-01 — der Stand davor, falls der Server den Vermerk abweist.
    const vorher = captureInvoiceSentState(vorgangId, invoice.id);
    const result =
      mode === 'confirm-mark'
        ? markInvoiceAsSent(vorgangId, invoice.id, input, actor)
        : updateInvoiceSentDetails(vorgangId, invoice.id, input, actor);

    if (!result.ok) {
      if (result.reason === 'forbidden') {
        setErrorKey('invoice.sent.error.forbidden');
      } else if (result.reason === 'invalid_date') {
        setErrorKey('invoice.sent.error.date');
      } else if (result.reason === 'invalid_via') {
        setErrorKey('invoice.sent.error.via');
      } else if (result.reason === 'not_prepared' || result.reason === 'already_sent') {
        setErrorKey('invoice.sent.error.notPrepared');
      } else if (result.reason === 'cancelled') {
        // FINANZ-CORE-01A (STO-04/AUS-09) — storniert ist storniert; ein Vermerk entstünde ohne Korrekturbeleg.
        setErrorKey('invoice.sent.error.cancelled');
      } else {
        /*
         * INVOICE-SENT-PERSIST-01C — `persist_failed` kommt jetzt aus dem
         * Mutationsvertrag selbst. Der Dialog bleibt offen, der Status bleibt
         * vorbereitet, und der Nutzer kann es unmittelbar erneut versuchen.
         */
        setErrorKey('invoice.sent.error.failed');
      }
      return;
    }

    /*
     * Erst hier — der Erfolg ist dauerhaft geschrieben. Vorher wurde `onUpdated`
     * bereits vor der Persistenzprüfung aufgerufen und die Oberfläche zeigte
     * einen Versand, den es nach dem nächsten Rehydrieren nicht mehr gab.
     */
    onUpdated(result.invoice);
    closeAll();
    setRoleDenied(false);

    /*
     * INVOICE-SENT-CLOUD-DURABILITY-04B1 — der lokale Stand steht bereits fest
     * und wird nicht zurückgenommen. Gelingt die geräteübergreifende Sicherung
     * nicht, darf die Oberfläche das aber nicht verschweigen: Auf einem anderen
     * Gerät stünde die Rechnung sonst weiterhin auf „vorbereitet“.
     *
     * GO-LIVE-SECURITY-01 — mit einer Ausnahme: Weist der Server den Vermerk
     * wegen der Rolle ab, war er nie zulässig. Dann gilt wieder der Stand
     * davor; ein Scheinerfolg gäbe auf diesem Gerät Mahnung und Folgeaktionen frei.
     */
    void syncInvoiceSentToCloud(vorgangId, invoice.id, actor)
      .then((outcome) => {
        if (outcome === 'forbidden' && vorher) {
          const zurueck = revertInvoiceSentAfterRoleDenial(vorgangId, invoice.id, vorher);
          if (zurueck.ok) onUpdated(zurueck.invoice);
          setCloudWarning(false);
          setRoleDenied(true);
          return;
        }
        setCloudWarning(!isInvoiceSentCloudSyncSilent(outcome));
        /*
         * 01B — nur ein bewiesener Erfolg wird behauptet. Bei jedem anderen
         * Ausgang bleibt die Aussage aus; der Einzelread beim nächsten Öffnen
         * unterscheidet dann zuverlässig zwischen `pending`, `conflict` und
         * `missing`. Der lokale Stand wird nie zurückgenommen.
         */
        if (outcome === 'synced') onCloudStateChange?.({ kind: 'synced' });
      })
      /*
       * 04B1S — doppelt abgesichert: Der Dienst ist zwar total, aber ein
       * unbekannter technischer Fehler darf unter keinen Umständen als Erfolg
       * durchgehen. Lieber eine Warnung zu viel als ein stiller Verlust.
       */
      .catch(() => setCloudWarning(true));
  };

  /**
   * 01B — „Jetzt sichern" und „Lokalen Stand verwenden" sind dieselbe Handlung:
   * den lokalen Versandsatz über die **bestehende** Write-RPC hochladen. Keine
   * zweite Mutation, keine Sonderbehandlung.
   */
  const secureLocalToCloud = async (): Promise<void> => {
    if (cloudBusy || !darfVermerken) return;
    setCloudBusy(true);
    setCloudWarning(false);
    const outcome = await syncInvoiceSentToCloud(vorgangId, invoice.id, actor);
    if (outcome === 'forbidden') {
      // GO-LIVE-SECURITY-01 — bewiesen nicht freigegeben: der Stand der Cloud gilt.
      const uebernommen = await adoptCloudInvoiceSentStateAfterRoleDenial(vorgangId, invoice.id);
      if (uebernommen) {
        onUpdated(uebernommen);
        onCloudStateChange?.({ kind: 'synced' });
      }
      setRoleDenied(true);
    } else if (outcome === 'synced') {
      onCloudStateChange?.({ kind: 'synced' });
    } else if (!isInvoiceSentCloudSyncSilent(outcome)) {
      // Der Hinweis bleibt stehen; der nächste Read entscheidet erneut.
      setCloudWarning(true);
    }
    setCloudBusy(false);
  };

  /**
   * 01B — der ausdrücklich gewählte Online-Stand. Kein Cloud-Write nötig: Die
   * Cloud trägt bereits genau den Stand, den der Nutzer will.
   */
  const adoptCloudSnapshot = (snapshot: InvoiceSentSnapshot): void => {
    if (cloudBusy) return;
    setCloudBusy(true);
    const result = applyInvoiceSentSnapshotFromCloud(vorgangId, invoice.id, snapshot);
    if (result.ok) {
      onUpdated(result.invoice);
      onCloudStateChange?.({ kind: 'synced' });
    } else {
      setErrorKey('invoice.sent.error.failed');
    }
    setCloudBusy(false);
  };

  const showForm = mode === 'mark' || mode === 'correct';
  const showConfirm = mode === 'confirm-mark' || mode === 'confirm-correct';
  const isSent = invoice.status === 'versendet';
  const lateSentHintDate = showForm || showConfirm ? sentAt : invoice.sentAt;
  const showLateSentHint = isSentDateAfterPaymentDue(lateSentHintDate, invoice.paymentDueDate);

  return (
    <section className="invoice-sent-panel" data-testid="invoice-sent-panel">
      <Card>
        <CardTitle>{translate('invoice.sent.title')}</CardTitle>
        <p className="invoice-sent-panel__hint" data-testid="invoice-sent-hint">
          {translate('invoice.sent.hint')}
        </p>

        {cloudWarning ? (
          <p className="invoice-sent-panel__error" data-testid="invoice-sent-cloud-warning">
            {translate('invoice.sent.cloudOnlyLocal')}
          </p>
        ) : null}

        {roleDenied ? (
          <p className="invoice-sent-panel__error" data-testid="invoice-sent-forbidden">
            {translate('invoice.sent.error.forbidden')}
          </p>
        ) : null}

        {roleAligned ? (
          <p className="invoice-sent-panel__error" data-testid="invoice-sent-role-aligned">
            {translate('invoice.sent.roleAligned')}
          </p>
        ) : null}

        {/*
          * 01B — der dauerhaft rekonstruierbare Cloud-Zustand.
          *
          * `missing`, `unknown` und `not_configured` zeigen bewusst **nichts**:
          * Bei der fehlenden Cloud-Zeile kann die Update-RPC nichts ausrichten,
          * bei den anderen beiden gibt es keinen Beweis. Ein Knopf, der nie
          * gelingen kann, wäre schlimmer als Schweigen.
          */}
        {cloudState?.kind === 'pending' && darfVermerken ? (
          <div className="invoice-sent-panel__cloud" data-testid="invoice-sent-cloud-pending">
            <p className="invoice-sent-panel__error">{translate('invoice.sent.cloudPending')}</p>
            <Button
              type="button"
              fullWidth
              disabled={cloudBusy}
              onClick={() => void secureLocalToCloud()}
              data-testid="invoice-sent-secure-now"
            >
              {translate('invoice.sent.secureNow')}
            </Button>
          </div>
        ) : null}

        {cloudState?.kind === 'conflict' || cloudState?.kind === 'cloud_only' ? (
          <div className="invoice-sent-panel__cloud" data-testid="invoice-sent-cloud-conflict">
            <p className="invoice-sent-panel__error">
              {translate(
                cloudState.kind === 'conflict'
                  ? 'invoice.sent.cloudConflict'
                  : 'invoice.sent.cloudOnlyRemote',
              )}
            </p>

            {cloudState.kind === 'conflict' ? (
              <dl className="invoice-sent-panel__facts" data-testid="invoice-sent-local-side">
                <div>
                  <dt>{translate('invoice.sent.localSide')}</dt>
                  <dd>
                    {formatDisplayDate(invoice.sentAt ?? '')} ·{' '}
                    {formatInvoiceSentViaLabel(invoice.sentVia, translate)}
                    {invoice.sentNote?.trim() ? ` · ${invoice.sentNote}` : ''}
                  </dd>
                </div>
              </dl>
            ) : null}

            <dl className="invoice-sent-panel__facts" data-testid="invoice-sent-cloud-side">
              <div>
                <dt>{translate('invoice.sent.cloudSide')}</dt>
                <dd>
                  {formatDisplayDate(cloudState.cloud.sentAt)} ·{' '}
                  {formatInvoiceSentViaLabel(cloudState.cloud.sentVia, translate)}
                  {cloudState.cloud.sentNote ? ` · ${cloudState.cloud.sentNote}` : ''}
                </dd>
              </div>
            </dl>

            {cloudState.kind === 'conflict' && darfVermerken ? (
              <Button
                type="button"
                fullWidth
                disabled={cloudBusy}
                onClick={() => void secureLocalToCloud()}
                data-testid="invoice-sent-use-local"
              >
                {translate('invoice.sent.useLocal')}
              </Button>
            ) : null}

            <Button
              type="button"
              variant="outline"
              fullWidth
              disabled={cloudBusy}
              onClick={() => adoptCloudSnapshot(cloudState.cloud)}
              data-testid="invoice-sent-use-cloud"
            >
              {translate('invoice.sent.useCloud')}
            </Button>
          </div>
        ) : null}

        {showLateSentHint && isSent && mode === 'closed' ? (
          <p className="invoice-sent-panel__late-due" data-testid="invoice-sent-late-due">
            {translate('invoice.sent.dueAlreadyPassed').replace(
              '{due}',
              formatDisplayDate(invoice.paymentDueDate ?? ''),
            )}
          </p>
        ) : null}

        {isSent ? (
          <div className="invoice-sent-panel__status" data-testid="invoice-sent-status">
            <dl className="invoice-sent-panel__facts">
              <div>
                <dt>{translate('invoice.sent.date')}</dt>
                <dd data-testid="invoice-sent-at">{formatDisplayDate(invoice.sentAt ?? '')}</dd>
              </div>
              <div>
                <dt>{translate('invoice.sent.via')}</dt>
                <dd data-testid="invoice-sent-via">
                  {formatInvoiceSentViaLabel(invoice.sentVia, translate)}
                </dd>
              </div>
              {invoice.sentNote?.trim() ? (
                <div>
                  <dt>{translate('invoice.sent.note')}</dt>
                  <dd data-testid="invoice-sent-note">{invoice.sentNote}</dd>
                </div>
              ) : null}
            </dl>
            {mode === 'closed' && darfVermerken ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMode('correct')}
                data-testid="invoice-sent-correct"
              >
                {translate('invoice.sent.correct')}
              </Button>
            ) : null}
          </div>
        ) : (
          <div data-testid="invoice-sent-prepared">
            <p className="invoice-sent-panel__meta">
              {translate('invoice.sent.notSentYet')}
            </p>
            {/* FINANZ-CORE-01A (STO-04/AUS-09) — keine Versandmarkierung nach einem Storno. */}
            {mode === 'closed' && darfVermerken && !invoice.cancelledAt ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setMode('mark')}
                data-testid="invoice-sent-mark"
              >
                {translate('invoice.sent.mark')}
              </Button>
            ) : null}
            {invoice.cancelledAt ? (
              <p className="invoice-sent-panel__meta" data-testid="invoice-sent-cancelled-hint">
                {translate('invoice.sent.cancelledHint')}
              </p>
            ) : null}
          </div>
        )}

        {!darfVermerken ? (
          <p className="invoice-sent-panel__meta" data-testid="invoice-sent-role-hint">
            {translate('invoice.sent.roleHint')}
          </p>
        ) : null}

        {showForm ? (
          <form
            className="invoice-sent-panel__form"
            data-testid="invoice-sent-form"
            onSubmit={(event) => {
              event.preventDefault();
              setMode(mode === 'mark' ? 'confirm-mark' : 'confirm-correct');
            }}
          >
            {/* FINANZ-CORE-01A (AUS-19) — ein OfficeTakt-Versand bleibt belegt; ein abweichender Vermerk ist manuell. */}
            {mode === 'correct' && invoice.sentSource === 'officepilot' ? (
              <p className="invoice-sent-panel__hint" data-testid="invoice-sent-officepilot-hint">
                {translate('invoice.sent.officepilotCorrectHint')}
              </p>
            ) : null}
            <label className="invoice-sent-panel__label" htmlFor="invoice-sent-date">
              {translate('invoice.sent.date')}
            </label>
            <input
              id="invoice-sent-date"
              type="date"
              className="input"
              value={sentAt}
              // FINANZ-CORE-01A (SQL-15) — kein Versanddatum in der Zukunft.
              max={getBusinessDay()}
              onChange={(event) => setSentAt(event.target.value)}
              required
              data-testid="invoice-sent-date-input"
            />

            <label className="invoice-sent-panel__label" htmlFor="invoice-sent-via-input">
              {translate('invoice.sent.via')}
            </label>
            <select
              id="invoice-sent-via-input"
              className="input"
              value={sentVia}
              onChange={(event) => setSentVia(event.target.value as InvoiceSentVia)}
              data-testid="invoice-sent-via-input"
            >
              {INVOICE_SENT_VIA_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {translate(`invoice.sent.via.${option}` as TranslationKey)}
                </option>
              ))}
            </select>

            <label className="invoice-sent-panel__label" htmlFor="invoice-sent-note-input">
              {translate('invoice.sent.noteOptional')}
            </label>
            <textarea
              id="invoice-sent-note-input"
              className="input"
              rows={2}
              value={sentNote}
              onChange={(event) => setSentNote(event.target.value)}
              data-testid="invoice-sent-note-input"
            />

            {errorKey ? (
              <p className="invoice-sent-panel__error" data-testid="invoice-sent-error">
                {translate(errorKey)}
              </p>
            ) : null}

            {showLateSentHint ? (
              <p className="invoice-sent-panel__late-due" data-testid="invoice-sent-late-due">
                {translate('invoice.sent.dueAlreadyPassed').replace(
                  '{due}',
                  formatDisplayDate(invoice.paymentDueDate ?? ''),
                )}
              </p>
            ) : null}

            <div className="invoice-sent-panel__actions">
              <Button type="button" variant="outline" size="sm" onClick={closeAll}>
                {translate('common.cancel')}
              </Button>
              <Button type="submit" size="sm" data-testid="invoice-sent-continue">
                {translate('invoice.sent.continue')}
              </Button>
            </div>
          </form>
        ) : null}

        {showConfirm ? (
          <div className="invoice-sent-panel__confirm" data-testid="invoice-sent-confirm">
            <p>{translate('invoice.sent.confirmText')}</p>
            <p className="invoice-sent-panel__confirm-summary">
              {formatDisplayDate(sentAt)} · {formatInvoiceSentViaLabel(sentVia, translate)}
            </p>
            {showLateSentHint ? (
              <p className="invoice-sent-panel__late-due" data-testid="invoice-sent-late-due">
                {translate('invoice.sent.dueAlreadyPassed').replace(
                  '{due}',
                  formatDisplayDate(invoice.paymentDueDate ?? ''),
                )}
              </p>
            ) : null}
            {errorKey ? (
              <p className="invoice-sent-panel__error" data-testid="invoice-sent-error">
                {translate(errorKey)}
              </p>
            ) : null}
            <div className="invoice-sent-panel__actions">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMode(mode === 'confirm-mark' ? 'mark' : 'correct')}
                data-testid="invoice-sent-confirm-back"
              >
                {translate('common.back')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleConfirm}
                data-testid="invoice-sent-confirm-submit"
              >
                {translate('invoice.sent.confirm')}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
