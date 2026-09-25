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
import { Button } from '../ui/Button';
import { InlineNotice } from '../ui/States';
import type { AccountingExportReadiness } from '../../services/accounting/accountingExportGateService';
import type { TranslationKey } from '../../i18n';

interface Props {
  readiness: AccountingExportReadiness;
  /** Erzeugt das Paket und liefert den Dateinamen, oder `null` bei Fehlschlag. */
  onCreatePackage: () => Promise<string | null>;
  translate: (key: TranslationKey) => string;
}

export function AccountingExportPanel({ readiness, onCreatePackage, translate }: Props) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [createdName, setCreatedName] = useState<string | null>(null);

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
      {readiness.packageAllowed ? (
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
          {failed ? (
            <InlineNotice tone="critical" testId="accounting-export-failed">
              {translate('accountingExport.failed')}
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
