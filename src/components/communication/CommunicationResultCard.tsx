import { useState } from 'react';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { ShowMoreSection } from '../ui/ShowMoreSection';
import { CommunicationChannelTabs } from './CommunicationChannelTabs';
import { CommunicationCopyButton } from './CommunicationCopyButton';
import { CommunicationDraftView, formatCommunicationDraftText } from './CommunicationDraftView';
import { CommunicationMissingInfoForm } from './CommunicationMissingInfoForm';
import type {
  CommunicationChannel,
  CommunicationDraft,
  CommunicationResult,
} from '../../types/communication';
import type { CommunicationAiEnhanceStyle } from '../../types/communicationAi';
import type { TranslationKey } from '../../i18n';

interface CommunicationResultCardProps {
  result: CommunicationResult;
  channel: CommunicationChannel;
  onChannelChange: (channel: CommunicationChannel) => void;
  missingValues: Record<string, string>;
  onMissingChange: (fieldId: string, value: string) => void;
  onMissingSubmit: () => void;
  translate: (key: TranslationKey) => string;
  onCopied?: () => void;
  aiConfigured: boolean;
  aiLoading: boolean;
  aiStyle: CommunicationAiEnhanceStyle;
  onAiStyleChange: (style: CommunicationAiEnhanceStyle) => void;
  onAiEnhance: () => void;
  aiEnhancedDraft?: CommunicationDraft | null;
  aiVariant: 'original' | 'ai';
  onAiVariantChange: (variant: 'original' | 'ai') => void;
  aiMessage?: string | null;
}

const AI_STYLES: CommunicationAiEnhanceStyle[] = [
  'professional',
  'polite',
  'friendly',
  'shorter',
  'longer',
  'assertive',
];

function translateMaybeKey(
  value: string,
  translate: (key: TranslationKey) => string,
): string {
  if (value.startsWith('communication.')) {
    return translate(value as TranslationKey);
  }
  return value;
}

