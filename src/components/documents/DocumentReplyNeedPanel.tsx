/**
 * P1 EINGANGSSCHREIBEN — der sichtbare Antwortblock.
 *
 * Zeigt den Antwortbedarf aus der einen Ableitung (`documentReplyNeedService`)
 * und führt in die vorhandenen Schreibwege: den Briefeditor und — nur bei
 * belastbarer Adresse — den E-Mail-Editor. Hier wird nichts gesendet und nichts
 * fertiggestellt. „Keine Antwort nötig" ist die bestehende Nutzerentscheidung
 * im Kommunikationsverlauf.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { recordMarkedNoReplyNeeded } from '../../services/communicationHistoryService';
import { isReplyNeedPending, type DocumentReplyNeed } from '../../services/documentReplyNeedService';
import { LETTER_DRAFT_PREFILL_STATE_KEY } from '../../services/document/documentReplyBridgeService';
import {
  buildReplyEmailHref,
  buildReplyLetterPrefill,
  replySourceToContextRef,
  resolveDocumentReplySource,
} from '../../services/document/documentReplySourceService';
import type { DocumentReplySourceRef } from '../../types/documentReply';
import { formatSafeDocumentDate } from '../../utils/documentDateDisplay';

interface DocumentReplyNeedPanelProps {
  need: DocumentReplyNeed;
  /** Das Schreiben, aus dem die Antwort vorbereitet wird. */
  source: DocumentReplySourceRef;
  /** Nach einer Entscheidung neu berechnen lassen. */
  onChanged?: () => void;
  /** testid der Hauptaktion — das Dokumentdetail behält seinen bestehenden Vertrag. */
  prepareTestId?: string;
  /** Volle Breite in der Aktionszeile des Dokumentdetails. */
  fullWidthActions?: boolean;
}

function formatDay(value: string | undefined): string {
  return value ? formatSafeDocumentDate(value.slice(0, 10), 'de', '') : '';
}

const REASON_KEY: Record<string, TranslationKey> = {
  response_deadline: 'replyNeed.reason.responseDeadline',
  communication_request: 'replyNeed.reason.communicationRequest',
  user_reopened: 'replyNeed.reason.userReopened',
};

export function DocumentReplyNeedPanel({
  need,
  source,
  onChanged,
  prepareTestId = 'document-reply-need-prepare',
  fullWidthActions = false,
}: DocumentReplyNeedPanelProps) {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const [channelChoice, setChannelChoice] = useState(false);

  if (need.state === 'answered' && need.decisiveEvent) {
    const event = need.decisiveEvent;
    const channelKey: TranslationKey | null =
      event.channel === 'letter' ? 'replyNeed.channel.letter' : event.channel === 'email' ? 'replyNeed.channel.email' : null;
    const letterId = event.answerRef?.kind === 'letter' ? event.answerRef.id : undefined;
    return (
      <p className="form-hint document-reply-need__answered" data-testid="document-reply-need-answered">
        {translate('replyNeed.answered')}
        {formatDay(event.timestamp) ? ` · ${formatDay(event.timestamp)}` : ''}
        {channelKey ? ` · ${translate(channelKey)}` : ''}
        {letterId ? (
          <>
            {' · '}
            <Link to={`/schreiben/${encodeURIComponent(letterId)}`} data-testid="document-reply-need-answer-link">
              {translate('replyNeed.openAnswer')}
            </Link>
          </>
        ) : null}
      </p>
    );
  }

  if (!isReplyNeedPending(need)) return null;

  const info = resolveDocumentReplySource(source);
  const emailHref = info ? buildReplyEmailHref(info) : null;
  const due = formatDay(need.dueDate);
  const reasonKey = REASON_KEY[need.reason];
  const recipientName = info?.recipient.organization || info?.recipient.name || '';
  const recipientKey: TranslationKey =
    info?.recipient.source === 'confirmed_customer' ? 'replyNeed.recipient.customer' : 'replyNeed.recipient.sender';

  const openLetter = () => {
    if (!info) return;
    navigate('/schreiben/neu', {
      state: { [LETTER_DRAFT_PREFILL_STATE_KEY]: buildReplyLetterPrefill(info) },
    });
  };
  const openEmail = () => {
    if (emailHref) navigate(emailHref);
  };
  const prepare = () => {
    if (emailHref) setChannelChoice(true);
    else openLetter();
  };
  const markNoReplyNeeded = () => {
    const event = recordMarkedNoReplyNeeded(replySourceToContextRef(source));
    if (event) showToast(translate('replyNeed.noReplyToast'));
    onChanged?.();
  };

  return (
    <section className="document-reply-need" data-testid="document-reply-need" aria-live="polite">
      <p className="document-reply-need__title" data-testid="document-reply-need-title">
        {due ? translate('replyNeed.requiredUntil').replace('{date}', due) : translate('replyNeed.required')}
      </p>
      {reasonKey ? (
        <p className="form-hint" data-testid="document-reply-need-reason">
          {translate(reasonKey)}
        </p>
      ) : null}
      {need.state === 'draft_ready' || need.state === 'copied' ? (
        <p className="form-hint" data-testid="document-reply-need-draft-hint">
          {translate('replyNeed.draftHint')}
        </p>
      ) : null}
      {recipientName ? (
        <p className="form-hint" data-testid="document-reply-need-recipient">
          {translate(recipientKey).replace('{name}', recipientName)}
        </p>
      ) : info ? (
        <p className="form-hint" data-testid="document-reply-need-recipient">
          {translate('replyNeed.recipient.unknown')}
        </p>
      ) : null}
      <div className="form-actions document-reply-need__actions">
        {channelChoice ? (
          <>
            <Button fullWidth={fullWidthActions} onClick={openLetter} data-testid="document-reply-need-letter">
              {translate('replyNeed.asLetter')}
            </Button>
            <Button
              fullWidth={fullWidthActions}
              variant="outline"
              onClick={openEmail}
              data-testid="document-reply-need-email"
            >
              {translate('replyNeed.asEmail')}
            </Button>
          </>
        ) : (
          <Button fullWidth={fullWidthActions} onClick={prepare} disabled={!info} data-testid={prepareTestId}>
            {translate('replyNeed.prepare')}
          </Button>
        )}
        <Button
          fullWidth={fullWidthActions}
          variant="ghost"
          onClick={markNoReplyNeeded}
          data-testid="document-reply-need-no-reply"
        >
          {translate('replyNeed.noReply')}
        </Button>
      </div>
    </section>
  );
}
