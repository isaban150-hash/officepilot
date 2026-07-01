import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import { isAiProviderConfigured } from '../../services/ai/aiRequestRunner';
import type { AreaAiAnswer } from '../../types/areaAi';

interface AreaAiPanelProps {
  title: string;
  placeholder: string;
  askLabel: string;
  loadingLabel: string;
  notConfiguredLabel: string;
  onAsk: (question: string) => Promise<AreaAiAnswer>;
  testIdPrefix: string;
}

export function AreaAiPanel({
  title,
  placeholder,
  askLabel,
  loadingLabel,
  notConfiguredLabel,
  onAsk,
  testIdPrefix,
}: AreaAiPanelProps) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<AreaAiAnswer | null>(null);
  const aiConfigured = isAiProviderConfigured();

  const handleAsk = async () => {
    const trimmed = question.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    try {
      const result = await onAsk(trimmed);
      setAnswer(result);
      if (result.source === 'ai') {
        setQuestion('');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="area-ai-panel" data-testid={`${testIdPrefix}-panel`}>
      <Card className="area-ai-panel__card">
        <CardTitle>{title}</CardTitle>
        <div className="area-ai-panel__row">
          <input
            type="text"
            className="input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && !event.shiftKey && void handleAsk()}
            placeholder={placeholder}
            data-testid={`${testIdPrefix}-input`}
          />
          <Button
            type="button"
            onClick={() => void handleAsk()}
            disabled={loading || !question.trim() || !aiConfigured}
            data-testid={`${testIdPrefix}-ask`}
          >
            {loading ? loadingLabel : askLabel}
          </Button>
        </div>
        {!aiConfigured && notConfiguredLabel ? (
          <p className="area-ai-panel__hint" data-testid={`${testIdPrefix}-not-configured`}>
            {notConfiguredLabel}
          </p>
        ) : null}
        {loading && (
          <p className="area-ai-panel__loading" data-testid={`${testIdPrefix}-loading`}>
            {loadingLabel}
          </p>
        )}
        {answer && (
          <div
            className={`area-ai-panel__answer ${answer.source === 'unavailable' ? 'area-ai-panel__answer--unavailable' : ''}`}
            data-testid={`${testIdPrefix}-answer`}
          >
            <p className="area-ai-panel__answer-text" data-testid={`${testIdPrefix}-answer-text`}>
              {answer.text}
            </p>
            <p className="area-ai-panel__disclaimer">{answer.disclaimer}</p>
          </div>
        )}
      </Card>
    </section>
  );
}
