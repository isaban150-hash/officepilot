import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Badge, Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { isAiProviderConfigured } from '../../services/ai/aiRequestRunner';
import {
  askDocumentAi,
  appendDocumentAiConversationTurn,
  type DocumentAiSource,
} from '../../services/document/documentAiService';
import { parseFreeTextFieldBridge } from '../../services/documentFieldFillFreeTextBridgeService';
import type { AreaAiAnswer, DocumentAiPriorTurn } from '../../types/areaAi';
import type { DocumentFieldFillFreeTextBridgeParseResult } from '../../types/documentFieldFillFreeTextBridge';

interface DocumentFreeQuestionPanelProps {
  source: DocumentAiSource;
  testIdPrefix?: string;
  /**
   * When set (inbox fill-confirm bridge), unique field statements are handed
   * off locally and are not sent to `askDocumentAi`.
   */
  onFieldStatementProposal?: (
    statement: Extract<DocumentFieldFillFreeTextBridgeParseResult, { kind: 'field_statement' }>,
  ) => void;
}

function sourceDocumentKey(source: DocumentAiSource): string {
  return source.type === 'inbox' ? source.item.id : source.document.id;
}

function assistantTurnFromAnswer(answer: AreaAiAnswer): DocumentAiPriorTurn {
  const text = [answer.directAnswer, answer.explanation].filter(Boolean).join(' ').trim()
    || answer.text.trim();
  return {
    role: 'assistant',
    text,
    ...(answer.uncertain ? { uncertain: true as const } : {}),
    ...(answer.uncertaintyNotes && answer.uncertaintyNotes.length > 0
      ? { uncertaintyNotes: [...answer.uncertaintyNotes] }
      : {}),
  };
}

/**
 * Local session-only free questions for one document.
 * DOCUMENT-ASSIST-02B: ephemeral priorTurns in React state only — never persisted.
 */
export function DocumentFreeQuestionPanel({
  source,
  testIdPrefix = 'document-free-question',
  onFieldStatementProposal,
}: DocumentFreeQuestionPanelProps) {
  const { translate } = useApp();
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<AreaAiAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Ephemeral dialog history for this documentKey only. */
  const [priorTurns, setPriorTurns] = useState<DocumentAiPriorTurn[]>([]);
  const aiConfigured = isAiProviderConfigured();
  /** Ignores late AI results after document switch or newer ask. */
  const requestGenerationRef = useRef(0);
  const documentKey = sourceDocumentKey(source);

  useEffect(() => {
    requestGenerationRef.current += 1;
    setQuestion('');
    setLoading(false);
    setAnswer(null);
    setError(null);
    setPriorTurns([]);
  }, [documentKey]);

  const handleAsk = async () => {
    const trimmed = question.trim();
    if (!trimmed || loading) return;

    if (onFieldStatementProposal) {
      const bridge = parseFreeTextFieldBridge(trimmed);
      if (bridge.kind === 'field_statement') {
        onFieldStatementProposal(bridge);
        setQuestion('');
        setAnswer(null);
        setError(null);
        return;
      }
    }

    if (!aiConfigured) {
      setError(translate('document.freeQuestion.notConfigured'));
      return;
    }

    const requestGeneration = ++requestGenerationRef.current;
    const turnsSnapshot = priorTurns.map((turn) => ({ ...turn }));
    setLoading(true);
    setError(null);
    try {
      const result = await askDocumentAi({
        source,
        question: trimmed,
        priorTurns: turnsSnapshot,
      });
      if (requestGeneration !== requestGenerationRef.current) {
        return;
      }
      setAnswer(result);
      setPriorTurns((current) => {
        let next = appendDocumentAiConversationTurn(current, {
          role: 'user',
          text: trimmed,
        });
        next = appendDocumentAiConversationTurn(next, assistantTurnFromAnswer(result));
        return next;
      });
      if (result.source === 'unavailable' && result.errorCode === 'invalid_prompt') {
        setError(result.text);
      }
      if (result.source === 'ai') {
        setQuestion('');
      }
    } catch {
      if (requestGeneration !== requestGenerationRef.current) {
        return;
      }
      setAnswer(null);
      setError(translate('document.freeQuestion.error.failed'));
    } finally {
      if (requestGeneration === requestGenerationRef.current) {
        setLoading(false);
      }
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
            disabled={
              loading ||
              !question.trim() ||
              (!aiConfigured && !onFieldStatementProposal)
            }
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
