import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BrainOrchestrationCard } from '../components/assistant/BrainOrchestrationCard';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { InlineNotice } from '../components/ui/States';
import { Icon } from '../components/ui/Icon';
import { useApp } from '../context/AppContext';
import { isAiProviderConfigured } from '../services/aiProviderService';
import { processOfficePilotQuestion } from '../services/brain/brainOrchestrator';
import { ASSISTANT_EXAMPLE_QUESTION_KEYS } from '../services/officeAssistantService';
import type { BrainOrchestrationResult } from '../types/brainOrchestration';
import type { TranslationKey } from '../i18n';

export function AssistentPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [input, setInput] = useState('');
  const [result, setResult] = useState<BrainOrchestrationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastQuestion, setLastQuestion] = useState('');
  const aiConfigured = isAiProviderConfigured();

  const runQuestion = async (question: string, mode: 'rules' | 'deep' | 'smart') => {
    const trimmed = question.trim();
    if (!trimmed || loading) return;
    setLastQuestion(trimmed);
    setLoading(true);
    try {
      const orchestration = await processOfficePilotQuestion(trimmed, { mode });
      setResult(orchestration);
      setInput('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const q = searchParams.get('q');
    if (q) {
      void runQuestion(q, 'rules');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSuggestion = (questionKey: string) => {
    void runQuestion(translate(questionKey as TranslationKey), 'rules');
  };

  const handleQuickAsk = () => {
    void runQuestion(input, 'rules');
  };

  const handleDeepAsk = () => {
    void runQuestion(input, 'deep');
  };

  const handleSmartAsk = () => {
    void runQuestion(input, 'smart');
  };

  return (
    <Page className="assistant-page" testId="assistant-page">
      {/* UIUX-FOUNDATION-01G — kein Hero-Verlauf: ruhiger Hinweis, Eingabe als Abschnitt. */}
      <PageHeader title={translate('assistant.title')} subtitle={translate('assistant.subtitle')} />

      {/*
        * VISUAL-POLISH-01D — derselbe Eingang wie auf „Heute": Marke, eine
        * Eingabezeile, eine Hauptaktion. Die beiden Antwortarten bleiben als
        * ruhige Textaktionen darunter; Test-IDs und Logik unverändert.
        */}
      <section className="assistant-ask assistant-prompt" data-testid="assistant-ask">
        <div className="assistant-prompt__head">
          <span className="assistant-prompt__mark" aria-hidden>
            <Icon id="assistant" size="sm" />
          </span>
          <span className="assistant-prompt__title">{translate('mobile.home.assistantName')}</span>
          <span className="assistant-prompt__role">{translate('mobile.home.assistantRole')}</span>
        </div>
        <label className="sr-only" htmlFor="assistant-question">
          {translate('assistant.inputLabel')}
        </label>
        <div className="assistant-prompt__form assistant-ask__form">
          <input
            id="assistant-question"
            type="text"
            className="input assistant-input assistant-prompt__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSmartAsk()}
            placeholder={translate('assistant.placeholder')}
            data-testid="assistant-input"
          />
          <Button
            onClick={handleSmartAsk}
            disabled={loading || !input.trim()}
            data-testid="assistant-ask-smart"
            className="assistant-ask__primary"
          >
            {loading ? translate('assistant.thinking') : translate('brain.askSmart')}
          </Button>
        </div>
        <div className="assistant-actions-row assistant-ask__modes">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleQuickAsk}
            disabled={loading || !input.trim()}
            data-testid="assistant-ask-quick"
          >
            {translate('assistant.askQuick')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDeepAsk}
            disabled={loading || !input.trim() || !aiConfigured}
            data-testid="assistant-ask-deep"
          >
            {translate('assistant.askDeep')}
          </Button>
        </div>
        <div className="assistant-prompt__suggestions assistant-ask__examples" data-testid="assistant-examples">
          {ASSISTANT_EXAMPLE_QUESTION_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className="assistant-prompt__chip"
              onClick={() => handleSuggestion(key)}
            >
              {translate(key)}
            </button>
          ))}
        </div>
      </section>

      <InlineNotice tone="info" title={translate('assistant.employeeTitle')} testId="assistant-employee-hero">
        {translate('assistant.employeeHint')}
      </InlineNotice>

      {result && lastQuestion && (
        <p className="assistant-last-question">
          <span className="assistant-last-question__label">{translate('assistant.yourQuestion')}</span>
          {lastQuestion}
        </p>
      )}

      {result && (
        <section
          className="assistant-answer-section"
          data-testid={result.brainAnswer ? 'assistant-brain-answer' : 'assistant-answer'}
        >
          <BrainOrchestrationCard
            result={result}
            onTryDeepAnswer={() => void runQuestion(lastQuestion, 'deep')}
          />
        </section>
      )}

      <DetailSection title={translate('communication.section.title')}>
        <div className="chip-group">
          <button
            type="button"
            className="chip"
            data-testid="assistant-write-message"
            onClick={() => navigate('/kommunikation')}
          >
            {translate('communication.openFromAssistant')}
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => navigate('/wissen')}
          >
            {translate('knowledge.openFromAssistant')}
          </button>
        </div>
      </DetailSection>

    </Page>
  );
}
