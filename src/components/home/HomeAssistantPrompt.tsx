import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { ASSISTANT_EXAMPLE_QUESTION_KEYS } from '../../services/officeAssistantService';
import type { TranslationKey } from '../../i18n';
import { Icon } from '../ui/Icon';

/**
 * VISUAL-POLISH-01B — kompakter OfficePilot-Eingang auf Heute: eine Zeile mit
 * Feld und Senden, darunter höchstens drei Vorschläge. Ersetzt die große
 * Assistent-Karte; die Weiterleitung zum Assistenten ist unverändert.
 */
export function HomeAssistantPrompt() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [input, setInput] = useState('');

  const ask = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    navigate(`/assistent?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <section className="home-assistant assistant-prompt" data-testid="home-card-officepilot" aria-label={translate('mobile.home.assistantTitle')}>
      {/* WOW-Pass: klar als Assistent erkennbar — Name und Rolle über dem Eingang, kein Textfeld ohne Kontext. */}
      <div className="assistant-prompt__head">
        <span className="assistant-prompt__mark" aria-hidden>
          <Icon id="assistant" size="sm" />
        </span>
        <span className="assistant-prompt__title">{translate('mobile.home.assistantName')}</span>
        <span className="assistant-prompt__role">{translate('mobile.home.assistantRole')}</span>
      </div>
      <form
        className="assistant-prompt__form"
        onSubmit={(event) => {
          event.preventDefault();
          ask(input);
        }}
      >
        <button
          type="button"
          className="assistant-prompt__icon"
          data-testid="home-assistant-mic"
          aria-label={translate('mobile.home.micLabel')}
          onClick={() => navigate('/assistent')}
        >
          <Icon id="more" size="sm" />
        </button>
        <input
          type="text"
          className="input assistant-prompt__input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={translate('mobile.home.assistantPlaceholder')}
          aria-label={translate('mobile.home.assistantTitle')}
          data-testid="home-assistant-input"
        />
        <button
          type="submit"
          className="assistant-prompt__send"
          data-testid="home-assistant-send"
          aria-label={translate('mobile.home.assistantPlaceholder')}
          disabled={!input.trim()}
        >
          <Icon id="arrow-right" size="sm" />
        </button>
      </form>
      <div className="assistant-prompt__suggestions">
        {ASSISTANT_EXAMPLE_QUESTION_KEYS.slice(0, 3).map((key) => (
          <button
            key={key}
            type="button"
            className="assistant-prompt__chip"
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
