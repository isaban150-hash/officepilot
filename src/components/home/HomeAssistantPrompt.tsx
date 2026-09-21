import { useEffect, useState } from 'react';
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
/* Dieselbe Grenze wie die Mobil-Regeln der Startseite in visual-pilot-02b.css. */
const MOBILE_MQ = '(max-width: 1023px)';

interface HomeAssistantPromptProps {
  /**
   * STARTSEITE-03B — die Startseite zeigt nur Beispiele, die ohne Dokument-
   * oder Auftragsbezug tatsächlich eine Antwort liefern, und kein Mikrofon,
   * weil es keine Spracheingabe gibt. Andere Stellen behalten den bisherigen
   * Auftritt.
   */
  exampleKeys?: readonly TranslationKey[];
  placeholderKey?: TranslationKey;
  /** 04B-F1 — kürzerer Platzhalter unter 1024 px, damit er ganz sichtbar bleibt. */
  mobilePlaceholderKey?: TranslationKey;
  showMic?: boolean;
  /** 04B — Text im Senden-Knopf; ohne Angabe bleibt nur das Pfeilsymbol. */
  sendLabelKey?: TranslationKey;
}

export function HomeAssistantPrompt({
  exampleKeys = ASSISTANT_EXAMPLE_QUESTION_KEYS.slice(0, 3),
  placeholderKey = 'mobile.home.assistantPlaceholder',
  mobilePlaceholderKey,
  showMic = true,
  sendLabelKey,
}: HomeAssistantPromptProps = {}) {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [schmal, setSchmal] = useState(false);

  useEffect(() => {
    if (!mobilePlaceholderKey || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(MOBILE_MQ);
    const sync = () => setSchmal(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [mobilePlaceholderKey]);

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
        {showMic ? (
          <button
            type="button"
            className="assistant-prompt__icon"
            data-testid="home-assistant-mic"
            aria-label={translate('mobile.home.micLabel')}
            onClick={() => navigate('/assistent')}
          >
            <Icon id="more" size="sm" />
          </button>
        ) : null}
        <input
          type="text"
          className="input assistant-prompt__input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={translate(schmal && mobilePlaceholderKey ? mobilePlaceholderKey : placeholderKey)}
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
          {sendLabelKey ? <span className="assistant-prompt__send-label">{translate(sendLabelKey)}</span> : null}
          <Icon id="arrow-right" size="sm" />
        </button>
      </form>
      <div className="assistant-prompt__suggestions">
        {exampleKeys.map((key) => (
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
