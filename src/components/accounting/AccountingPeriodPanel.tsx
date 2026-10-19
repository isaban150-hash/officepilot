/**
 * STEUERBERATER-06B — der Monatsabschluss im Steuerberaterbereich.
 *
 * Drei Dinge, in dieser Reihenfolge: Wo steht der Monat, was fehlt noch, und
 * welche Aktion gibt es. Danach der Verlauf.
 *
 * Der Abschlussknopf erscheint **nur**, wenn der Monat bereit ist. Ein
 * deaktivierter Knopf ohne Grund wäre eine Sackgasse; deshalb stehen die
 * Blocker darüber, einzeln und mit Anzahl.
 *
 * Nirgends steht „festgeschrieben", „GoBD" oder „rechtssicher". OfficeTakt
 * sperrt nach dem Abschluss nichts — es erkennt spätere Änderungen. Genau das
 * sagen die Hinweistexte, nicht mehr.
 */
import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { DataRow } from '../ui/Card';
import { SummaryList } from '../ui/Section';
import { Badge } from '../ui/Badge';
import { InlineNotice } from '../ui/States';
import { closureFingerprintVersion } from '../../services/accounting/accountingPeriodFingerprint';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
import { Dialog } from '../ui/Dialog';
import { formatDisplayDatePadded } from '../../utils/displayFormat';
import {
  closeAccountingPeriod,
  reopenAccountingPeriod,
} from '../../services/accounting/accountingPeriodService';
import type {
  AccountingPeriodReadiness,
  AccountingPeriodState,
} from '../../types/accountingPeriod';
import type { TranslationKey } from '../../i18n';

interface Props {
  state: AccountingPeriodState;
  /** Menschenlesbarer Monatsname, z. B. „September 2026". */
  monthLabel: string;
  onChanged: () => void;
  translate: (key: TranslationKey) => string;
  /**
   * 01H — die Nutzer-ID des angemeldeten Nutzers (dieselbe, die der Server
   * als `auth.uid()` in `closed_by` schreibt). Ohne Anmeldung `undefined` —
   * dann wird niemand eingetragen und auch niemand erfunden.
   */
  closedBy?: string;
  /**
   * GO-LIVE-SECURITY-01 / ABSCHLUSS — Monat abschließen und wieder öffnen nur
   * Inhaber und Verwaltung. Ohne Angabe wie bisher (lokaler Betrieb, Tests);
   * die Steuerberaterseite gibt die Rollenauskunft mit.
   */
  canWrite?: boolean;
}

