/**
 * E-MAIL-07D — „E-Mails" auf /kommunikation: Einstieg „Neue E-Mail" und die
 * Gesendet-Liste. Eine Zeile je Nachricht; Neuversuche stehen in derselben
 * Zeile („2 Versuche"), der neueste Versuch bestimmt Status und Zeit.
 * Serverwahrheit, beim Zurückkehren in den Tab neu geladen.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { isSupabaseConfigured } from '../../lib/supabase';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { DetailSection, SectionHeader } from '../ui/Section';
import { StatusBadge } from '../ui/Badge';
import { rpcListEmailMessages, type EmailMessageListResult } from '../../services/email/emailMessageCloudService';
import { groupEmailThreads, type EmailThread } from '../../services/email/freeEmailOrchestrator';
import { resolveDeliveryWorkspaceId } from '../../services/delivery/sendDocumentOrchestrator';
import { describeEmailContext, emailDisplayLabelKey, emailDisplayTone, formatTimestamp } from './freeEmailUi';

type State = { phase: 'loading' } | { phase: 'done'; result: EmailMessageListResult | { ok: false; error: 'cloud_only' } };

async function defaultLoad(): Promise<EmailMessageListResult | { ok: false; error: 'cloud_only' }> {
  if (!isSupabaseConfigured()) return { ok: false, error: 'cloud_only' };
  const workspaceId = resolveDeliveryWorkspaceId();
  if (!workspaceId) return { ok: false, error: 'cloud_only' };
  return rpcListEmailMessages({ workspaceId });
}

interface Props {
  /** Nur zum Testen: Laden ersetzen. */
  load?: () => Promise<EmailMessageListResult | { ok: false; error: 'cloud_only' }>;
  /** E-MAIL-07E — innerhalb des E-Mail-Bereichs (Reiter „Gesendet") ohne eigenen Rahmen. */
  embedded?: boolean;
}

export function SentEmailList({ load = defaultLoad, embedded = false }: Props) {
  const { translate } = useApp();
  const t = (key: string) => translate(key as TranslationKey);
  const [state, setState] = useState<State>({ phase: 'loading' });

  const refresh = useCallback(() => {
    let cancelled = false;
    void load().then((result) => {
      if (!cancelled) setState({ phase: 'done', result });
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    const cancel = refresh();
    const onFocus = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      cancel();
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  const recipientsLine = (thread: EmailThread) => {
    const all = [...thread.latest.to, ...thread.latest.cc];
    const shown = all.slice(0, 2).join(', ');
    const rest = all.length - 2 + thread.latest.bcc.length;
    return t('freeEmail.sent.to').replace('{recipients}', rest > 0 ? `${shown} ${t('freeEmail.sent.moreRecipients').replace('{n}', String(rest))}` : shown);
  };

  const metaLine = (thread: EmailThread) => {
    const parts: string[] = [];
    const context = describeEmailContext(thread.latest);
    const contextParts = [context.customer, context.vorgang].filter(Boolean);
    parts.push(contextParts.length > 0 ? contextParts.join(' · ') : thread.latest.customerId || thread.latest.vorgangId ? t('freeEmail.detail.unknownContext') : t('freeEmail.sent.noContext'));
    const count = thread.latest.attachments.length;
    if (count === 1) parts.push(t('freeEmail.sent.attachmentOne'));
    if (count > 1) parts.push(t('freeEmail.sent.attachments').replace('{n}', String(count)));
    if (thread.attempts.length > 1) parts.push(t('freeEmail.sent.attempts').replace('{n}', String(thread.attempts.length)));
    return parts.join(' · ');
  };

  const unavailableKey = (result: Exclude<State, { phase: 'loading' }>['result']): string => {
    if (result.ok) return '';
    if (result.error === 'cloud_only' || result.error === 'not_configured') return 'freeEmail.sent.cloudOnly';
    if (result.error === 'not_deployed') return 'freeEmail.sent.notDeployed';
    return 'freeEmail.sent.error';
  };

  // E-MAIL-07E — „Gesendet" zeigt ausschließlich ausgehende Mail (auch falls ein älterer Server gemischt liefert).
  const outbound = state.phase === 'done' && state.result.ok ? state.result.messages.filter((message) => message.direction !== 'inbound') : [];
  const content = (
    <>
      {state.phase === 'loading' ? (
        <p className="detail-empty" data-testid="kommunikation-email-sent-loading">{t('freeEmail.sent.loading')}</p>
      ) : !state.result.ok ? (
        <p className="detail-empty" data-testid="kommunikation-email-sent-unavailable">{t(unavailableKey(state.result))}</p>
      ) : outbound.length === 0 ? (
        <p className="detail-empty" data-testid="kommunikation-email-sent-empty">{t('freeEmail.sent.empty')}</p>
      ) : (
        <BusinessList testId="kommunikation-email-sent">
          {groupEmailThreads(outbound).map((thread) => (
            <BusinessListItem
              key={thread.id}
              testId="kommunikation-email-sent-thread"
              to={`/kommunikation/email/${thread.latest.id}`}
              linkTestId="kommunikation-email-sent-link"
              title={thread.latest.subject}
              subtitle={recipientsLine(thread)}
              meta={metaLine(thread)}
              status={<StatusBadge tone={emailDisplayTone(thread.latest)} label={t(emailDisplayLabelKey(thread.latest))} icon={false} />}
              date={formatTimestamp(thread.latest.providerAcceptedAt ?? thread.latest.createdAt)}
            />
          ))}
        </BusinessList>
      )}
    </>
  );
  if (embedded) return content;

  return (
    <DetailSection
      title={t('freeEmail.section.title')}
      description={t('freeEmail.section.hint')}
      testId="kommunikation-email-section"
      action={
        <Link to="/kommunikation/email/neu" className="btn btn--primary btn--sm" data-testid="kommunikation-email-new">
          {t('freeEmail.action.new')}
        </Link>
      }
    >
      <SectionHeader title={t('freeEmail.sent.title')} level={3} />
      {content}
    </DetailSection>
  );
}
