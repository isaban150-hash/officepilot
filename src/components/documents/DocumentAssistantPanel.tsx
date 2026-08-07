import { useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { CollapsibleReviewSection } from '../inbox/review/CollapsibleReviewSection';
import { DocumentGuidancePanel } from './DocumentGuidancePanel';
import type { TranslationKey } from '../../i18n';
import {
  buildInboxDocumentAssistant,
  type InboxDocumentAssistant,
} from '../../services/documentAssistantService';
import { buildDocumentGuidance } from '../../services/documentGuidanceService';
import { getDocumentDisplayLabelKey } from '../../services/documentDisplayLabelService';
import type { InboxItem, WorkflowResult, AppLanguage } from '../../types/models';
import type { DocumentFieldFillConfirmRow } from '../../types/documentFieldFillConfirm';

const STEUERBERATER_KEYS: Record<InboxDocumentAssistant['steuerberaterStatus'], TranslationKey> = {
  mark: 'docAssistant.steuerberater.mark',
  not_relevant: 'docAssistant.steuerberater.notRelevant',
  check: 'docAssistant.steuerberater.check',
};

interface DocumentAssistantPanelProps {
  item: InboxItem;
  workflow?: WorkflowResult | null;
  translate: (key: TranslationKey) => string;
  language: AppLanguage;
  showChangeType?: boolean;
  onChangeType?: () => void;
  /** Compact entry for contract workspace only — must be set explicitly by the page. */
  compactForContractWorkspace?: boolean;
  /** Session Fill-Confirm rows — same TruthView as Overview / Free-Question. */
  sessionFillConfirmRows?: DocumentFieldFillConfirmRow[] | null;
}

export function DocumentAssistantPanel({
  item,
  workflow,
  translate,
  language,
  showChangeType = false,
  onChangeType,
  compactForContractWorkspace = false,
  sessionFillConfirmRows = null,
}: DocumentAssistantPanelProps) {
  const assistant = useMemo(
    () =>
      buildInboxDocumentAssistant(item, workflow, language, {
        sessionFillConfirmRows,
      }),
    [item, workflow, language, sessionFillConfirmRows],
  );
  const guidance = useMemo(
    () =>
      buildDocumentGuidance(item, workflow, language, {
        sessionFillConfirmRows,
      }),
    [item, workflow, language, sessionFillConfirmRows],
  );
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const kind = item.classifiedKind ?? workflow?.classifiedKind;

  const recognitionDetails = (
    <>
      <Card className="document-assistant-panel__section">
        <h2 className="document-assistant-panel__heading">{translate('docAssistant.section.steuerberater')}</h2>
        <p>{translate(STEUERBERATER_KEYS[assistant.steuerberaterStatus])}</p>
        <p className="document-assistant-panel__muted">{translate(assistant.steuerberaterReasonKey)}</p>
      </Card>

      <Card className="document-assistant-panel__section">
        <h2 className="document-assistant-panel__heading">{translate('docAssistant.section.trust')}</h2>
        <p className="document-assistant-panel__trust-label document-assistant-panel__trust-label--primary">
          {translate(assistant.recognitionStatusKey)}
        </p>
        {assistant.confidentFields.length > 0 && (
          <div className="document-assistant-panel__trust-group">
            {assistant.recognitionStatus !== 'assign_customer' ? (
              <p className="document-assistant-panel__trust-label">{translate('docAssistant.trust.confident')}</p>
            ) : null}
            <ul>
              {assistant.confidentFields.map((field) => (
                <li key={field.labelKey}>
                  {translate(field.labelKey)}:{' '}
                  {field.labelKey === 'docAssistant.check.documentType'
                    ? translate(getDocumentDisplayLabelKey(kind, item.documentType))
                    : field.value}
                </li>
              ))}
            </ul>
          </div>
        )}
        {assistant.uncertainFields.length > 0 && (
          <div className="document-assistant-panel__trust-group">
            {assistant.recognitionStatus !== 'assign_customer' ? (
              <p className="document-assistant-panel__trust-label">{translate('docAssistant.trust.review')}</p>
            ) : null}
            <ul>
              {assistant.uncertainFields.map((field) => (
                <li key={field.labelKey}>
                  {translate(field.labelKey)} – {translate(field.noteKey)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

    </>
  );

  const changeTypeButton =
    showChangeType && onChangeType ? (
      <Button variant="outline" fullWidth onClick={onChangeType} data-testid="doc-assistant-change-type">
        {translate('docAssistant.changeType')}
      </Button>
    ) : null;

  const guidancePanel = <DocumentGuidancePanel guidance={guidance} translate={translate} />;

  // UX-02: contract first paint is the Auftragskarte — hide document-assistant noise.
  if (compactForContractWorkspace) {
    return null;
  }

  return (
    <section
      className="document-assistant-panel"
      data-testid="document-assistant-panel"
    >
      <Card highlight className="document-assistant-panel__hero">
        <CardMeta>{translate('docAssistant.recognized')}</CardMeta>
        <CardTitle>
          {translate(assistant.documentTypeLabelKey)}
          {assistant.sender ? ` · ${assistant.sender}` : ''}
        </CardTitle>
        {assistant.narrative ? (
          <p data-testid="doc-assistant-narrative">{assistant.narrative}</p>
        ) : null}
      </Card>

      {guidancePanel}
      {assistant.missingItems.length > 0 && (
        <Card className="document-assistant-panel__section" data-testid="doc-assistant-missing-items">
          <h2 className="document-assistant-panel__heading">
            {translate('docAssistant.section.missing')}
          </h2>
          <ul>
            {assistant.missingItems.map((itemText) => (
              <li key={itemText}>{itemText}</li>
            ))}
          </ul>
        </Card>
      )}
      <CollapsibleReviewSection
        id="assistant-details"
        title={translate('docAssistant.section.details')}
        expanded={detailsExpanded}
        onToggle={() => setDetailsExpanded((open) => !open)}
        testId="doc-assistant-details"
      >
        {recognitionDetails}
        {changeTypeButton}
      </CollapsibleReviewSection>
    </section>
  );
}
