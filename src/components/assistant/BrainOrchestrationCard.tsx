import { useNavigate } from 'react-router-dom';
import { AssistantAnswerCard } from './AssistantAnswerCard';
import { BrainAnswerCard } from './BrainAnswerCard';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import type { BrainOrchestrationResult } from '../../types/brainOrchestration';
import type { TranslationKey } from '../../i18n';

interface BrainOrchestrationCardProps {
  result: BrainOrchestrationResult;
  onTryDeepAnswer?: () => void;
}

function translateMaybe(
  translate: (key: TranslationKey) => string,
  value?: string,
): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('brain.')) {
    return translate(value as TranslationKey);
  }
  return value;
}

export function BrainOrchestrationCard({ result, onTryDeepAnswer }: BrainOrchestrationCardProps) {
  const { translate } = useApp();
  const navigate = useNavigate();

  const confidenceLabel =
    result.confidence === 'high'
      ? translate('brain.confidence.high')
      : result.confidence === 'medium'
        ? translate('brain.confidence.medium')
        : translate('brain.confidence.low');

  const uncertainty = translateMaybe(translate, result.uncertaintyNote);
  const clarification = translateMaybe(translate, result.clarificationQuestion);

  return (
    <div className="brain-orchestration-card" data-testid="brain-orchestration-card">
      <p className="brain-orchestration-meta" data-testid="brain-orchestration-confidence">
        {translate('brain.sourceLabel')}: {translate(`brain.source.${result.source}` as TranslationKey)} ·{' '}
        {translate('brain.confidenceLabel')}: {confidenceLabel}
      </p>

      {result.assistantAnswer && <AssistantAnswerCard answer={result.assistantAnswer} />}
      {result.brainAnswer && <BrainAnswerCard answer={result.brainAnswer} />}

      {uncertainty && (
        <p className="brain-orchestration-uncertainty" data-testid="brain-orchestration-uncertainty">
          {translate('brain.uncertaintyLabel')}: {uncertainty}
        </p>
      )}

      {clarification && (
        <p className="brain-orchestration-clarification" data-testid="brain-orchestration-clarification">
          {clarification}
        </p>
      )}

      {result.proactiveHints && result.proactiveHints.length > 0 && (
        <div className="brain-orchestration-hints" data-testid="brain-orchestration-hints">
          <p className="brain-orchestration-hints__title">{translate('companyContext.hintsTitle')}</p>
          <ul className="brain-orchestration-hints__list">
            {result.proactiveHints.map((hint) => {
              let text = translate(hint.messageKey as TranslationKey);
              if (hint.params) {
                for (const [key, value] of Object.entries(hint.params)) {
                  text = text.replace(`{${key}}`, String(value));
                }
              }
              return <li key={hint.messageKey}>{text}</li>;
            })}
          </ul>
        </div>
      )}

      {result.companyContextUsed && result.companyContextUsed.length > 0 && (
        <p className="brain-orchestration-context-used" data-testid="brain-orchestration-context-used">
          {translate('companyContext.usedLabel')}: {result.companyContextUsed.join(', ')}
        </p>
      )}

      {result.handwerkKnowledgeUsed && result.handwerkKnowledgeUsed.length > 0 && (
        <p className="brain-orchestration-context-used" data-testid="brain-orchestration-handwerk-used">
          {translate('handwerkKnowledge.usedLabel')}: {result.handwerkKnowledgeUsed.join(', ')}
        </p>
      )}

      {result.suggestedNextSteps.length > 0 && (
        <div className="brain-orchestration-next-steps" data-testid="brain-orchestration-next-steps">
          <p className="brain-orchestration-next-steps__title">{translate('brain.nextStepsTitle')}</p>
          <div className="assistant-answer-actions">
            {result.suggestedNextSteps.map((step) => (
              <Button
                key={step.id}
                variant="outline"
                onClick={() => {
                  if (step.id === 'try_deep' && onTryDeepAnswer) {
                    onTryDeepAnswer();
                    return;
                  }
                  if (step.route) {
                    navigate(step.route);
                  }
                }}
              >
                {translate(step.labelKey as TranslationKey)}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