export function CommunicationResultCard({
  result,
  channel,
  onChannelChange,
  missingValues,
  onMissingChange,
  onMissingSubmit,
  translate,
  onCopied,
  aiConfigured,
  aiLoading,
  aiStyle,
  onAiStyleChange,
  onAiEnhance,
  aiEnhancedDraft,
  aiVariant,
  onAiVariantChange,
  aiMessage,
}: CommunicationResultCardProps) {
  const [showRefineOptions, setShowRefineOptions] = useState(false);
  const title = translateMaybeKey(result.title, translate);
  const summary = translateMaybeKey(result.summary, translate);

  if (result.status === 'blocked') {
    return (
      <div data-testid="communication-blocked">
        <Card className="communication-result-card communication-result-card--blocked">
          <CardTitle>{title}</CardTitle>
          <CardMeta>{summary}</CardMeta>
          <p className="communication-disclaimer">{result.disclaimer}</p>
        </Card>
      </div>
    );
  }

  if (result.status === 'no_data') {
    return (
      <div data-testid="communication-no-data">
        <Card className="communication-result-card communication-result-card--empty">
          <CardTitle>{title}</CardTitle>
          <CardMeta>{summary}</CardMeta>
          <p className="communication-disclaimer">{result.disclaimer}</p>
        </Card>
      </div>
    );
  }

  if (result.status === 'needs_info' && result.missingInfo) {
    return (
      <div data-testid="communication-needs-info">
        <Card className="communication-result-card">
          <CardTitle>{title}</CardTitle>
          <CardMeta>{summary}</CardMeta>
        </Card>
        <CommunicationMissingInfoForm
          fields={result.missingInfo}
          values={missingValues}
          onChange={onMissingChange}
          onSubmit={onMissingSubmit}
          title={translate('communication.missingForm.title')}
          submitLabel={translate('communication.missingForm.submit')}
          translate={translate}
        />
      </div>
    );
  }

  if (result.status === 'complete' && result.mode === 'question' && result.documentQa) {
    return (
      <div data-testid="communication-qa">
        <Card className="communication-result-card communication-result-card--qa">
          <CardTitle>{title}</CardTitle>
          <CardMeta>{result.documentQa.answer}</CardMeta>
          {result.documentQa.bullets.length > 0 && (
            <ul className="communication-qa-bullets">
              {result.documentQa.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          )}
          {result.documentQa.uncertain && (
            <p className="communication-qa-uncertain">{translate('communication.qa.uncertain')}</p>
          )}
          <p className="communication-disclaimer">{result.disclaimer}</p>
        </Card>
      </div>
    );
  }

  if (result.status === 'complete' && result.drafts) {
    const draft = result.drafts[channel] ?? result.drafts.email;
    if (!draft) {
      return (
        <div data-testid="communication-no-data">
          <Card className="communication-result-card communication-result-card--empty">
            <CardTitle>{translate('communication.draftFailed.title')}</CardTitle>
            <CardMeta>{translate('communication.draftFailed.summary')}</CardMeta>
          </Card>
        </div>
      );
    }

    const showImprovedVariant = Boolean(aiEnhancedDraft);
    const activeDraft = aiVariant === 'ai' && aiEnhancedDraft ? aiEnhancedDraft : draft;

    return (
      <div data-testid="communication-draft">
        <Card className="communication-result-card communication-result-card--draft">
          <CardTitle>{translate('communication.draftHeading')}</CardTitle>
          <CardMeta>{summary}</CardMeta>
          <CommunicationChannelTabs channel={channel} onChange={onChannelChange} translate={translate} />

          {showImprovedVariant && (
            <div className="communication-ai-variant-tabs" data-testid="communication-ai-variant-tabs">
              <button
                type="button"
                className={`communication-ai-variant-tab ${aiVariant === 'original' ? 'communication-ai-variant-tab--active' : ''}`}
                data-testid="communication-ai-variant-original"
                onClick={() => onAiVariantChange('original')}
              >
                {translate('communication.ai.variantOriginal')}
              </button>
              <button
                type="button"
                className={`communication-ai-variant-tab ${aiVariant === 'ai' ? 'communication-ai-variant-tab--active' : ''}`}
                data-testid="communication-ai-variant-ai"
                onClick={() => onAiVariantChange('ai')}
              >
                {translate('communication.ai.variantImproved')}
              </button>
            </div>
          )}

          <CommunicationDraftView
            draft={activeDraft}
            translate={translate}
            bodyTestId={
              aiVariant === 'ai' && showImprovedVariant
                ? 'communication-draft-body-ai'
                : 'communication-draft-body'
            }
          />

          <div className="communication-draft-actions">
            <CommunicationCopyButton
              text={formatCommunicationDraftText(activeDraft)}
              label={translate('communication.copy')}
              copiedLabel={translate('communication.copied')}
              onCopied={onCopied}
            />
          </div>

          <ShowMoreSection
            expanded={showRefineOptions}
            onToggle={() => setShowRefineOptions((open) => !open)}
            showLabel={translate('communication.refineShowMore')}
            hideLabel={translate('communication.refineShowLess')}
            testId="communication-refine-show-more"
          >
            <div className="communication-ai-section" data-testid="communication-ai-section">
              <div className="communication-ai-controls">
                <label className="communication-ai-style-label" htmlFor="communication-ai-style">
                  {translate('communication.ai.styleLabel')}
                </label>
                <select
                  id="communication-ai-style"
                  className="input communication-ai-style-select"
                  value={aiStyle}
                  onChange={(event) => onAiStyleChange(event.target.value as CommunicationAiEnhanceStyle)}
                  data-testid="communication-ai-style"
                >
                  {AI_STYLES.map((style) => (
                    <option key={style} value={style}>
                      {translate(`communication.ai.style.${style}` as TranslationKey)}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={onAiEnhance}
                  disabled={!aiConfigured || aiLoading}
                  data-testid="communication-ai-enhance"
                >
                  {aiLoading ? translate('communication.ai.loading') : translate('communication.ai.enhance')}
                </Button>
              </div>
              {aiMessage && (
                <p className="communication-ai-message" data-testid="communication-ai-message">
                  {aiMessage}
                </p>
              )}
            </div>
          </ShowMoreSection>

          <p className="communication-disclaimer">{result.disclaimer}</p>
        </Card>
      </div>
    );
  }

  return null;
}
