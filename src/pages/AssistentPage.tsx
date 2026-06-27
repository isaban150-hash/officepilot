import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { ASSISTANT_SUGGESTIONS } from '../data/mockData';
import {
  getAssistantResponse,
  getAssistantResponseForText,
} from '../services/assistantService';
import type { ChatMessage } from '../types/models';
import type { TranslationKey } from '../i18n';

function nowTimestamp(): string {
  return new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function AssistentPage() {
  const { translate } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');

  const addExchange = (question: string, answer: string) => {
    const ts = nowTimestamp();
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', text: question, timestamp: ts },
      { id: `a-${Date.now()}`, role: 'assistant', text: answer, timestamp: ts },
    ]);
  };

  const handleSuggestion = (questionKey: string) => {
    const question = translate(questionKey as TranslationKey);
    const response = getAssistantResponse(questionKey);
    addExchange(question, response.text);
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    const response = getAssistantResponseForText(text);
    addExchange(text, response.text);
    setInput('');
  };

  return (
    <div className="page page--chat">
      <PageHeader title={translate('assistant.title')} subtitle={translate('assistant.subtitle')} />

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

      <div className="chat-messages">
        {messages.length === 0 && (
          <p className="empty-state">Stellen Sie eine Frage oder wählen Sie ein Beispiel.</p>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-bubble chat-bubble--${msg.role}`}
          >
            <p className="chat-bubble__text">{msg.text}</p>
            <span className="chat-bubble__time">{msg.timestamp}</span>
          </div>
        ))}
      </div>

      <Card className="chat-input-card">
        <div className="chat-input-row">
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
    </div>
  );
}
