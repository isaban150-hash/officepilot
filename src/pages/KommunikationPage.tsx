import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CommunicationInputCard } from '../components/communication/CommunicationInputCard';
import { CommunicationHistoryPanel } from '../components/communication/CommunicationHistoryPanel';
import { CommunicationResultCard } from '../components/communication/CommunicationResultCard';
import { parseContextRefFromSearchParams } from '../components/communication/communicationNavigation';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { isAiProviderConfigured } from '../services/aiProviderService';
import { buildCommunicationContext } from '../services/communicationContextService';
import { enhanceCommunicationDraft } from '../services/communication/communicationAiService';
import {
  recordChannelSwitched,
  recordCommunicationResult,
  recordDraftCopied,
  recordMarkedAnswered,
  recordMarkedNoReplyNeeded,
  recordRemindLater,
} from '../services/communicationHistoryService';
import { processCommunicationRequest } from '../services/communicationOrchestrator';
import { getLastPersistSuccess } from '../services/persistenceService';
import {
  buildCommunicationResultFromReplyHandoff,
  readDocumentReplyDraftHandoffFromLocationState,
} from '../services/documentReplyDraftHandoffService';
import type {
  CommunicationChannel,
  CommunicationContextRef,
  CommunicationDraft,
  CommunicationRequest,
  CommunicationResult,
} from '../types/communication';
import type { CommunicationAiEnhanceStyle } from '../types/communicationAi';

function parseContextRef(searchParams: URLSearchParams): CommunicationContextRef {
  return parseContextRefFromSearchParams(searchParams);
}

function resetAiState(setters: {
  setAiEnhancedDraft: (draft: CommunicationDraft | null) => void;
  setAiVariant: (variant: 'original' | 'ai') => void;
  setAiMessage: (message: string | null) => void;
}): void {
  setters.setAiEnhancedDraft(null);
  setters.setAiVariant('original');
  setters.setAiMessage(null);
}

