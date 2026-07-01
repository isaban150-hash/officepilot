import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AssistantAnswerCard } from '../components/assistant/AssistantAnswerCard';
import { BrainAnswerCard } from '../components/assistant/BrainAnswerCard';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { isAiProviderConfigured } from '../services/aiProviderService';
import { answerQuestion, ASSISTANT_EXAMPLE_QUESTION_KEYS } from '../services/officeAssistantService';
import { askOfficePilotBrain } from '../services/officePilotBrainService';
import type { AssistantAnswer } from '../types/models';
import type { BrainAnswer } from '../types/brain';
import type { TranslationKey } from '../i18n';

export function AssistentPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [brainAnswer, setBrainAnswer] = useState<BrainAnswer | null>(null);
  const [brainLoading, setBrainLoading] = useState(false);
  const [lastQuestion, setLastQuestion] = useState('');
  const aiConfigured = isAiProviderConfigured();

  const ask = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    setLastQuestion(trimmed);
    setBrainAnswer(null);
    setAnswer(answerQuestion(trimmed));
    setInput('');
  };

  const askBrain = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || brainLoading) return;
    setLastQuestion(trimmed);
    setAnswer(null);
    setBrainLoading(true);
    try {
      const result = await askOfficePilotBrain(trimmed);
      setBrainAnswer(result);
      setInput('');
    } finally {
      setBrainLoading(false);
    }
  };

  const handleSuggestion = (questionKey: string) => {
    ask(translate(questionKey as TranslationKey));
  };

  const handleQuickAsk = () => {
    ask(input);
  };

  const handleDeepAsk = () => {
    void askBrain(input);
  };

  return (
    <div className="page assistant-page" data-testid="assistant-page">
      <PageHeader title={translate('assistant.title')} subtitle={translate('assistant.subtitle')} />

      <Card className="assistant-input-card">
        <label className="assistant-input-label" htmlFor="assistant-question">
          {translate('assistant.inputLabel')}
        </label>
        <input
          id="assistant-question"
          type="text"
          className="input assistant-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleQuickAsk()}
          placeholder={translate('assistant.placeholder')}
          data-testid="assistant-input"
        />
        <div className="assistant-actions-row">
          <Button
            onClick={handleQuickAsk}
            disabled={!input.trim()}
            data-testid="assistant-ask-quick"
          >
            {translate('assistant.askQuick')}
          </Button>
          <Button
            variant="outline"
            onClick={handleDeepAsk}
            disabled={brainLoading || !input.trim() || !aiConfigured}
            data-testid="assistant-ask-deep"
          >
            {brainLoading ? translate('assistant.thinking') : translate('assistant.askDeep')}
          </Button>
        </div>
      </Card>

      {(answer || brainAnswer) && lastQuestion && (
        <p className="assistant-last-question">
          <span className="assistant-last-question__label">{translate('assistant.yourQuestion')}</span>
          {lastQuestion}
        </p>
      )}

      {answer && (
        <section className="assistant-answer-section" data-testid="assistant-answer">
          <AssistantAnswerCard answer={answer} />
        </section>
      )}

      {brainAnswer && (
        <section className="assistant-answer-section" data-testid="assistant-brain-answer">
          <BrainAnswerCard answer={brainAnswer} />
        </section>
      )}

      <section className="section">
        <h2 className="section__title">{translate('communication.section.title')}</h2>
        <div className="chip-group">
          <button
            type="button"
            className="chip"
            data-testid="assistant-write-message"
            onClick={() => navigate('/kommunikation')}
          >
            {translate('communication.openFromAssistant')}
          </button>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">{translate('knowledge.section.title')}</h2>
        <div className="chip-group">
          <button
            type="button"
            className="chip"
            data-testid="assistant-open-knowledge"
            onClick={() => navigate('/wissen')}
          >
            {translate('knowledge.openFromAssistant')}
          </button>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">{translate('assistant.examples')}</h2>
        <div className="chip-group">
          {ASSISTANT_EXAMPLE_QUESTION_KEYS.map((questionKey) => (
            <button
              key={questionKey}
              type="button"
              className="chip"
              onClick={() => handleSuggestion(questionKey)}
            >
              {translate(questionKey as TranslationKey)}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
