/**
 * STEUERBERATER-06C — die Übergabe im Monatsbereich.
 *
 * Zwei Ebenen, **getrennt bewertet und getrennt erklärt**:
 *
 *   - Das **Steuerberater-Paket** hängt an der fachlichen Vollständigkeit des
 *     Monats. Ist etwas offen, steht der Grund da — nicht erst nach einem
 *     Klick auf einen Knopf, der dann eine Fehlermeldung wirft.
 *   - Der **DATEV-Buchungsstapel** wird gar nicht erst angeboten. Statt eines
 *     toten Knopfes steht dort, was konkret fehlt. Das ist ehrlicher als eine
 *     Aktion, die nie funktioniert.
 *
 * Das Wort „DATEV" fällt hier nur in der Erklärung, warum es das Format nicht
 * gibt. Eine Datei, die so heisst und es nicht ist, wäre schlimmer als keine.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/Button';
import { InlineNotice } from '../ui/States';
import { ReadOnlyNotice } from '../ui/ReadOnlyNotice';
import type { AccountingExportReadiness } from '../../services/accounting/accountingExportGateService';
import {
  describeAccountingExportFailure,
  type AccountingExportPdfProblem,
} from '../../services/accounting/accountingExportPdfCheck';
import { buildInvoiceReachPath } from '../../services/invoiceNavigation';
import type { AccountingExportOutcome } from '../../services/accounting/accountingExportRunner';

/** FINANZ-CORE-01A (BUH-05) — warum der letzte Export scheiterte, für die Anzeige. */
export interface AccountingExportFailureView {
  outcome: 'document_load_failed' | 'blocked' | 'forbidden' | 'export_failed' | 'invalid_month';
  failed?: ReadonlyArray<{ fileName: string; detail: string }>;
}

export interface AccountingExportFeedback {
  monthKey: string;
  fileName: string | null;
  failure?: AccountingExportFailureView;
}

/** FINANZ-CORE-01A (BUH-05) — das Exportergebnis vollständig für das Panel (Datei oder Beleg und Grund). */
export function buildAccountingExportFeedback(
  monthKey: string,
  result: AccountingExportOutcome,
): AccountingExportFeedback {
  if (result.outcome === 'exported') return { monthKey, fileName: result.fileName };
  return {
    monthKey,
    fileName: null,
    failure: {
      outcome: result.outcome,
      ...(result.outcome === 'document_load_failed' ? { failed: result.failed } : {}),
    },
  };
}
import type { TranslationKey } from '../../i18n';

interface Props {
  readiness: AccountingExportReadiness;
  /** Erzeugt das Paket und liefert den Dateinamen, oder `null` bei Fehlschlag. */
  onCreatePackage: () => Promise<string | null>;
  translate: (key: TranslationKey) => string;
  /**
   * 02B-FINAL — darf dieser Nutzer exportieren? Dieselbe Berechtigungswahrheit
   * wie der Exportweg selbst (`resolveWorkspaceWriteAccess`, geprüft auch in
   * `assertMonatsmappeAllowed`). Ohne Recht keine aktive Aktion; der Guard im
   * Exportweg bleibt unabhängig davon bestehen.
   */
  canExport?: boolean;
  /**
   * 02B-FINAL — das Ergebnis des letzten Exports in diesem Monat. Nach dem
   * Export wird das Panel neu aufgebaut (neuer Stand); ohne diese Übergabe
   * gingen Dateiname und Fehlerhinweis dabei verloren.
   */
  lastResult?: { fileName: string | null; failure?: AccountingExportFailureView } | null;
  /**
   * FINANZ-CORE-01A (BUH-05) — Rechnungen des Monats, deren PDF sich nicht erzeugen lässt: Das
   * Paket würde an ihnen scheitern. Vor dem Klick genannt, mit Weg zur Rechnung.
   */
  pdfProblems?: readonly AccountingExportPdfProblem[];
}