export function KommunikationPage() {
  const { translate, showToast } = useApp();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const contextRef = useMemo(() => parseContextRef(searchParams), [searchParams]);
  const communicationContext = useMemo(
    () => buildCommunicationContext(contextRef),
    [contextRef],
  );
  const [userText, setUserText] = useState('');
  const [lastRequestText, setLastRequestText] = useState('');
  const [result, setResult] = useState<CommunicationResult | null>(null);
  const [userAnswers, setUserAnswers] = useState<Record<string, string>>({});
  const [channel, setChannel] = useState<CommunicationChannel>('email');
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [aiEnhancedDraft, setAiEnhancedDraft] = useState<CommunicationDraft | null>(null);
  const [aiVariant, setAiVariant] = useState<'original' | 'ai'>('original');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiStyle, setAiStyle] = useState<CommunicationAiEnhanceStyle>('professional');
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [handoffProposalActive, setHandoffProposalActive] = useState(false);
  const handoffConsumedRef = useRef(false);

  useEffect(() => {
    if (handoffConsumedRef.current) return;
    const payload = readDocumentReplyDraftHandoffFromLocationState(location.state);
    if (!payload) return;

    handoffConsumedRef.current = true;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: {} });

    const handoffResult = buildCommunicationResultFromReplyHandoff(
      payload,
      communicationContext,
    );
    setUserText(payload.coreMessage);
    setLastRequestText(payload.coreMessage);
    setUserAnswers({ coreMessage: payload.coreMessage });
    setChannel('email');
    setResult(handoffResult);
    setHandoffProposalActive(true);
    resetAiState({ setAiEnhancedDraft, setAiVariant, setAiMessage });
    // Intentionally no recordCommunicationResult / send / persist.
  }, [
    location.state,
    location.pathname,
    location.search,
    navigate,
    communicationContext,
  ]);

  const bumpHistory = () => setHistoryRefreshKey((value) => value + 1);
  const runRequest = (
    text: string,
    answers: Record<string, string>,
    activeChannel: CommunicationChannel = channel,
  ) => {
    const request: CommunicationRequest = {
      userText: text,
      contextRef,
      userAnswers: Object.keys(answers).length > 0 ? answers : undefined,
    };
    const nextResult = processCommunicationRequest(request);
    setResult(nextResult);
    setHandoffProposalActive(false);
    resetAiState({ setAiEnhancedDraft, setAiVariant, setAiMessage });
    if (recordCommunicationResult(nextResult, contextRef, text, activeChannel)) {
      bumpHistory();
    }
  };
  const handleSubmit = () => {
    const trimmed = userText.trim();
    if (!trimmed) return;
    setLastRequestText(trimmed);
    setUserAnswers({});
    setChannel('email');
    runRequest(trimmed, {}, 'email');
  };
  const handleMissingSubmit = () => {
    if (!lastRequestText) return;
    runRequest(lastRequestText, userAnswers);
  };
  const handleMissingChange = (fieldId: string, value: string) => {
    setUserAnswers((current) => ({ ...current, [fieldId]: value }));
  };
  const handleChannelChange = (nextChannel: CommunicationChannel) => {
    if (
      nextChannel !== channel &&
      result?.status === 'complete' &&
      result.drafts &&
      lastRequestText
    ) {
      if (recordChannelSwitched(contextRef, nextChannel, result, lastRequestText)) {
        bumpHistory();
      }
    }
    setChannel(nextChannel);
    resetAiState({ setAiEnhancedDraft, setAiVariant, setAiMessage });
  };
  const handleCopied = () => {
    showToast(translate('communication.copied'));
    if (result?.status === 'complete' && result.drafts && lastRequestText) {
      if (recordDraftCopied(contextRef, channel, result, lastRequestText)) {
        bumpHistory();
      }
    }
  };
  const handleMarkAnswered = () => {
    if (recordMarkedAnswered(contextRef, lastRequestText || undefined)) {
      bumpHistory();
    }
    showToast(translate('communication.reply.markedDoneToast'));
  };
  const handleRemindLater = () => {
    if (recordRemindLater(contextRef, lastRequestText || undefined)) {
      bumpHistory();
    }
    showToast(translate('communication.reply.remindLaterToast'));
  };
  const handleMarkNoReplyNeeded = () => {
    if (recordMarkedNoReplyNeeded(contextRef, lastRequestText || undefined)) {
      bumpHistory();
    }
    showToast(translate('communication.reply.noReplyNeededToast'));
  };
  const handleDunningDocumented = () => {
    if (!getLastPersistSuccess()) {
      showToast(translate('persist.failed.userAction'));
      return;
    }
    showToast(translate('dunning.doc.savedToast'));
  };
  const dunningContext =
    contextRef.type === 'invoice' && contextRef.id && contextRef.vorgangId
      ? { vorgangId: contextRef.vorgangId, invoiceId: contextRef.id }
      : null;
  const handleAiEnhance = async () => {
    if (!result?.drafts || aiLoading) return;
    const draft = result.drafts[channel] ?? result.drafts.email;
    if (!draft) return;
    setAiLoading(true);
    setAiMessage(null);
    try {
      const enhanceResult = await enhanceCommunicationDraft({
        context: communicationContext,
        draft,
        channel,
        style: aiStyle,
      });
      if (enhanceResult.source === 'unavailable') {
        setAiMessage(enhanceResult.message ?? translate('communication.ai.notConfigured'));
        return;
      }
      if (enhanceResult.source === 'rule_fallback') {
        setAiEnhancedDraft(null);
        setAiVariant('original');
        setAiMessage(enhanceResult.message ?? null);
        return;
      }
      if (enhanceResult.enhancedDraft) {
        setAiEnhancedDraft(enhanceResult.enhancedDraft);
        setAiVariant('ai');
        setAiMessage(null);
      }
    } finally {
      setAiLoading(false);
    }
  };
  const contextHintKey =
    contextRef.type === 'none' ? undefined : (`communication.context.${contextRef.type}` as const);
  return (
    <div className="page" data-testid="kommunikation-page">
      <PageHeader
        title={translate('communication.page.title')}
        subtitle={translate('communication.page.subtitle')}
      />
      {contextHintKey && (
        <p className="communication-context-hint" data-testid="communication-context-hint">
          {translate(contextHintKey)}
        </p>
      )}
      {communicationContext && contextRef.type !== 'none' && (
        <div className="communication-context-summary" data-testid="communication-context-summary">
          {communicationContext.recipient?.name && (
            <p className="communication-context-summary__line">
              <span className="communication-context-summary__label">
                {translate('communication.context.recipient')}
              </span>
              {communicationContext.recipient.name}
            </p>
          )}
          {communicationContext.subject && (
            <p className="communication-context-summary__line">
              <span className="communication-context-summary__label">
                {translate('communication.context.subject')}
              </span>
              {communicationContext.subject}
            </p>
          )}
        </div>
      )}
      <CommunicationInputCard
        value={userText}
        onChange={setUserText}
        onSubmit={handleSubmit}
        placeholder={translate('communication.input.placeholder')}
        submitLabel={translate('communication.input.submit')}
      />
      {lastRequestText && (
        <p className="communication-last-request">
          <span className="communication-last-request__label">
            {translate('communication.lastRequest')}
          </span>
          {lastRequestText}
        </p>
      )}
      {result && (
        <section className="communication-result-section">
          {handoffProposalActive ? (
            <p
              className="communication-handoff-proposal-badge"
              data-testid="communication-handoff-proposal-badge"
            >
              Vorschlag – noch nicht gespeichert oder versendet
            </p>
          ) : null}
          <CommunicationResultCard
            result={result}
            channel={channel}
            onChannelChange={handleChannelChange}
            missingValues={userAnswers}
            onMissingChange={handleMissingChange}
            onMissingSubmit={handleMissingSubmit}
            translate={translate}
            onCopied={handleCopied}
            onMarkAnswered={handleMarkAnswered}
            onRemindLater={handleRemindLater}
            onMarkNoReplyNeeded={handleMarkNoReplyNeeded}
            dunningContext={dunningContext}
            onDunningDocumented={handleDunningDocumented}
            aiConfigured={isAiProviderConfigured()}
            aiLoading={aiLoading}
            aiStyle={aiStyle}
            onAiStyleChange={setAiStyle}
            onAiEnhance={() => void handleAiEnhance()}
            aiEnhancedDraft={aiEnhancedDraft}
            onAiVariantChange={setAiVariant}
            aiVariant={aiVariant}
            aiMessage={aiMessage}
          />
        </section>
      )}
      <CommunicationHistoryPanel contextRef={contextRef} refreshKey={historyRefreshKey} />
    </div>
  );
}
