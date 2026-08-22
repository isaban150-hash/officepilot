import { useEffect, useRef, useState } from 'react';
import { AuthLayout } from '../auth/AuthLayout';
import { Button } from '../ui/Button';
import { getCachedSetup } from '../../services/persistenceService';
import { t } from '../../i18n';
import type { CompanyConflictInfo } from '../../services/workspace/workspaceCompanyConflictService';

interface WorkspaceCompanyConflictProps {
  conflict: CompanyConflictInfo;
  busy: boolean;
  errorMessage?: string | null;
  /** True, sobald sich der Cloud-Stand seit der Anzeige verändert hat. */
  changed?: boolean;
  onCancel: () => void;
  onConfirmUseLocal: () => void;
}

/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02L — Übernahme nur nach mehreren
 * eindeutig getrennten Handlungen.
 *
 * Realer Vorfall: die Übertragung lief, ohne dass jemand eine zweite Stufe sah.
 * Deshalb gilt hier:
 *  1. „Lokale Firmendaten verwenden" öffnet nur einen getrennten Bereich —
 *     der Knopf bleibt an seiner Stelle stehen und wird nicht ersetzt.
 *  2. Eine eigene Checkbox muss aktiv gesetzt werden.
 *  3. Erst der räumlich getrennte Abschlussknopf überträgt.
 * Sichtbarkeitswechsel, pagehide und pageshow verwerfen die Stufe vollständig —
 * eine aus dem Safari-Cache zurückkehrende Seite darf nie „halb bestätigt" sein.
 */
export function WorkspaceCompanyConflict({
  conflict,
  busy,
  errorMessage,
  changed,
  onCancel,
  onConfirmUseLocal,
}: WorkspaceCompanyConflictProps) {
  const lang = getCachedSetup()?.language ?? 'de';
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  /**
   * Synchroner Riegel: der busy-Zustand des Elternteils steht beim zweiten
   * Ereignis desselben Tipps noch nicht, ein Ref dagegen schon.
   */
  const inFlightRef = useRef(false);

  useEffect(() => {
    const reset = () => {
      setConfirming(false);
      setAcknowledged(false);
      inFlightRef.current = false;
    };
    document.addEventListener('visibilitychange', reset);
    window.addEventListener('pagehide', reset);
    window.addEventListener('pageshow', reset);
    return () => {
      document.removeEventListener('visibilitychange', reset);
      window.removeEventListener('pagehide', reset);
      window.removeEventListener('pageshow', reset);
    };
  }, []);

  const handleFinalConfirm = () => {
    // Zusätzliche eigene Prüfung — unabhängig vom disabled-Zustand des Knopfes.
    if (!confirming || !acknowledged || busy || inFlightRef.current) return;
    inFlightRef.current = true;
    onConfirmUseLocal();
  };

  useEffect(() => {
    if (!busy) inFlightRef.current = false;
  }, [busy]);

  return (
    <AuthLayout
      title={t('companyConflict.title', lang)}
      subtitle={t('companyConflict.subtitle', lang)}
      testId="workspace-company-conflict"
    >
      <dl className="local-recovery-item__facts">
        <div>
          <dt>{t('companyConflict.localLabel', lang)}</dt>
          <dd data-testid="workspace-company-conflict-local">{conflict.localCompanyName}</dd>
        </div>
        <div>
          <dt>{t('companyConflict.localSavedAt', lang)}</dt>
          <dd>{conflict.localSavedAt ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('companyConflict.cloudLabel', lang)}</dt>
          <dd data-testid="workspace-company-conflict-cloud">{conflict.cloudCompanyName}</dd>
        </div>
        <div>
          <dt>{t('companyConflict.cloudVersion', lang)}</dt>
          <dd>
            {conflict.cloudSetupRowVersion} / {conflict.cloudProfileRowVersion}
          </dd>
        </div>
      </dl>

      <p className="form-hint">{t('companyConflict.sameWorkspace', lang)}</p>

      {/*
       * WORKSPACE-COMPANY-CONFLICT-SAFE-EXIT-01 — der bestehende Rettungsweg
       * wird benannt. Er sichert ausschließlich lokale Daten und löst den
       * Konflikt ausdrücklich **nicht** auf. Die Adresse ist auch bei aktiver
       * Sperre erreichbar, weil `RootShell` sie vor Anmeldung und Gate prüft.
       */}
      <p className="form-hint" data-testid="workspace-company-conflict-local-recovery">
        {t('companyConflict.localRecoveryHint', lang)}{' '}
        <a href="/local-recovery" data-testid="workspace-company-conflict-local-recovery-link">
          /local-recovery
        </a>
      </p>

      {changed ? (
        <p className="form-error" role="alert" data-testid="workspace-company-conflict-changed">
          {t('companyConflict.changed', lang)}
        </p>
      ) : null}
      {errorMessage ? (
        <p className="form-error" role="alert" data-testid="workspace-company-conflict-error">
          {errorMessage}
        </p>
      ) : null}
      {busy ? (
        <p className="form-hint" role="status" data-testid="workspace-company-conflict-busy">
          {t('companyConflict.busy', lang)}
        </p>
      ) : null}

      <div className="auth-form">
        <Button
          type="button"
          variant="ghost"
          fullWidth
          disabled={busy}
          data-testid="workspace-company-conflict-cancel"
          onClick={() => {
            setConfirming(false);
            setAcknowledged(false);
            onCancel();
          }}
        >
          {t('companyConflict.cancel', lang)}
        </Button>

        {/* Bleibt an seiner Stelle stehen — er wird nie durch den Endknopf ersetzt. */}
        <Button
          type="button"
          fullWidth
          disabled={busy || confirming}
          data-testid="workspace-company-conflict-use-local"
          onClick={() => setConfirming(true)}
        >
          {t('companyConflict.useLocal', lang)}
        </Button>
      </div>

      {confirming ? (
        <section
          className="company-conflict-final"
          data-testid="workspace-company-conflict-final-area"
        >
          <h2 className="company-conflict-final__title">{t('companyConflict.finalTitle', lang)}</h2>
          <p className="company-conflict-final__text">
            {t('companyConflict.localLabel', lang)}: {conflict.localCompanyName}
          </p>
          <p className="company-conflict-final__text">
            {t('companyConflict.cloudLabel', lang)}: {conflict.cloudCompanyName}
          </p>
          <p className="form-hint">{t('companyConflict.finalHint', lang)}</p>

          <label className="company-conflict-final__ack">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              data-testid="workspace-company-conflict-ack"
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>{t('companyConflict.ackLabel', lang)}</span>
          </label>

          <Button
            type="button"
            fullWidth
            disabled={busy || !acknowledged}
            data-testid="workspace-company-conflict-confirm"
            onClick={handleFinalConfirm}
          >
            {t('companyConflict.confirmUseLocal', lang)}
          </Button>
        </section>
      ) : null}
    </AuthLayout>
  );
}