function readinessTone(readiness: AccountingPeriodReadiness): 'neutral' | 'warning' | 'success' | 'critical' {
  switch (readiness) {
    case 'closed':
      return 'success';
    case 'ready':
      return 'success';
    case 'changed_after_close':
      return 'critical';
    case 'not_ready':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Bericht 20 — die unbestätigten Quellen je Art („2 Ausgaben, 1 Mitarbeiterzahlung“), je Quelle einmal. */
function unconfirmedBreakdown(state: AccountingPeriodState, translate: Props['translate']): string | null {
  const sources = state.unconfirmedSources ?? [];
  if (sources.length === 0) return null;
  const perType = new Map<string, Set<string>>();
  for (const source of sources) {
    const ids = perType.get(source.sourceType) ?? new Set<string>();
    ids.add(`${source.sourceId}#${source.paymentId ?? ''}`);
    perType.set(source.sourceType, ids);
  }
  return [...perType.entries()]
    .map(([type, ids]) =>
      translate(`accountingPeriod.unconfirmed.type.${type}` as TranslationKey).replace('{count}', String(ids.size)),
    )
    .join(' · ');
}

export function AccountingPeriodPanel({ state, monthLabel, onChanged, translate, closedBy, canWrite = true }: Props) {
  const { readiness, blockers, currentManifest, activeClosure, revisionHistory } = state;
  // Systemische Gesamtnacharbeit (D1) — was jede Revision gegenüber der Cloud ist (eine Quelle mit Gate und Paket).
  const status = state.revisionStatus ?? {};
  const aktiverStatus = state.activeClosureStatus ?? null;
  const unconfirmedDetail = unconfirmedBreakdown(state, translate);
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reason, setReason] = useState('');
  const closeTriggerRef = useRef<HTMLButtonElement>(null);
  const reopenTriggerRef = useRef<HTMLButtonElement>(null);

  const documentCount = currentManifest.documentCount;
  /*
   * Ein leerer Monat lässt sich abschliessen, aber nicht versehentlich: Er gilt
   * nicht als „bereit", und der Dialog sagt ausdrücklich, dass keine Belege
   * dabei sind. Ihn gar nicht abschliessen zu können wäre auch falsch —
   * Betriebsferien sind ein legitimer Monat.
   */
  const canClose = blockers.length === 0 && !activeClosure;

  return (
    <div data-testid="accounting-period">
      <SummaryList columns={2} testId="accounting-period-summary">
        <DataRow
          label={translate('accountingPeriod.state')}
          value={
            <Badge tone={readinessTone(readiness)} data-testid="accounting-period-state">
              {translate(`accountingPeriod.state.${readiness}` as TranslationKey)}
            </Badge>
          }
        />
        <DataRow
          label={translate('accountingPeriod.documents')}
          value={<span data-testid="accounting-period-count">{String(documentCount)}</span>}
        />
        {activeClosure ? (
          <>
            <DataRow
              label={translate('accountingPeriod.closedAt')}
              value={
                <span data-testid="accounting-period-closed-at">
                  {formatDisplayDatePadded(activeClosure.closedAt)}
                </span>
              }
            />
            <DataRow
              label={translate('accountingPeriod.revision')}
              value={
                <span data-testid="accounting-period-revision">{String(activeClosure.revision)}</span>
              }
            />
            {aktiverStatus ? (
              <DataRow
                label={translate('accountingPeriod.status.label')}
                value={
                  <span data-testid={`accounting-period-cloud-status-${aktiverStatus}`}>
                    <Badge tone={aktiverStatus === 'angenommen' ? 'success' : aktiverStatus === 'lokal' ? 'neutral' : 'warning'}>
                      {translate(`accountingPeriod.status.${aktiverStatus}` as TranslationKey)}
                    </Badge>
                    {aktiverStatus === 'angenommen' && activeClosure.server
                      ? ` ${translate('accountingPeriod.status.serverDetail')
                          .replace('{revision}', String(activeClosure.server.revision))
                          .replace('{datenstand}', String(activeClosure.server.datenstand ?? ''))}`
                      : ''}
                  </span>
                }
              />
            ) : null}
          </>
        ) : null}
      </SummaryList>

      {documentCount === 0 ? (
        <p className="detail-empty" data-testid="accounting-period-empty">
          {translate('accountingPeriod.noDocuments')}
        </p>
      ) : null}

      {/*
        * Die Blocker einzeln und mit Anzahl. „Nicht bereit" allein wäre eine
        * Sackgasse — der Nutzer muss wissen, was er tun soll.
        */}
      {blockers.length > 0 ? (
        <>
          <h3 className="ui-section-header__title">{translate('accountingPeriod.blockersTitle')}</h3>
          <ul className="detail-list" data-testid="accounting-period-blockers">
            {blockers.map((item) => (
              <li key={item.code} data-testid={`accounting-period-blocker-${item.code}`}>
                {translate(`accountingPeriod.blocker.${item.code}` as TranslationKey).replace(
                  '{count}',
                  String(item.count),
                )}
                {item.code === 'unconfirmed_financial_changes' && unconfirmedDetail ? (
                  <>
                    <br />
                    <span data-testid="accounting-period-unconfirmed-detail">{unconfirmedDetail}</span>
                    <br />
                    <span data-testid="accounting-period-unconfirmed-hint">
                      {translate('accountingPeriod.unconfirmed.hint')}
                    </span>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {readiness === 'changed_after_close' ? (
        <InlineNotice tone="critical" testId="accounting-period-changed">
          {translate('accountingPeriod.changedHint')}
        </InlineNotice>
      ) : null}

      {readiness === 'closed' ? (
        <InlineNotice tone="info" testId="accounting-period-closed-hint">
          {translate('accountingPeriod.closedHint')}
        </InlineNotice>
      ) : null}

      {/*
        FINANZ-CORE-01A (Gesamtnacharbeit INV-04) — ein Abschluss älterer Fassung bleibt nach seiner
        Logik gültig, deckt aber Skonto und Zahlungsart nicht ab. Das steht sichtbar daneben, statt ihn
        still umzudeuten.
      */}
      {activeClosure && closureFingerprintVersion(activeClosure) < 4 ? (
        <InlineNotice tone="warning" testId="accounting-period-legacy-version">
          {translate('accountingPeriod.legacyVersionHint').replace(
            '{version}',
            String(closureFingerprintVersion(activeClosure)),
          )}
        </InlineNotice>
      ) : null}

      {/* Systemische Gesamtnacharbeit (D1) — nicht cloudbestätigt heißt es auch, sichtbar und mit Weg. */}
      {aktiverStatus === 'ausstehend' || aktiverStatus === 'konflikt' ? (
        <InlineNotice tone="warning" testId="accounting-period-cloud-pending">
          {translate('accountingPeriod.status.pendingHint')}
        </InlineNotice>
      ) : null}
      {aktiverStatus === 'historisch' ? (
        <InlineNotice tone="warning" testId="accounting-period-cloud-historical">
          {translate('accountingPeriod.status.historicalHint')}
        </InlineNotice>
      ) : null}

      {!canWrite && (canClose || activeClosure) ? (
        <p className="detail-hint" data-testid="accounting-period-role-hint">
          {translate('accounting.period.roleHint')}
        </p>
      ) : null}

      <div className="vorgang-dialog__actions">
        {canClose && canWrite ? (
          <Button
            ref={closeTriggerRef}
            type="button"
            onClick={() => setCloseOpen(true)}
            data-testid="accounting-period-close"
          >
            {translate('accountingPeriod.action.close')}
          </Button>
        ) : null}
        {activeClosure && canWrite ? (
          <Button
            ref={reopenTriggerRef}
            type="button"
            variant="outline"
            onClick={() => {
              setReason('');
              setReopenOpen(true);
            }}
            data-testid="accounting-period-reopen"
          >
            {translate('accountingPeriod.action.reopen')}
          </Button>
        ) : null}
      </div>

      {/* ---------------- Abschlussverlauf ---------------- */}
      {revisionHistory.length > 0 ? (
        <>
          <h3 className="ui-section-header__title">{translate('accountingPeriod.historyTitle')}</h3>
          <ul className="detail-list" data-testid="accounting-period-history">
            {revisionHistory.map((closure) => (
              <li key={closure.id} data-testid={`accounting-period-history-${closure.revision}`}>
                {translate('accountingPeriod.revision')} {closure.revision}
                {' · '}
                {translate('accountingPeriod.closedAt')}{' '}
                {formatDisplayDatePadded(closure.closedAt)}
                {' · '}
                {closure.reopenedAt
                  ? translate('accountingPeriod.history.reopened')
                  : closure.cloudAbweisung
                    ? translate('accountingPeriod.status.abgewiesen')
                    : translate('accountingPeriod.history.current')}
                {closure.reopenReason
                  ? ` · ${translate('accountingPeriod.history.reason')}: ${closure.reopenReason}`
                  : ''}
                {/* Systemische Gesamtnacharbeit (D1/D7) — Cloudstatus je Revision; abgewiesen mit Grund und Weg. */}
                {status[closure.id] && !closure.cloudAbweisung ? (
                  <span data-testid={`accounting-period-history-status-${closure.revision}`}>
                    {' · '}
                    {translate(`accountingPeriod.status.${status[closure.id]}` as TranslationKey)}
                  </span>
                ) : null}
                {closure.cloudAbweisung ? (
                  <span data-testid={`accounting-period-history-rejected-${closure.revision}`}>
                    {' · '}
                    {translate('accountingPeriod.status.rejectedReason').replace('{reason}', closure.cloudAbweisung.meldung)}
                    {' · '}
                    {translate('accountingPeriod.status.rejectedHint')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* ---------------- Dialoge ---------------- */}
      <SimpleConfirmDialog
        open={closeOpen}
        title={translate('accountingPeriod.closeDialog.title')}
        message={
          documentCount === 0
            ? translate('accountingPeriod.closeDialog.messageEmpty').replace('{month}', monthLabel)
            : translate('accountingPeriod.closeDialog.message')
                .replace('{month}', monthLabel)
                .replace('{count}', String(documentCount))
        }
        confirmLabel={translate('accountingPeriod.closeDialog.confirm')}
        cancelLabel={translate('common.cancel')}
        confirmVariant="primary"
        confirmTestId="accounting-period-close-confirm"
        cancelTestId="accounting-period-close-cancel"
        dialogTestId="accounting-period-close-dialog"
        failureMessage={translate('accountingPeriod.closeDialog.failed')}
        returnFocusRef={closeTriggerRef}
        onConfirm={() => {
          const result = closeAccountingPeriod(state.monthKey, { closedBy });
          if (!result.success) return false;
          setCloseOpen(false);
          onChanged();
          return true;
        }}
        onCancel={() => setCloseOpen(false)}
      />

      {/*
        * Der Wiederöffnungsdialog nutzt die Dialog-Basis direkt, weil er ein
        * Eingabefeld trägt: `SimpleConfirmDialog` nimmt keine Kinder auf.
        * Dieselbe Basis und dieselbe Fokusfalle wie dort — nur eine Stufe
        * tiefer angesetzt, statt eine zweite Dialogwelt zu bauen.
        */}
      <Dialog
        open={reopenOpen}
        title={translate('accountingPeriod.reopenDialog.title')}
        description={translate('accountingPeriod.reopenDialog.message')}
        onClose={() => setReopenOpen(false)}
        returnFocusRef={reopenTriggerRef}
        testId="accounting-period-reopen-dialog"
        actions={
          <>
            <Button
              variant="outline"
              fullWidth
              onClick={() => setReopenOpen(false)}
              data-testid="accounting-period-reopen-cancel"
            >
              {translate('common.cancel')}
            </Button>
            <Button
              fullWidth
              data-testid="accounting-period-reopen-confirm"
              onClick={() => {
                const result = reopenAccountingPeriod(state.monthKey, { reason });
                if (!result.success) return;
                setReopenOpen(false);
                onChanged();
              }}
            >
              {translate('accountingPeriod.reopenDialog.confirm')}
            </Button>
          </>
        }
      >
        {/*
          * Der Grund ist freiwillig. Ihn zur Pflicht zu machen erzeugte nur
          * Pflichttexte wie „Korrektur" — ein Feld, das man ausfüllen muss,
          * sagt am Ende weniger als eines, das man ausfüllen will.
          */}
        <label className="invoice-payment-form__field" data-testid="accounting-period-reason-field">
          <span>{translate('accountingPeriod.reopenDialog.reason')}</span>
          <input
            type="text"
            className="input"
            value={reason}
            data-testid="accounting-period-reason"
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </Dialog>
    </div>
  );
}
