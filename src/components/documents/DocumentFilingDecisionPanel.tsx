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
}

/**
 * Confirm-first Ablageentscheidung: Kundendokument vs. Unternehmensdokument,
 * digitale Ablage, Papierhinweis. Archivierung bleibt beim Host.
 */
export function DocumentFilingDecisionPanel({
  item,
  onConfirmed,
  testIdPrefix = 'document-filing-decision',
}: DocumentFilingDecisionPanelProps) {
  const { translate, setup } = useApp();
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

  const handleConfirm = () => {
    const updated = confirmDocumentFilingDecision(item.id, draft);
    if (!updated) return;
    setDraft(buildDocumentFilingDecisionDraft(updated));
    onConfirmed(updated);
  };

  return (
    <Card className="document-filing-decision" data-testid={testIdPrefix}>
      <CardTitle>{translate('filingDecision.title')}</CardTitle>
      <p className="document-filing-decision__hint muted">
        {translate('filingDecision.hint')}
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
          <div
            className="document-filing-decision__field"
            data-testid={`${testIdPrefix}-company-area-label`}
          >
            <span className="document-filing-decision__label">
              {translate('filingDecision.companyArea')}
            </span>
            <p className="document-filing-decision__scope-current">{companyAreaLabel}</p>
          </div>
          <label className="document-filing-decision__field">
            <span>{translate('filingDecision.companyArea')}</span>
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

      <label className="document-filing-decision__field">
        <span>{translate('filingDecision.digitalPath')}</span>
        <input
          className="input"
          data-testid={`${testIdPrefix}-digital-path`}
          value={draft.digitalFolder.path}
          onChange={(event) => applyOverride({ digitalPath: event.target.value })}
        />
        <span
          className="document-filing-decision__breadcrumb muted"
          data-testid={`${testIdPrefix}-digital-breadcrumb`}
        >
          {formatDigitalFolderBreadcrumb(draft.digitalFolder.path)}
        </span>
      </label>

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
          {translate('filingDecision.confirm')}
        </Button>
      )}
    </Card>
  );
}
