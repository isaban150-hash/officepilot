import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { isSupabaseConfigured } from '../../lib/supabase';
import { resolveDeliveryWorkspaceId } from '../../services/delivery/sendDocumentOrchestrator';
import { rpcListInboundEmailMessages, type EmailMessageListResult } from '../../services/email/emailMessageCloudService';
import type { EmailMessage } from '../../types/emailMessage';
import { inboundSenderLabel } from '../communication/InboxEmailList';
import { formatTimestamp } from '../communication/freeEmailUi';
import { Icon } from '../ui/Icon';

/**
 * E-MAIL-07E — „Neue E-Mails" auf Heute.
 *
 * Die neuesten eingegangenen E-Mails (höchstens drei) mit Absender, Betreff
 * und Zeit; „Zu prüfen" als kleine Marke. „Alle ansehen" führt in den
 * Posteingang (/kommunikation). Nur Anzeige: Hier wird nie abgerufen, nie
 * gesendet und nichts zugeordnet. Ohne Cloud-Anbindung erscheint das Feld nicht.
 */
export const HOME_NEW_EMAILS_MAX = 3;

type LoadResult = EmailMessageListResult | { ok: false; error: 'cloud_only' };

async function defaultLoad(): Promise<LoadResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: 'cloud_only' };
  const workspaceId = resolveDeliveryWorkspaceId();
  if (!workspaceId) return { ok: false, error: 'cloud_only' };
  return rpcListInboundEmailMessages({ workspaceId, limit: HOME_NEW_EMAILS_MAX });
}

export function HomeNewEmails({ load = defaultLoad }: { load?: () => Promise<LoadResult> }) {
  const { translate } = useApp();
  const t = (key: string) => translate(key as TranslationKey);
  const [result, setResult] = useState<LoadResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Ohne Cloud (bzw. vor dem Laden) kein leeres Feld auf Heute.
  if (result === null || (!result.ok && result.error === 'cloud_only')) return null;

  const mails: EmailMessage[] = result.ok
    ? result.messages
        .filter((message) => message.direction === 'inbound')
        .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
        .slice(0, HOME_NEW_EMAILS_MAX)
    : [];

  return (
    <section className="heute-panel heute-panel--mail" data-testid="heute-section-new-emails">
      <div className="heute-panel__head">
        <h3>{t('inboundEmail.home.title')}</h3>
        <Link to="/kommunikation" data-testid="home-new-emails-all">
          {t('inboundEmail.home.all')}
        </Link>
      </div>
      {!result.ok ? (
        <p className="heute-panel__quiet" data-testid="home-new-emails-unavailable">
          {t(result.error === 'not_deployed' ? 'inboundEmail.inbox.notDeployed' : 'inboundEmail.home.error')}
        </p>
      ) : mails.length === 0 ? (
        <p className="heute-panel__quiet" data-testid="home-new-emails-empty">
          {t('inboundEmail.inbox.empty')}
        </p>
      ) : (
        <ul className="heute-doclist" data-testid="home-new-emails">
          {mails.map((message) => {
            const meta = [inboundSenderLabel(message), message.receivedAt ? formatTimestamp(message.receivedAt) : ''].filter(Boolean).join(' · ');
            return (
              <li key={message.id}>
                <Link to={`/kommunikation/eingang/${message.id}`} className="heute-doclist__row" data-testid="home-new-emails-item">
                  <span className="heute-doclist__ic" aria-hidden>
                    <Icon id="mail" size="sm" />
                  </span>
                  <span className="heute-doclist__body">
                    <b>{message.subject || t('inboundEmail.inbox.noSubject')}</b>
                    <span>{meta}</span>
                  </span>
                  {message.assignmentStatus === 'needs_review' ? (
                    <span className="heute-tag heute-tag--amber" data-testid="home-new-emails-review">
                      {t('inboundEmail.status.needs_review')}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