export function AccountingExportPanel({
  readiness,
  onCreatePackage,
  translate,
  canExport = true,
  lastResult = null,
  pdfProblems = [],
}: Props) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(lastResult ? lastResult.fileName === null : false);
  const [createdName, setCreatedName] = useState<string | null>(lastResult?.fileName ?? null);

  const handleCreate = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const name = await onCreatePackage();
      if (!name) {
        setFailed(true);
        return;
      }
      setCreatedName(name);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="accounting-export">
      {/* ---------------- Steuerberater-Paket ---------------- */}
      {readiness.packageAllowed && !canExport ? (
        <ReadOnlyNotice message={translate('steuerberater.export.forbidden')} testId="accounting-export-forbidden" />
      ) : readiness.packageAllowed ? (
        <>
          <p className="detail-hint" data-testid="accounting-export-package-hint">
            {translate('accountingExport.packageHint')}
          </p>
          <div className="vorgang-dialog__actions">
            <Button
              type="button"
              disabled={busy}
              loading={busy}
              onClick={() => void handleCreate()}
              data-testid="accounting-export-package"
            >
              {busy
                ? translate('accountingExport.running')
                : translate('accountingExport.package')}
            </Button>
          </div>
          {createdName ? (
            <p className="detail-hint" data-testid="accounting-export-created">
              {createdName}
            </p>
          ) : null}
          {pdfProblems.length > 0 ? (
            <InlineNotice tone="warning" testId="accounting-export-pdf-problems" title={translate('accountingExport.pdfProblems.title')}>
              <ul>
                {pdfProblems.map((problem) => (
                  <li key={problem.invoiceId} data-testid={`accounting-export-pdf-problem-${problem.invoiceId}`}>
                    <Link to={buildInvoiceReachPath(problem.vorgangId, problem.invoiceId)}>{problem.invoiceNumber}</Link>
                    {': '}
                    {translate(problem.messageKey)}
                  </li>
                ))}
              </ul>
            </InlineNotice>
          ) : null}
          {failed ? (
            <InlineNotice tone="critical" testId="accounting-export-failed">
              {translate('accountingExport.failed')}
              {/* FINANZ-CORE-01A (BUH-05) — an welchem Beleg und warum, statt nur „nicht erstellt". */}
              {lastResult?.failure?.outcome === 'document_load_failed' && lastResult.failure.failed?.length ? (
                <>
                  <p>{translate('accountingExport.failure.documents')}</p>
                  <ul data-testid="accounting-export-failed-documents">
                    {lastResult.failure.failed.map((entry) => (
                      <li key={`${entry.fileName}:${entry.detail}`}>
                        {entry.fileName}: {translate(describeAccountingExportFailure(entry.detail))}
                      </li>
                    ))}
                  </ul>
                  <p>{translate('accountingExport.failure.remedy')}</p>
                </>
              ) : lastResult?.failure?.outcome === 'blocked' ? (
                <p data-testid="accounting-export-failed-blocked">{translate('accountingExport.failure.blocked')}</p>
              ) : lastResult?.failure?.outcome === 'forbidden' ? (
                <p data-testid="accounting-export-failed-forbidden">{translate('steuerberater.export.forbidden')}</p>
              ) : null}
            </InlineNotice>
          ) : null}
        </>
      ) : (
        /*
         * Kein Knopf, sondern die Gründe. Ein deaktivierter Knopf ohne
         * Begründung liesse den Nutzer raten, was er tun soll.
         */
        <>
          <h3 className="ui-section-header__title">
            {translate('accountingExport.blockedTitle')}
          </h3>
          <ul className="detail-list" data-testid="accounting-export-blockers">
            {readiness.packageBlockers.map((blocker) => (
              <li key={blocker.code} data-testid={`accounting-export-blocker-${blocker.code}`}>
                {translate(`accountingExport.blocker.${blocker.code}` as TranslationKey).replace(
                  '{count}',
                  blocker.detail ?? '',
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ---------------- DATEV ---------------- */}
      <h3 className="ui-section-header__title">{translate('accountingExport.datevTitle')}</h3>
      {readiness.datevAllowed ? null : (
        <div data-testid="accounting-export-datev-unavailable">
          <p className="detail-hint">{translate('accountingExport.datevUnavailable')}</p>
          <ul className="detail-list" data-testid="accounting-export-datev-blockers">
            {readiness.datevBlockers.map((blocker) => (
              <li key={blocker.code} data-testid={`accounting-export-datev-${blocker.code}`}>
                {translate(`accountingExport.datevBlocker.${blocker.code}` as TranslationKey)}
              </li>
            ))}
          </ul>
          <p className="detail-hint" data-testid="accounting-export-datev-note">
            {translate('accountingExport.datevNote')}
          </p>
        </div>
      )}
    </div>
  );
}
