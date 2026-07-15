import { useState } from 'react';
import { Button } from '../ui/Button';
import { Badge, Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { isAiProviderConfigured } from '../../services/ai/aiRequestRunner';
import {
  askDocumentAi,
  type DocumentAiSource,
} from '../../services/document/documentAiService';
import type { AreaAiAnswer } from '../../types/areaAi';

interface DocumentFreeQuestionPanelProps {
  source: DocumentAiSource;
  testIdPrefix?: string;
}

export function DocumentFreeQuestionPanel({
  source,
  testIdPrefix = 'document-free-question',
}: DocumentFreeQuestionPanelProps) {
  const { translate } = useApp();
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<AreaAiAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aiConfigured = isAiProviderConfigured();

  const handleAsk = async () => {
    const trimmed = question.trim();
    if (!trimmed || loading) return;
    if (!aiConfigured) {
      setError(translate('document.freeQuestion.notConfigured'));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await askDocumentAi({ source, question: trimmed });
      setAnswer(result);
      if (result.source === 'unavailable' && result.errorCode === 'invalid_prompt') {
        setError(result.text);
      }
      if (result.source === 'ai') {
        setQuestion('');
      }
    } catch {
      setAnswer(null);
      setError(translate('document.freeQuestion.error.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      className="document-free-question-panel area-ai-panel"
      data-testid={`${testIdPrefix}-panel`}
    >
      <Card className="area-ai-panel__card">
        <CardTitle>{translate('document.freeQuestion.title')}</CardTitle>
        <p className="document-free-question-panel__hint" data-testid={`${testIdPrefix}-scope-hint`}>
          {translate('document.freeQuestion.scopeHint')}
        </p>
        <div className="area-ai-panel__row">
          <input
            type="text"
            className="input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleAsk();
              }
            }}
            placeholder={translate('document.freeQuestion.placeholder')}
            disabled={loading}
            data-testid={`${testIdPrefix}-input`}
            aria-label={translate('document.freeQuestion.title')}
          />
          <Button
            type="button"
            onClick={() => void handleAsk()}
            disabled={loading || !question.trim() || !aiConfigured}
            data-testid={`${testIdPrefix}-ask`}
          >
            {loading ? translate('document.freeQuestion.loading') : translate('document.freeQuestion.ask')}
          </Button>
        </div>
        {!aiConfigured ? (
          <p className="area-ai-panel__hint" data-testid={`${testIdPrefix}-not-configured`}>
            {translate('document.freeQuestion.notConfigured')}
          </p>
        ) : null}
        {loading ? (
          <p className="area-ai-panel__loading" data-testid={`${testIdPrefix}-loading`}>
            {translate('document.freeQuestion.loading')}
          </p>
        ) : null}
        {error ? (
          <p className="document-free-question-panel__error" data-testid={`${testIdPrefix}-error`}>
            {error}
          </p>
        ) : null}
        {answer ? (
          <div
            className={`area-ai-panel__answer${
              answer.source === 'unavailable' ? ' area-ai-panel__answer--unavailable' : ''
            }${answer.uncertain ? ' document-free-question-panel__answer--uncertain' : ''}`}
            data-testid={`${testIdPrefix}-answer`}
          >
            {answer.directAnswer ? (
              <p
                className="document-free-question-panel__direct-answer"
                data-testid={`${testIdPrefix}-direct-answer`}
              >
                {answer.directAnswer}
              </p>
            ) : (
              <p className="area-ai-panel__answer-text" data-testid={`${testIdPrefix}-answer-text`}>
                {answer.text}
              </p>
            )}
            {answer.explanation ? (
              <p
                className="document-free-question-panel__explanation"
                data-testid={`${testIdPrefix}-explanation`}
              >
                {answer.explanation}
              </p>
            ) : null}
            {answer.uncertain ? (
              <div
                className="document-free-question-panel__uncertainty"
                data-testid={`${testIdPrefix}-uncertainty`}
              >
                <Badge tone="warning">{translate('document.freeQuestion.uncertainBadge')}</Badge>
                {answer.uncertaintyNotes && answer.uncertaintyNotes.length > 0 ? (
                  <ul data-testid={`${testIdPrefix}-uncertainty-notes`}>
                    {answer.uncertaintyNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <p className="area-ai-panel__disclaimer" data-testid={`${testIdPrefix}-disclaimer`}>
              {answer.disclaimer}
            </p>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
