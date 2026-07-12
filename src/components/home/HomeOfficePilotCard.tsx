import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { ASSISTANT_EXAMPLE_QUESTION_KEYS } from '../../services/officeAssistantService';
import type { TranslationKey } from '../../i18n';

export function HomeOfficePilotCard() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [input, setInput] = useState('');

  const ask = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    navigate(`/assistent?q=${encodeURIComponent(trimmed)}`);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    ask(input);
  };

  return (
    <section className="mobile-home-card mobile-home-card--assistant" data-testid="home-card-officepilot">
      <div className="mobile-home-card__body">
        <span className="mobile-home-card__emoji" aria-hidden>
          🤖
        </span>
        <span className="mobile-home-card__title">{translate('mobile.home.assistantTitle')}</span>
      </div>

      <form className="mobile-home-assistant" onSubmit={handleSubmit}>
        <div className="mobile-home-assistant__row">
          <button
            type="button"
            className="mobile-home-assistant__mic"
            data-testid="home-assistant-mic"
            aria-label={translate('mobile.home.micLabel')}
            onClick={() => navigate('/assistent')}
          >
            🎤
          </button>
          <input
            type="text"
            className="input mobile-home-assistant__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={translate('mobile.home.assistantPlaceholder')}
            data-testid="home-assistant-input"
          />
          <button
            type="submit"
            className="mobile-home-assistant__send"
            data-testid="home-assistant-send"
            disabled={!input.trim()}
          >
            →
          </button>
        </div>
      </form>

      <div className="mobile-home-assistant__suggestions">
        {ASSISTANT_EXAMPLE_QUESTION_KEYS.slice(0, 3).map((key) => (
          <button
            key={key}
            type="button"
            className="mobile-home-assistant__chip"
            data-testid={`home-assistant-suggestion-${key}`}
            onClick={() => ask(translate(key as TranslationKey))}
          >
            {translate(key as TranslationKey)}
          </button>
        ))}
      </div>
    </section>
  );
}
