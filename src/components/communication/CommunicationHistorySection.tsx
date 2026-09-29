/**
 * E-MAIL-07C — Kommunikation beim Kunden und beim Vorgang.
 *
 * Eine Zeile je Versandkette: der neueste Versuch bestimmt Status und Zeit,
 * frühere Versuche stehen als Verlauf darunter („Versuch 1: Versand
 * fehlgeschlagen · Versuch 2: An E-Mail-Dienst übergeben"). So entsteht aus
 * einem wiederholten Versand kein scheinbar zweiter Vorgang. Status in
 * Alltagssprache, nie technische Kennungen.
 *
 * E-MAIL-07D — daneben die freien E-Mails desselben Kunden bzw. Vorgangs,
 * gemeinsam chronologisch (neueste zuerst) und klar benannt („Freie E-Mail"
 * bzw. Rechnung/Angebot/Geschäftsbrief). Jede Nachricht genau einmal.
 *
 * E-MAIL-07E — zusätzlich eingegangene E-Mails dieses Kunden bzw. Vorgangs
 * („Eingehende E-Mail"), eine weitere Listenanfrage — keine Anfrage je Mail.
 */
import { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { DetailSection } from '../ui/Section';
import { StatusBadge } from '../ui/Badge';
import { loadCommunicationHistory, type CommunicationHistoryResult } from '../../services/delivery/deliveryCommunicationHistory';
import type { DeliveryContext, DeliveryThread } from '../../services/delivery/deliveryCommunicationContext';
import { describeDeliverySource } from '../../services/delivery/deliveryCommunicationSource';
import { isSupabaseConfigured } from '../../lib/supabase';
import { resolveDeliveryWorkspaceId } from '../../services/delivery/sendDocumentOrchestrator';
import { rpcListEmailMessages, rpcListInboundEmailMessages, type EmailMessageListResult } from '../../services/email/emailMessageCloudService';
import type { EmailMessage } from '../../types/emailMessage';
import { inboundSenderLabel } from './InboxEmailList';
import { groupEmailThreads, type EmailThread } from '../../services/email/freeEmailOrchestrator';
import { emailDisplayLabelKey, emailDisplayTone } from './freeEmailUi';
import { deliveryDisplayLabelKey, deliveryDisplayTone, displayDeliveryStatus } from '../../services/delivery/providerDeliveryState';
import { formatDisplayDateTime } from '../../utils/displayFormat';

/** E-MAIL-07D — freie E-Mails zum Kontext; fehlt die Cloud-Migration noch, ist die Liste still leer. */
async function defaultLoadEmails(target: DeliveryContext): Promise<EmailMessageListResult> {
  if (!isSupabaseConfigured()) return { ok: true, messages: [] };
  const workspaceId = resolveDeliveryWorkspaceId();
  if (!workspaceId) return { ok: true, messages: [] };
  const result = await rpcListEmailMessages({ workspaceId, customerId: target.customerId, vorgangId: target.vorgangId });
  if (!result.ok && result.error === 'not_deployed') return { ok: true, messages: [] };
  return result;
}

/** E-MAIL-07E — eingegangene E-Mails zum Kontext; fehlt die Cloud-Migration noch, ist die Liste still leer. */
async function defaultLoadInbound(target: DeliveryContext): Promise<EmailMessageListResult> {
  if (!isSupabaseConfigured()) return { ok: true, messages: [] };
  const workspaceId = resolveDeliveryWorkspaceId();
  if (!workspaceId) return { ok: true, messages: [] };
  const result = await rpcListInboundEmailMessages({ workspaceId, customerId: target.customerId, vorgangId: target.vorgangId });
  if (!result.ok && result.error === 'not_deployed') return { ok: true, messages: [] };
  return result;
}

interface LoadedState {
  result: CommunicationHistoryResult;
  emails: EmailMessageListResult;
  inbound: EmailMessageListResult;
}

function rowsOf(state: LoadedState): HistoryRow[] {
  const outbound = state.emails.ok ? state.emails.messages.filter((message) => message.direction !== 'inbound') : [];
  const inbound = state.inbound.ok ? state.inbound.messages.filter((message) => message.direction === 'inbound') : [];
  return mergeRows(state.result.ok ? state.result.threads : [], groupEmailThreads(outbound), inbound);
}

type HistoryRow =
  | { kind: 'delivery'; key: string; at: string; thread: DeliveryThread }
  | { kind: 'email'; key: string; at: string; thread: EmailThread }
  | { kind: 'inbound'; key: string; at: string; message: EmailMessage };

function mergeRows(deliveries: DeliveryThread[], emails: EmailThread[], inbound: EmailMessage[]): HistoryRow[] {
  const seenInbound = new Set<string>();
  const rows: HistoryRow[] = [
    ...deliveries.map((thread) => ({ kind: 'delivery' as const, key: `d-${thread.id}`, at: thread.latest.providerAcceptedAt ?? thread.latest.requestedAt ?? '', thread })),
    ...emails.map((thread) => ({ kind: 'email' as const, key: `e-${thread.id}`, at: thread.latest.providerAcceptedAt ?? thread.latest.createdAt ?? '', thread })),
    ...inbound
      .filter((message) => (seenInbound.has(message.id) ? false : (seenInbound.add(message.id), true)))
      .map((message) => ({ kind: 'inbound' as const, key: `i-${message.id}`, at: message.receivedAt ?? message.createdAt ?? '', message })),
  ];
  // Zeitstempel können in verschiedenen ISO-Schreibweisen kommen — nach Zeitwert sortieren.
  return rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

// HALBZEIT-FIX B3 — Hausformat `26.09.2026, 20:13`, wie in der Versandhistorie.
const formatTimestamp = (value?: string): string => formatDisplayDateTime(value);


interface Props {
  target: DeliveryContext;
  testId: string;
  /** Nur zum Testen: Laden ersetzen. */
  load?: (target: DeliveryContext) => Promise<CommunicationHistoryResult>;
  /** Nur zum Testen: freie E-Mails ersetzen. */
  loadEmails?: (target: DeliveryContext) => Promise<EmailMessageListResult>;
  /** Nur zum Testen: eingegangene E-Mails ersetzen. */
  loadInbound?: (target: DeliveryContext) => Promise<EmailMessageListResult>;
}

export function CommunicationHistorySection({ target, testId, load = loadCommunicationHistory, loadEmails = defaultLoadEmails, loadInbound = defaultLoadInbound }: Props) {
  const { translate } = useApp();
  const [state, setState] = useState<{ phase: 'loading' } | ({ phase: 'done' } & LoadedState)>({ phase: 'loading' });
  const key = `${target.customerId ?? ''}|${target.vorgangId ?? ''}`;

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    void Promise.all([load(target), loadEmails(target), loadInbound(target)]).then(([result, emails, inbound]) => {
      if (!cancelled) setState({ phase: 'done', result, emails, inbound });
    });
    return () => {
      cancelled = true;
    };
    // Neu laden nur, wenn sich der Kontext ändert.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const t = (name: string) => translate(name as TranslationKey);
  const attemptsLine = (thread: DeliveryThread): string | undefined =>
    thread.attempts.length > 1
      ? thread.attempts
          .map((attempt) => t('delivery.communication.attempt').replace('{n}', String(attempt.attemptNumber)).replace('{status}', t(deliveryDisplayLabelKey(displayDeliveryStatus(attempt.status, attempt.deliveryState)))))
          .join(' · ')
      : undefined;

  const emailAttemptsLine = (thread: EmailThread): string | undefined =>
    thread.attempts.length > 1
      ? thread.attempts
          .map((attempt) => t('delivery.communication.attempt').replace('{n}', String(attempt.attemptNumber)).replace('{status}', t(emailDisplayLabelKey(attempt))))
          .join(' · ')
      : undefined;

  return (
    <DetailSection title={t('delivery.communication.title')} testId={testId}>
      {state.phase === 'loading' ? (
        <p className="detail-empty" data-testid={`${testId}-loading`}>{t('delivery.communication.loading')}</p>
      ) : !state.result.ok && !(state.emails.ok && state.emails.messages.length > 0) && !(state.inbound.ok && state.inbound.messages.length > 0) ? (
        <p className="detail-empty" data-testid={`${testId}-unavailable`}>
          {t(!state.result.ok && (state.result.error === 'not_configured' || state.result.error === 'workspace_missing') ? 'delivery.communication.cloudOnly' : 'delivery.communication.error')}
        </p>
      ) : rowsOf(state).length === 0 ? (
        <p className="detail-empty" data-testid={`${testId}-empty`}>{t('delivery.communication.empty')}</p>
      ) : (
        <>
          <BusinessList>
            {rowsOf(state).map((row) => {
              if (row.kind === 'inbound') {
                const message = row.message;
                return (
                  <BusinessListItem
                    key={row.key}
                    testId={`${testId}-inbound-thread`}
                    to={`/kommunikation/eingang/${message.id}`}
                    linkTestId={`${testId}-inbound-link`}
                    title={message.subject || t('inboundEmail.inbox.noSubject')}
                    subtitle={`${t('inboundEmail.inbox.from').replace('{sender}', inboundSenderLabel(message))} · ${t('inboundEmail.label')}`}
                    status={
                      <StatusBadge
                        tone={message.assignmentStatus === 'needs_review' ? 'warning' : 'info'}
                        label={t(`inboundEmail.status.${message.assignmentStatus ?? 'needs_review'}`)}
                        icon={false}
                      />
                    }
                    date={formatTimestamp(message.receivedAt)}
                  />
                );
              }
              if (row.kind === 'email') {
                const latest = row.thread.latest;
                const recipients = [...latest.to, ...latest.cc].join(', ');
                return (
                  <BusinessListItem
                    key={row.key}
                    testId={`${testId}-email-thread`}
                    to={`/kommunikation/email/${latest.id}`}
                    linkTestId={`${testId}-email-link`}
                    title={latest.subject}
                    subtitle={`${t('delivery.communication.sentTo').replace('{recipient}', recipients)} · ${t('freeEmail.label')}`}
                    meta={emailAttemptsLine(row.thread)}
                    status={<StatusBadge tone={emailDisplayTone(latest)} label={t(emailDisplayLabelKey(latest))} icon={false} />}
                    date={formatTimestamp(latest.providerAcceptedAt ?? latest.createdAt)}
                  />
                );
              }
              const thread = row.thread;
              const source = describeDeliverySource(thread.latest, translate);
              const latest = thread.latest;
              return (
                <BusinessListItem
                  key={thread.id}
                  testId={`${testId}-thread`}
                  to={source.to}
                  linkTestId={`${testId}-link`}
                  title={latest.subject}
                  subtitle={`${t('delivery.communication.sentTo').replace('{recipient}', latest.recipientEmail)} · ${source.label}`}
                  meta={attemptsLine(thread)}
                  status={<StatusBadge tone={deliveryDisplayTone(displayDeliveryStatus(latest.status, latest.deliveryState))} label={t(deliveryDisplayLabelKey(displayDeliveryStatus(latest.status, latest.deliveryState)))} icon={false} />}
                  date={formatTimestamp(latest.providerAcceptedAt ?? latest.requestedAt)}
                />
              );
            })}
          </BusinessList>
          {(state.result.ok && state.result.incomplete) || !state.result.ok || !state.emails.ok || !state.inbound.ok ? (
            <p className="form-hint" data-testid={`${testId}-incomplete`}>{t('delivery.communication.incomplete')}</p>
          ) : null}
        </>
      )}
    </DetailSection>
  );
}
