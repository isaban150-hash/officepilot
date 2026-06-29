import { useState } from 'react';
import { AssistantAnswerCard } from '../components/assistant/AssistantAnswerCard';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { ASSISTANT_SUGGESTIONS } from '../data/mockData';
import { answerQuestion } from '../services/officeAssistantService';
import type { AssistantAnswer } from '../types/models';
import type { TranslationKey } from '../i18n';

export function AssistentPage() {
  const { translate } = useApp();
  const [input, setInput] = useState('');
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [lastQuestion, setLastQuestion] = useState('');

  const ask = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    setLastQuestion(trimmed);
    setAnswer(answerQuestion(trimmed));
    setInput('');
  };

  const handleSuggestion = (questionKey: string) => {
    ask(translate(questionKey as TranslationKey));
  };

  const handleSend = () => {
    ask(input);
  };

  return (
    <div className="page">
      <PageHeader title={translate('assistant.title')} subtitle={translate('assistant.subtitle')} />

      <Card className="assistant-question-card">
        <div className="assistant-question-row">
          <input
            type="text"
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={translate('assistant.placeholder')}
          />
          <Button onClick={handleSend}>{translate('assistant.send')}</Button>
        </div>
      </Card>

      {answer && (
        <section className="assistant-answer-section">
          {lastQuestion && (
            <p className="assistant-last-question">
              <span className="assistant-last-question__label">{translate('assistant.yourQuestion')}</span>
              {lastQuestion}
            </p>
          )}
          <AssistantAnswerCard answer={answer} />
        </section>
      )}

      <section className="section">
        <h2 className="section__title">{translate('assistant.examples')}</h2>
        <div className="chip-group">
          {ASSISTANT_SUGGESTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="chip"
              onClick={() => handleSuggestion(s.questionKey)}
            >
              {translate(s.questionKey as TranslationKey)}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
