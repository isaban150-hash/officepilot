import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import type { DocumentAreaId } from '../../types/documentArea';
import type { DocumentFilingDecisionDraft } from '../../types/documentFilingDecision';
import type { InboxItem } from '../../types/models';
import {
  buildDocumentFilingDecisionDraft,
  confirmDocumentFilingDecision,
  formatDigitalFolderBreadcrumb,
  formatFilingPaperHint,
  getDocumentAreaLabelKey,
  getFilingScopeLabelKey,
  listCompanyFilingAreaIds,
  rebuildFilingDecisionDraft,
  type FilingDecisionOverride,
} from '../../services/documentFilingDecisionService';
import { getAllPaperFolders } from '../../services/paperFolderService';

export interface DocumentFilingDecisionPanelProps {
  item: InboxItem;
  /** Called after durable confirm (folders + filingDecision on inbox). */
  onConfirmed: (item: InboxItem) => void;
  testIdPrefix?: string;
  /**
   * PRODUCT-ACCEPTANCE-FIX-01B (F-05) — im Aktionsfluss: Titel, Hinweis und
   * Bestätigungsknopf nennen die Aktion, die der Nutzer gedrückt hat
   * (z. B. „Als Ausgabe speichern"). Die Ablageregel selbst ist unverändert.
   */
  continueActionLabel?: string;
}

/**
 * Confirm-first Ablageentscheidung: Kundendokument vs. Unternehmensdokument,
 * digitale Ablage, Papierhinweis. Archivierung bleibt beim Host.
 */
