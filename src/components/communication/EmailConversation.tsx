/**
 * E-MAIL 07F-01A — Gesprächsverlauf (Business-Mail-Verlauf, keine Chat-Blasen).
 *
 * Alle Nachrichten desselben OfficeTakt-Threads chronologisch, älteste
 * zuerst: eingehend und ausgehend klar unterschieden (Kennzeichnung + Rand),
 * Absender, Empfänger, Zeitpunkt, Versandstatus ausgehender Mail in
 * Alltagssprache (nie „zugestellt"/„gelesen" — das liefert erst 07F-01B),
 * Zuordnungsstatus eingehender Mail, Anhänge je Nachricht. Der Betreff steht
 * nur dort, wo er sich vom Verlauf unterscheidet. Text ausschließlich als
 * Text, nie als HTML. Neuversuche einer ausgehenden Mail erscheinen als EINE
 * Nachricht mit dem Stand des letzten Versuchs.
 *
 * Bei nur einer Nachricht rendert die Komponente nichts — die Detailseite
 * bleibt dann die ruhige Einzelansicht.
 */
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { StatusBadge } from '../ui/Badge';
import type { EmailMessage } from '../../types/emailMessage';
import { groupEmailThreads } from '../../services/email/freeEmailOrchestrator';
import { normalizeReplySubject } from '../../../supabase/functions/_shared/emailThreadRules';
import { inboundSenderLabel } from './InboxEmailList';
import { emailDisplayLabelKey, emailDisplayTone, formatBytes, formatTimestamp } from './freeEmailUi';

export interface ConversationEntry {
  message: EmailMessage;
  /** Ausgehend: Anzahl der Versuche (Neuversuche zusammengefasst). */
  attempts: number;
  at: string;
}

/** Verlauf aufbereiten: jede Nachricht einmal, Neuversuche zusammengefasst, älteste zuerst. */
export function buildConversation(messages: EmailMessage[]): ConversationEntry[] {
  const unique = [...new Map(messages.map((message) => [message.id, message])).values()];
  const inbound = unique.filter((message) => message.direction === 'inbound');
  const outbound = groupEmailThreads(unique.filter((message) => message.direction !== 'inbound'));
  const entries: ConversationEntry[] = [
    ...inbound.map((message) => ({ message, attempts: 1, at: message.receivedAt ?? message.createdAt })),
    ...outbound.map((thread) => ({ message: thread.latest, attempts: thread.attempts.length, at: thread.latest.providerAcceptedAt ?? thread.root.createdAt })),
  ];
  return entries.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || a.message.id.localeCompare(b.message.id));
}

/** Betreff ohne Antwortpräfix — zum Vergleich innerhalb des Verlaufs. */
function subjectKey(subject: string): string {
  return normalizeReplySubject(subject).replace(/^Re:\s*/, '').toLowerCase();
}

interface Props {
  messages: EmailMessage[];
  /** Die auf dieser Seite geöffnete Nachricht (hervorgehoben, nicht verlinkt). */
  currentId: string;
  testId?: string;
}

export function EmailConversation({ messages, currentId, testId = 'email-conversation' }: Props) {
  const { translate } = useApp();
  const t = (key: string) => translate(key as TranslationKey);
  const entries = buildConversation(messages);
  if (entries.length < 2) return null;
  const threadSubject = subjectKey(entries[0].message.subject);

  return (
    <ol className="email-conversation" data-testid={testId}>
      {entries.map(({ message, attempts }) => {
        const inbound = message.direction === 'inbound';
        const current = message.id === currentId;
        const sender = inbound ? inboundSenderLabel(message) : message.senderName || t('emailThread.us');
        const recipients = [...message.to, ...message.cc].join(', ');
        const showSubject = subjectKey(message.subject) !== threadSubject;
        const detailHref = inbound ? `/kommunikation/eingang/${message.id}` : `/kommunikation/email/${message.id}`;
        return (
          <li
            key={message.id}
            className={`email-conversation__item email-conversation__item--${inbound ? 'inbound' : 'outbound'}${current ? ' email-conversation__item--current' : ''}`}
            data-testid={`${testId}-item`}
            data-direction={inbound ? 'inbound' : 'outbound'}
            aria-current={current ? 'true' : undefined}
          >
            <div className="email-conversation__head">
              <span className="email-conversation__direction" data-testid={`${testId}-direction`}>
                {t(inbound ? 'emailThread.received' : 'emailThread.sent')}
              </span>
              <span className="email-conversation__date" data-testid={`${testId}-date`}>
                {formatTimestamp(inbound ? message.receivedAt : message.providerAcceptedAt ?? message.createdAt)}
              </span>
              {inbound ? (
                message.assignmentStatus === 'needs_review' ? (
                  <StatusBadge tone="warning" label={t('inboundEmail.status.needs_review')} icon={false} />
                ) : null
              ) : (
                <StatusBadge tone={emailDisplayTone(message)} label={t(emailDisplayLabelKey(message))} icon={false} data-testid={`${testId}-status`} />
              )}
            </div>
            <p className="email-conversation__party" data-testid={`${testId}-from`}>
              <span className="email-conversation__label">{t('emailThread.from')}</span> {sender}
            </p>
            {recipients ? (
              <p className="email-conversation__party" data-testid={`${testId}-to`}>
                <span className="email-conversation__label">{t('emailThread.to')}</span> {recipients}
              </p>
            ) : null}
            {showSubject ? (
              <p className="email-conversation__subject" data-testid={`${testId}-subject`}>{message.subject || t('inboundEmail.inbox.noSubject')}</p>
            ) : null}
            {/* Nur Text: React setzt den Inhalt als Textknoten, nie als HTML. */}
            <pre className={`email-conversation__body${current ? '' : ' email-conversation__body--collapsed'}`} data-testid={`${testId}-body`}>
              {message.bodyText}
            </pre>
            {message.attachments.length > 0 ? (
              <ul className="email-conversation__attachments" data-testid={`${testId}-attachments`}>
                {message.attachments.map((attachment) => (
                  <li key={attachment.position}>{attachment.filename} · {formatBytes(attachment.sizeBytes)}</li>
                ))}
              </ul>
            ) : null}
            <div className="email-conversation__foot">
              {!inbound && attempts > 1 ? (
                <span className="form-hint" data-testid={`${testId}-attempts`}>{t('emailThread.attempts').replace('{n}', String(attempts))}</span>
              ) : null}
              {!inbound && message.status === 'failed' && message.errorMessageSafe ? (
                <span className="form-hint">{message.errorMessageSafe}</span>
              ) : null}
              {current ? (
                <span className="form-hint" data-testid={`${testId}-current`}>{t('emailThread.current')}</span>
              ) : (
                <Link to={detailHref} className="email-conversation__open" data-testid={`${testId}-open`}>{t('emailThread.open')}</Link>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
