import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Badge, Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { isAiProviderConfigured } from '../../services/ai/aiRequestRunner';
import {
  askDocumentAi,
  appendDocumentAiConversationTurn,
  shouldPersistDocumentAiConversationExchange,
  type DocumentAiSource,
} from '../../services/document/documentAiService';
import { parseFreeTextFieldBridge } from '../../services/documentFieldFillFreeTextBridgeService';
import {
  buildReminderProposal,
  confirmReminderProposal,
  looksLikeReminderAnswer,
  type ReminderProposal,
} from '../../services/document/documentReminderProposalService';
import type { SemanticDeadline } from '../../types/documentSemanticCore';
import {
  buildLetterPrefill,
  buildReplyDraft,
  hasEmailAddress,
  hasPostalAddress,
  isReplyRequest,
  type ReplyDraftResult,
} from '../../services/document/documentReplyBridgeService';
import { getCompanyProfileStoreSnapshot } from '../../services/companyProfileService';
import {
  buildDocumentReplyDraftHandoffPayload,
  createDocumentReplyDraftHandoffLocationState,
} from '../../services/documentReplyDraftHandoffService';
import { buildDocumentAiContextFromInbox } from '../../services/document/documentAiContextService';
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

/** ISO in der gewohnten Schreibweise. */
function formatIso(iso: string): string {
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return t ? `${t[3]}.${t[2]}.${t[1]}` : iso;
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
 * DOCUMENT-ASSIST-02B/02C: ephemeral priorTurns — never persisted; unavailable excluded.
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
  /*
   * DOKUMENT-ASSISTENT-01F — der Wiedervorlagevorschlag.
   *
   * Er ist rein beschreibend und wird niemals von selbst ausgefuehrt. Erst
   * ein Klick auf „Wiedervorlage anlegen" ruft den bestehenden Aufgabendienst.
   */
  const [reminder, setReminder] = useState<ReminderProposal | null>(null);
  const [reminderChoices, setReminderChoices] = useState<SemanticDeadline[]>([]);
  /*
   * 01K-F1 — der Wunsch, auf den die offene Rückfrage wartet.
   *
   * Solange OfficeTakt „welche Frist?" gefragt hat, ist die nächste kurze
   * Eingabe die Antwort darauf — nicht eine neue Dokumentfrage. Ohne dieses
   * Gedächtnis wanderte „30.09.2026" an das Modell und wurde erklärt statt
   * verstanden. Der Text selbst wird gebraucht, weil er den Vorlauf trägt.
   */
  const [reminderPending, setReminderPending] = useState<string | null>(null);
  const [reminderDone, setReminderDone] = useState<string | null>(null);
  /*
   * DOKUMENT-ASSISTENT-01G — der Antwortentwurf.
   *
   * Er entsteht im vorhandenen Entwurfsweg und hat keinerlei aeussere Wirkung.
   * Erst die Kanalwahl fuehrt weiter — in den bestehenden Briefeditor oder in
   * den bestehenden Kommunikationsweg. Versendet wird hier nichts.
   */
  const [reply, setReply] = useState<ReplyDraftResult | null>(null);
  const navigate = useNavigate();
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

    /*
     * Ein Antwortwunsch geht nicht in die Frage-Kette: Die darf keine neue
     * Angabe erzeugen und verwarf deshalb „Schreib denen, dass wir am 25.09.
     * kommen" mit „Neue Datumsangabe nicht erlaubt". Ein Entwurf ist aber
     * genau dafuer da, die Angabe des Benutzers aufzunehmen.
     */
    if (source.type === 'inbox' && isReplyRequest(trimmed)) {
      const kern = buildDocumentAiContextFromInbox(source.item, {
        liveWorkflow: source.liveWorkflow ?? null,
        sessionFillConfirmRows: source.sessionFillConfirmRows ?? null,
      }).semantic;
      const entwurf = buildReplyDraft({
        text: trimmed,
        item: source.item,
        core: kern,
        companyProfile: getCompanyProfileStoreSnapshot() ?? null,
      });
      if (entwurf) {
        setReply(entwurf);
        setReminder(null);
        setReminderChoices([]);
        setError(null);
        return;
      }
    }

    /*
     * Ein Wiedervorlagewunsch wird deterministisch behandelt: Datum und
     * Frist rechnet OfficeTakt selbst. Das Modell soll kein Datum raten.
     */
    if (source.type === 'inbox') {
      const kern = buildDocumentAiContextFromInbox(source.item, {
        liveWorkflow: source.liveWorkflow ?? null,
        sessionFillConfirmRows: source.sessionFillConfirmRows ?? null,
      }).semantic;
      /*
       * 01K-F1 — eine offene Rückfrage bindet die nächste kurze Eingabe.
       * Eine echte neue Frage (lang oder mit Fragezeichen) löst die
       * Rückfrage auf und geht ihren gewohnten Weg.
       */
      const antwortAufRueckfrage =
        reminderChoices.length > 0 && reminderPending && looksLikeReminderAnswer(trimmed)
          ? reminderPending
          : undefined;
      const vorschlag = buildReminderProposal({
        text: trimmed,
        item: source.item,
        core: kern,
        pendingRequest: antwortAufRueckfrage,
      });
      if (vorschlag.kind === 'proposal') {
        setReminder(vorschlag.value);
        setReminderChoices([]);
        setReminderPending(null);
        setReminderDone(null);
        setError(null);
        return;
      }
      if (vorschlag.kind === 'needs_choice') {
        setReminder(null);
        setReminderChoices(vorschlag.options);
        setReminderPending(antwortAufRueckfrage ?? trimmed);
        setReminderDone(null);
        setError(null);
        return;
      }
      if (!antwortAufRueckfrage) {
        setReminderChoices([]);
        setReminderPending(null);
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
      if (shouldPersistDocumentAiConversationExchange(result)) {
        setPriorTurns((current) => {
          let next = appendDocumentAiConversationTurn(current, {
            role: 'user',
            text: trimmed,
          });
          next = appendDocumentAiConversationTurn(next, assistantTurnFromAnswer(result));
          return next;
        });
        setQuestion('');
      }
      if (result.source === 'unavailable' && result.errorCode === 'invalid_prompt') {
        setError(result.text);
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
        {/*
          * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01C — im Ausgangszustand nur
          * Überschrift und Eingabefeld.
          *
          * Der Geltungshinweis ist richtig und bleibt — er erscheint aber erst,
          * wenn jemand tatsächlich fragt. Vorher füllte er auf dem Telefon eine
          * halbe Bildschirmhöhe, bevor die erste Frage getippt war. Kontext,
          * Datenübergabe und Antwortlogik sind unverändert.
          */}
        {question.trim() || loading || answer ? (
          <p
            className="document-free-question-panel__hint"
            data-testid={`${testIdPrefix}-scope-hint`}
          >
            {translate('document.freeQuestion.scopeHint')}
          </p>
        ) : null}
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
        {/*
          * DOKUMENT-ASSISTENT-01G — Entwurf und Kanalwahl.
          *
          * Der Entwurf steht hier nur zum Lesen. Die beiden Schaltflaechen
          * fuehren in den bestehenden Briefeditor beziehungsweise in den
          * bestehenden Kommunikationsweg — sie versenden nichts und stellen
          * nichts fertig.
          */}
        {reply ? (
          <div className="area-ai-panel__answer" data-testid={`${testIdPrefix}-reply-draft`}>
            <p className="area-ai-panel__answer-direct" data-testid={`${testIdPrefix}-reply-subject`}>
              {reply.draft.subject}
            </p>
            <p className="brief-detail__body" data-testid={`${testIdPrefix}-reply-body`}>
              {reply.draft.body}
            </p>
            <p className="document-meaning__hint" data-testid={`${testIdPrefix}-reply-recipient`}>
              {translate('documentReply.recipient')}{' '}
              {reply.recipient.name || translate('documentReply.recipientUnknown')}
            </p>
            {!hasPostalAddress(reply.recipient) ? (
              <p className="document-meaning__hint" data-testid={`${testIdPrefix}-reply-no-address`}>
                {translate('documentReply.missingAddress')}
              </p>
            ) : null}
            {!hasEmailAddress(reply.recipient) ? (
              <p className="document-meaning__hint" data-testid={`${testIdPrefix}-reply-no-email`}>
                {translate('documentReply.missingEmail')}
              </p>
            ) : null}
            <p className="document-meaning__hint">{translate('documentReply.chooseChannel')}</p>
            <div className="form-actions">
              <Button
                type="button"
                variant={reply.channelPreference === 'email' ? 'outline' : 'primary'}
                onClick={() => {
                  navigate('/schreiben/neu', {
                    state: { officetaktLetterDraftPrefill: buildLetterPrefill(reply) },
                  });
                }}
                data-testid={`${testIdPrefix}-reply-letter`}
              >
                {translate('documentReply.asLetter')}
              </Button>
              <Button
                type="button"
                variant={reply.channelPreference === 'email' ? 'primary' : 'outline'}
                onClick={() => {
                  if (source.type !== 'inbox') return;
                  const payload = buildDocumentReplyDraftHandoffPayload({
                    item: source.item,
                    draft: {
                      body: reply.draft.body,
                      considered: [],
                      notIncluded: [...reply.draft.notIncluded],
                    } as never,
                    coreMessage: reply.draft.body,
                  });
                  navigate(
                    '/kommunikation',
                    payload
                      ? { state: createDocumentReplyDraftHandoffLocationState(payload) }
                      : undefined,
                  );
                }}
                data-testid={`${testIdPrefix}-reply-email`}
              >
                {translate('documentReply.asEmail')}
              </Button>
            </div>
            <p className="document-meaning__hint">{translate('documentReply.nothingSentYet')}</p>
          </div>
        ) : null}
        {/*
          * DOKUMENT-ASSISTENT-01F — Vorschlag und Bestaetigung.
          *
          * Der Vorschlag nennt beides: wann erinnert wird und welche Frist im
          * Schreiben dahintersteht. Angelegt wird erst auf Klick.
          */}
        {reminderChoices.length > 0 ? (
          <div className="area-ai-panel__answer" data-testid={`${testIdPrefix}-reminder-choice`}>
            <p>{translate('documentReminder.chooseDeadline')}</p>
            <ul className="document-meaning__list">
              {reminderChoices.map((frist) => (
                <li key={`${frist.date}-${frist.type}`} className="document-meaning__item">
                  {frist.appliesTo}: {formatIso(frist.date)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {reminder ? (
          <div className="area-ai-panel__answer" data-testid={`${testIdPrefix}-reminder-proposal`}>
            <p className="area-ai-panel__answer-direct">
              {translate('documentReminder.proposalTitle')} {formatIso(reminder.remindOn)}
            </p>
            <p data-testid={`${testIdPrefix}-reminder-title`}>{reminder.proposal.title}</p>
            <p className="document-meaning__hint">
              {translate('documentReminder.documentDeadline')} {formatIso(reminder.deadline.date)}
            </p>
            {reminder.alreadyExists ? (
              <p className="document-meaning__hint" data-testid={`${testIdPrefix}-reminder-exists`}>
                {translate('documentReminder.alreadyExists')}
              </p>
            ) : null}
            <Button
              type="button"
              onClick={() => {
                const ergebnis = confirmReminderProposal(reminder.proposal);
                setReminderDone(
                  ergebnis.ok && ergebnis.created
                    ? translate('documentReminder.created')
                    : translate('documentReminder.alreadyExists'),
                );
                setReminder(null);
              }}
              data-testid={`${testIdPrefix}-reminder-confirm`}
            >
              {translate('documentReminder.confirm')}
            </Button>
          </div>
        ) : null}
        {reminderDone ? (
          <p className="area-ai-panel__hint" data-testid={`${testIdPrefix}-reminder-done`}>
            {reminderDone}
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
            {answer.knowledgeSources && answer.knowledgeSources.length > 0 ? (
              /*
               * DOKUMENT-ASSISTENT-01H3 — die Belege.
               *
               * Knapp und je Aussage: Wer wissen will, worauf ein Satz beruht,
               * soll es finden, ohne eine Literaturliste zu lesen. Erscheint
               * nur, wenn tatsächlich belegtes Fachwissen verwendet wurde —
               * bei einer reinen Dokumentfrage steht hier nichts.
               */
              <div
                className="document-free-question-panel__sources"
                data-testid={`${testIdPrefix}-knowledge-sources`}
              >
                <p className="document-free-question-panel__sources-title">
                  {translate('document.freeQuestion.sources.title')}
                </p>
                <ul>
                  {answer.knowledgeSources.map((quelle) => (
                    <li key={quelle.statementId}>
                      <span>{quelle.sourceTitle}</span>
                      <span className="document-free-question-panel__sources-meta">
                        {quelle.publisher} ·{' '}
                        {translate('document.freeQuestion.sources.reviewedAt')}{' '}
                        {formatIso(quelle.reviewedAt)}
                      </span>
                      {quelle.url ? (
                        <a href={quelle.url} target="_blank" rel="noopener noreferrer">
                          {translate('document.freeQuestion.sources.open')}
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
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