export function DocumentFilingDecisionPanel({
  item,
  onConfirmed,
  testIdPrefix = 'document-filing-decision',
  continueActionLabel,
}: DocumentFilingDecisionPanelProps) {
  const { translate, setup, showToast } = useApp();
  const [draft, setDraft] = useState<DocumentFilingDecisionDraft>(() =>
    buildDocumentFilingDecisionDraft(item),
  );

  useEffect(() => {
    setDraft(buildDocumentFilingDecisionDraft(item));
  }, [item.id, item.classifiedKind, item.digitalFolder.path, item.filingDecision?.status]);

  const applyOverride = (overrides: FilingDecisionOverride) => {
    setDraft((current) => rebuildFilingDecisionDraft(item, current, overrides));
  };

  const paperFolders = useMemo(() => getAllPaperFolders(), []);
  const areaIds = useMemo(() => listCompanyFilingAreaIds(), []);
  const paperHint = formatFilingPaperHint(draft, setup.language, (key) =>
    translate(key as TranslationKey),
  );
  const confirmed = draft.status === 'confirmed';
  const documentKindLabel = translate(draft.documentKindLabelKey as TranslationKey);
  const companyAreaLabel = translate(draft.companyAreaLabelKey as TranslationKey);
  // „Ablage bestätigen und als Ausgabe speichern" — die Aktion klein im Satz, groß im Titel.
  const continueActionInline = continueActionLabel
    ? continueActionLabel.charAt(0).toLocaleLowerCase('de-DE') + continueActionLabel.slice(1)
    : '';

  const handleConfirm = () => {
    const updated = confirmDocumentFilingDecision(item.id, draft);
    if (!updated) {
      showToast(translate('filingDecision.persistFailed'));
      return;
    }
    setDraft(buildDocumentFilingDecisionDraft(updated));
    onConfirmed(updated);
  };

  return (
    <Card className="document-filing-decision" data-testid={testIdPrefix}>
      <CardTitle>
        {continueActionLabel
          ? translate('filingDecision.stepTitle').replace('{action}', continueActionLabel)
          : translate('filingDecision.title')}
      </CardTitle>
      <p className="document-filing-decision__hint muted">
        {continueActionLabel
          ? translate('filingDecision.stepHint').replace('{action}', continueActionLabel)
          : translate('filingDecision.hint')}
      </p>

      <div
        className="document-filing-decision__field"
        data-testid={`${testIdPrefix}-document-kind`}
      >
        <span className="document-filing-decision__label">
          {translate('filingDecision.kindLabel')}
        </span>
        <p className="document-filing-decision__scope-current">{documentKindLabel}</p>
      </div>

      <div className="document-filing-decision__scope" role="group" aria-label={translate('filingDecision.scopeLabel')}>
        <span className="document-filing-decision__label">
          {translate('filingDecision.scopeLabel')}
        </span>
        <div className="document-filing-decision__scope-actions">
          <Button
            variant={draft.scope === 'customer' ? 'primary' : 'outline'}
            data-testid={`${testIdPrefix}-scope-customer`}
            onClick={() => applyOverride({ scope: 'customer' })}
          >
            {translate('filingDecision.scope.customer')}
          </Button>
          <Button
            variant={draft.scope === 'company' ? 'primary' : 'outline'}
            data-testid={`${testIdPrefix}-scope-company`}
            onClick={() => applyOverride({ scope: 'company' })}
          >
            {translate('filingDecision.scope.company')}
          </Button>
        </div>
        <p className="document-filing-decision__scope-current" data-testid={`${testIdPrefix}-scope-value`}>
          {translate(getFilingScopeLabelKey(draft.scope))}
        </p>
      </div>

      {draft.scope === 'customer' ? (
        <div className="document-filing-decision__fields">
          <label className="document-filing-decision__field">
            <span>{translate('filingDecision.customer')}</span>
            <input
              className="input"
              data-testid={`${testIdPrefix}-customer`}
              value={draft.customerLabel}
              onChange={(event) => applyOverride({ customerLabel: event.target.value })}
            />
          </label>
          <label className="document-filing-decision__field">
            <span>{translate('filingDecision.project')}</span>
            <input
              className="input"
              data-testid={`${testIdPrefix}-project`}
              value={draft.projectLabel}
              onChange={(event) => applyOverride({ projectLabel: event.target.value })}
            />
          </label>
        </div>
      ) : (
        <div className="document-filing-decision__fields">
          {/* F-05 — ein Feld „Unternehmensbereich": die Auswahl zeigt den erkannten Bereich; kein doppeltes Label. */}
          <label className="document-filing-decision__field" data-testid={`${testIdPrefix}-company-area-label`}>
            <span>{translate('filingDecision.companyArea')}</span>
            <span className="sr-only">{companyAreaLabel}</span>
            <select
              className="input"
              data-testid={`${testIdPrefix}-area`}
              value={draft.companyAreaId}
              onChange={(event) =>
                applyOverride({ companyAreaId: event.target.value as DocumentAreaId })
              }
            >
              {areaIds.map((areaId) => (
                <option key={areaId} value={areaId}>
                  {translate(getDocumentAreaLabelKey(areaId))}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* F-05 — der Ablageort steht menschenlesbar; der technische Pfad bleibt bearbeitbar, aber aufklappbar. */}
      <div className="document-filing-decision__field">
        <span className="document-filing-decision__label">{translate('filingDecision.digitalPath')}</span>
        <p
          className="document-filing-decision__scope-current"
          data-testid={`${testIdPrefix}-digital-breadcrumb`}
        >
          {formatDigitalFolderBreadcrumb(draft.digitalFolder.path)}
        </p>
        <details className="work-path-details">
          <summary>{translate('document.filing.pathDetails')}</summary>
          <label className="document-filing-decision__field">
            <span className="sr-only">{translate('filingDecision.digitalPath')}</span>
            <input
              className="input"
              data-testid={`${testIdPrefix}-digital-path`}
              value={draft.digitalFolder.path}
              onChange={(event) => applyOverride({ digitalPath: event.target.value })}
            />
          </label>
        </details>
      </div>

      <div className="document-filing-decision__paper">
        <span className="document-filing-decision__label">
          {translate('filingDecision.paper')}
        </span>
        <p data-testid={`${testIdPrefix}-paper-hint`}>{paperHint}</p>
        {!draft.skipPhysicalFiling && (
          <div className="document-filing-decision__paper-edit">
            <label className="document-filing-decision__field">
              <span>{translate('filingDecision.paperFolder')}</span>
              <select
                className="input"
                data-testid={`${testIdPrefix}-paper-folder`}
                value={draft.paperFiling?.folderId ?? ''}
                onChange={(event) => applyOverride({ paperFolderId: event.target.value })}
              >
                {paperFolders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="document-filing-decision__field">
              <span>{translate('filingDecision.paperRegister')}</span>
              <input
                className="input"
                data-testid={`${testIdPrefix}-paper-register`}
                value={draft.paperFiling?.register ?? ''}
                onChange={(event) => applyOverride({ paperRegister: event.target.value })}
              />
            </label>
          </div>
        )}
      </div>

      {confirmed ? (
        <p className="document-filing-decision__confirmed" data-testid={`${testIdPrefix}-confirmed`}>
          {translate('filingDecision.confirmed')}
        </p>
      ) : (
        <Button
          fullWidth
          data-testid={`${testIdPrefix}-confirm`}
          onClick={handleConfirm}
        >
          {continueActionLabel
            ? translate('filingDecision.confirmAndContinue').replace('{action}', continueActionInline)
            : translate('filingDecision.confirm')}
        </Button>
      )}
    </Card>
  );
}
