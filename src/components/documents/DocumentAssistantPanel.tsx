import { useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { CollapsibleReviewSection } from '../inbox/review/CollapsibleReviewSection';
import type { TranslationKey } from '../../i18n';
import {
  buildInboxDocumentAssistant,
  type InboxDocumentAssistant,
  type OriginalGuidanceStatus,
} from '../../services/documentAssistantService';
import { getDocumentDisplayLabelKey } from '../../services/documentDisplayLabelService';
import type { InboxItem, WorkflowResult, AppLanguage } from '../../types/models';

function interpolate(
  translate: (key: TranslationKey) => string,
  block: { key: TranslationKey; params?: Record<string, string | number> },
): string {
  let text = translate(block.key);
  if (!block.params) return text;
  for (const [name, value] of Object.entries(block.params)) {
    if (name === 'typeKey') {
      text = text.replace(`{${name}}`, translate(value as TranslationKey));
    } else {
      text = text.replace(`{${name}}`, String(value));
    }
  }
  return text;
}

const ORIGINAL_GUIDANCE_KEYS: Record<OriginalGuidanceStatus, TranslationKey> = {
  keep: 'docAssistant.original.keep',
  keep_until_tax: 'docAssistant.original.keepUntilTax',
  dispose_after_digital: 'docAssistant.original.disposeAfterDigital',
  uncertain: 'docAssistant.original.uncertain',
};

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
}

export function DocumentAssistantPanel({
  item,
  workflow,
  translate,
  language,
  showChangeType = false,
  onChangeType,
}: DocumentAssistantPanelProps) {
  const assistant = useMemo(
    () => buildInboxDocumentAssistant(item, workflow, language),
    [item, workflow, language],
  );
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const kind = item.classifiedKind ?? workflow?.classifiedKind;

  return (
    <section className="document-assistant-panel" data-testid="document-assistant-panel">
      <Card highlight className="document-assistant-panel__hero">
        <CardMeta>{translate('docAssistant.recognized')}</CardMeta>
        <CardTitle>
          {translate(assistant.documentTypeLabelKey)}
          {assistant.sender ? ` · ${assistant.sender}` : ''}
        </CardTitle>
      </Card>

      <Card className="document-assistant-panel__section">
        <h2 className="document-assistant-panel__heading">{translate('docAssistant.section.brief')}</h2>
        <ul className="document-assistant-panel__lines">
          {assistant.briefLines.map((line) => (
            <li key={line.key}>{interpolate(translate, line)}</li>
          ))}
        </ul>
      </Card>

      <Card className="document-assistant-panel__section">
        <h2 className="document-assistant-panel__heading">{translate('docAssistant.section.actions')}</h2>
        <ul className="document-assistant-panel__steps">
          {assistant.actionSteps.map((step) => (
            <li key={step.key}>{interpolate(translate, step)}</li>
          ))}
        </ul>
        {assistant.inactionConsequence ? (
          <p className="document-assistant-panel__inaction">
            <strong>{translate('docAssistant.section.inaction')}: </strong>
            {interpolate(translate, assistant.inactionConsequence)}
          </p>
        ) : null}
      </Card>

      <Card className="document-assistant-panel__section">
        <h2 className="document-assistant-panel__heading">{translate('docAssistant.section.filing')}</h2>
        <p className="document-assistant-panel__filing-line">
          <strong>{translate('docAssistant.digitalPath')}: </strong>
          {assistant.digitalPath}
        </p>
        <p className="document-assistant-panel__filing-line">
          <strong>{translate('docAssistant.paperFolder')}: </strong>
          {assistant.paperFolderLabel}
        </p>
      </Card>

      <Card className="document-assistant-panel__section">
        <h2 className="document-assistant-panel__heading">{translate('docAssistant.section.original')}</h2>
        <p>{translate(ORIGINAL_GUIDANCE_KEYS[assistant.originalGuidance])}</p>
      </Card>

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

      <CollapsibleReviewSection
        id="assistant-details"
        title={translate('docAssistant.section.details')}
        expanded={detailsExpanded}
        onToggle={() => setDetailsExpanded((open) => !open)}
        testId="doc-assistant-details"
      >
        {showChangeType && onChangeType ? (
          <Button variant="outline" fullWidth onClick={onChangeType} data-testid="doc-assistant-change-type">
            {translate('docAssistant.changeType')}
          </Button>
        ) : null}
      </CollapsibleReviewSection>
    </section>
  );
}
