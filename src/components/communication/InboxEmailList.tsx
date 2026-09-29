/**
 * E-MAIL-07E — Posteingang auf /kommunikation.
 *
 * Firmenpostfach-Status (ohne Cursor/Zugangsdaten), „Jetzt abrufen" für
 * Administratoren, Liste eingegangener Mails (neueste zuerst): Zeitpunkt,
 * Absender, Betreff, Kunde/Vorgang, Anhänge, „Zu prüfen". Nur Anzeige und
 * Abruf — nie ein Versand, nie eine Antwort.
 *
 * Nach jedem Abruf ist „Jetzt abrufen" 10 s gesperrt
 * (sichtbarer Countdown); der Server weist zu schnelle Folgeabrufe ebenfalls ab.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useOptionalAuth } from '../../context/AuthContext';
import type { TranslationKey } from '../../i18n';
import { isSupabaseConfigured } from '../../lib/supabase';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { SectionHeader } from '../ui/Section';
import { StatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import {
  invokeSyncMailbox,
  rpcListInboundEmailMessages,
  rpcListMailboxConnections,
  type EmailMessageListResult,
  type SyncMailboxResult,
} from '../../services/email/emailMessageCloudService';
import { resolveDeliveryWorkspaceId } from '../../services/delivery/sendDocumentOrchestrator';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import type { EmailMessage, MailboxConnection } from '../../types/emailMessage';
import { describeEmailContext, formatTimestamp } from './freeEmailUi';
import { mailboxConnectionErrorKey } from './mailboxErrorText';

/** „ ·" mit geschütztem Leerzeichen: bleibt am vorigen Abschnitt. */
const SEGMENT_SEPARATOR = ' ·';

/** Mindestabstand zwischen zwei manuellen Abrufen (spiegelt den Server). */
export const MANUAL_SYNC_COOLDOWN_SECONDS = 10;

type ListResult = EmailMessageListResult | { ok: false; error: 'cloud_only' };
type ConnectionsResult = { ok: true; connections: MailboxConnection[] } | { ok: false; error: string };

function workspace(): string | null {
  if (!isSupabaseConfigured()) return null;
  return resolveDeliveryWorkspaceId() || null;
}

async function defaultLoadInbox(needsReviewOnly: boolean): Promise<ListResult> {
  const workspaceId = workspace();
  if (!workspaceId) return { ok: false, error: 'cloud_only' };
  return rpcListInboundEmailMessages({ workspaceId, needsReviewOnly });
}

async function defaultLoadConnections(): Promise<ConnectionsResult> {
  const workspaceId = workspace();
  if (!workspaceId) return { ok: false, error: 'cloud_only' };
  return rpcListMailboxConnections({ workspaceId });
}

async function defaultSync(connectionId: string): Promise<SyncMailboxResult> {
  const workspaceId = workspace();
  if (!workspaceId) return { ok: false, error: 'not_configured' };
  return invokeSyncMailbox({ workspaceId, connectionId });
}

interface Props {
  loadInbox?: (needsReviewOnly: boolean) => Promise<ListResult>;
  loadConnections?: () => Promise<ConnectionsResult>;
  sync?: (connectionId: string) => Promise<SyncMailboxResult>;
}

/** Anzeigename ohne Zierrat (Leerraum, umschließende Anführungszeichen/Spitzklammern), klein geschrieben. */
function normalizeSenderPart(value: string): string {
  return value.trim().replace(/^["'<\s]+|["'>\s]+$/g, '').trim().toLowerCase();
}

/**
 * Absender für Heute, Posteingang, Historie und Detail (eine zentrale Stelle).
 * Anzeigename nur, wenn er echt ist: leer oder (normalisiert) gleich der
 * Adresse → nur die Adresse („a@b.de" statt „a@b.de <a@b.de>").
 * Gespeicherte Daten bleiben unverändert.
 */
/**
 * E-MAIL 07F-01A — Posteingang je Gesprächsverlauf: die neueste eingegangene
 * Nachricht steht für ihren Verlauf (keine aufgeblähte Liste); die Anzahl
 * eingegangener Nachrichten des Verlaufs steht dabei. Ohne Thread-Kennung
 * (Migration noch nicht aktiv) bleibt jede Nachricht ein eigener Eintrag.
 */
export function groupInboxByThread(messages: EmailMessage[]): { message: EmailMessage; count: number }[] {
  const groups = new Map<string, EmailMessage[]>();
  for (const message of messages) {
    if (message.direction !== 'inbound') continue;
    const key = message.threadId ?? `message:${message.id}`;
    const list = groups.get(key) ?? [];
    if (!list.some((entry) => entry.id === message.id)) list.push(message);
    groups.set(key, list);
  }
  return [...groups.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
      return { message: sorted[0], count: sorted.length };
    })
    .sort((a, b) => (b.message.receivedAt ?? '').localeCompare(a.message.receivedAt ?? ''));
}

export function inboundSenderLabel(message: Pick<EmailMessage, 'fromName' | 'fromAddress'>): string {
  const address = message.fromAddress?.trim() || '';
  const name = message.fromName?.trim() || '';
  if (address && name && normalizeSenderPart(name) !== normalizeSenderPart(address)) return `${name} <${address}>`;
  return address || name || '—';
}

export function InboxEmailList({ loadInbox = defaultLoadInbox, loadConnections = defaultLoadConnections, sync = defaultSync }: Props) {
  const { translate } = useApp();
  const t = (key: string) => translate(key as TranslationKey);
  const user = useOptionalAuth()?.user ?? null;
  const cloud = isSupabaseConfigured();
  const canWrite = resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: cloud }).canWrite;
  const [reviewOnly, setReviewOnly] = useState(false);
  const [inbox, setInbox] = useState<ListResult | null>(null);
  const [connections, setConnections] = useState<ConnectionsResult | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  // Synchrone Sperre: verhindert einen zweiten Abruf auch bei zwei Klicks im selben Moment (State ist dann noch nicht aktualisiert).
  const syncInFlight = useRef(false);
  const cooldownUntilRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  // Countdown nur, solange eine Sperre läuft.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  const refresh = useCallback(() => {
    let cancelled = false;
    void loadInbox(reviewOnly).then((result) => {
      if (!cancelled) setInbox(result);
    });
    void loadConnections().then((result) => {
      if (!cancelled) setConnections(result);
    });
    return () => {
      cancelled = true;
    };
  }, [loadInbox, loadConnections, reviewOnly]);

  useEffect(() => {
    setInbox(null);
    const cancel = refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancel();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const handleSync = async (connectionId: string) => {
    if (syncInFlight.current || syncing || cooldownUntilRef.current > Date.now()) return;
    syncInFlight.current = true;
    setSyncing(connectionId);
    setSyncNotice(null);
    try {
      const result = await sync(connectionId);
      if (result.ok) {
        if (result.action === 'cooldown') {
          setSyncNotice({ tone: 'info', text: t('inboundEmail.sync.cooldown') });
          cooldownUntilRef.current = Date.now() + Math.max(1, result.retryAfterSeconds) * 1000;
          setCooldownUntil(cooldownUntilRef.current);
          setNow(Date.now());
          return;
        }
        if (result.action === 'synced') {
          const text = t('inboundEmail.sync.synced').replace('{n}', String(result.imported));
          setSyncNotice({ tone: 'info', text: result.more ? `${text} ${t('inboundEmail.sync.more')}` : text });
        } else {
          setSyncNotice({ tone: result.action === 'busy' ? 'info' : 'error', text: t(`inboundEmail.sync.${result.action}`) });
        }
      } else {
        const key = result.error === 'provider_error' ? `inboundEmail.sync.error.${result.category ?? 'unknown'}` : `inboundEmail.sync.error.${result.error}`;
        setSyncNotice({ tone: 'error', text: t(key) });
      }
      refresh();
    } finally {
      setSyncing(null);
      syncInFlight.current = false;
      // Nach jedem Abruf kurze Sperre gegen schnelle Folgeklicks (Server-Sperre gilt zusätzlich).
      cooldownUntilRef.current = Math.max(cooldownUntilRef.current, Date.now() + MANUAL_SYNC_COOLDOWN_SECONDS * 1000);
      setCooldownUntil(cooldownUntilRef.current);
      setNow(Date.now());
    }
  };

  const unavailableKey = (result: ListResult) => {
    if (result.ok) return '';
    if (result.error === 'cloud_only' || result.error === 'not_configured') return 'inboundEmail.inbox.cloudOnly';
    if (result.error === 'not_deployed') return 'inboundEmail.inbox.notDeployed';
    return 'inboundEmail.inbox.error';
  };

  const contextLine = (message: EmailMessage, threadCount = 1) => {
    const context = describeEmailContext(message);
    const parts = [context.customer, context.vorgang].filter(Boolean) as string[];
    if (parts.length === 0 && (message.customerId || message.vorgangId)) parts.push(t('inboundEmail.assign.unknownContext'));
    if (parts.length === 0) parts.push(t('inboundEmail.inbox.unassigned'));
    const count = message.attachments.length;
    if (count === 1) parts.push(t('freeEmail.sent.attachmentOne'));
    if (count > 1) parts.push(t('freeEmail.sent.attachments').replace('{n}', String(count)));
    if (threadCount > 1) parts.push(t('emailThread.inboxCount').replace('{n}', String(threadCount)));
    return parts.join(' · ');
  };

  const connectionList = connections?.ok ? connections.connections : [];

  return (
    <div className="inbox-email-list" data-testid="kommunikation-inbox">
      {/* Firmenpostfach */}
      <div className="inbox-email-list__mailbox" data-testid="kommunikation-mailbox">
        <SectionHeader title={t('inboundEmail.mailbox.title')} level={3} />
        {connections === null ? null : connectionList.length === 0 ? (
          <p className="form-hint" data-testid="kommunikation-mailbox-none">{t('inboundEmail.mailbox.none')}</p>
        ) : (
          <ul className="inbox-email-list__connections">
            {connectionList.map((connection) => (
              <li key={connection.id} data-testid="kommunikation-mailbox-connection">
                {/* Trennpunkt gehört ans Ende des vorigen Abschnitts (geschütztes Leerzeichen, kein Umbruch davor):
                    ein Umbruch entsteht nur NACH „·", nie mit „·" am Zeilenanfang. */}
                <span className="inbox-email-list__segment" data-testid="kommunikation-mailbox-address">
                  <strong>{connection.displayName || connection.mailboxAddress}</strong>
                  {connection.displayName ? ` <${connection.mailboxAddress}>` : ''}
                  {SEGMENT_SEPARATOR}
                </span>
                <span className="inbox-email-list__segment">
                  <span data-testid="kommunikation-mailbox-status">{t(`inboundEmail.mailbox.status.${connection.status}`)}</span>
                  {SEGMENT_SEPARATOR}
                </span>
                <span className="inbox-email-list__segment" data-testid="kommunikation-mailbox-last-sync">
                  {connection.lastSuccessfulSyncAt
                    ? t('inboundEmail.mailbox.lastSync').replace('{date}', formatTimestamp(connection.lastSuccessfulSyncAt))
                    : t('inboundEmail.mailbox.neverSynced')}
                </span>
                {connection.status === 'error' && connection.errorCategory ? (
                  <p className="form-hint" data-testid="kommunikation-mailbox-error">{t(mailboxConnectionErrorKey(connection))}</p>
                ) : null}
                {canWrite && connection.status !== 'disconnected' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={syncing === connection.id}
                    disabled={syncing !== null || cooldownLeft > 0}
                    onClick={() => void handleSync(connection.id)}
                    data-testid="kommunikation-mailbox-sync"
                  >
                    {syncing === connection.id ? t('inboundEmail.mailbox.syncing') : t('inboundEmail.mailbox.syncNow')}
                  </Button>
                ) : null}
                {canWrite && connection.status !== 'disconnected' && syncing === null && cooldownLeft > 0 ? (
                  <span className="form-hint" data-testid="kommunikation-mailbox-cooldown">
                    {t('inboundEmail.mailbox.cooldownHint').replace('{s}', String(cooldownLeft))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {syncNotice ? (
          <p className={syncNotice.tone === 'error' ? 'form-error' : 'form-hint'} role="status" data-testid="kommunikation-mailbox-notice">{syncNotice.text}</p>
        ) : null}
      </div>

      {/* Posteingang */}
      <label className="inbox-email-list__filter">
        <input type="checkbox" checked={reviewOnly} onChange={(event) => setReviewOnly(event.target.checked)} data-testid="kommunikation-inbox-filter-review" />{' '}
        {t('inboundEmail.inbox.filterReview')}
      </label>
      {inbox === null ? (
        <p className="detail-empty" data-testid="kommunikation-inbox-loading">{t('inboundEmail.inbox.loading')}</p>
      ) : !inbox.ok ? (
        <p className="detail-empty" data-testid="kommunikation-inbox-unavailable">{t(unavailableKey(inbox))}</p>
      ) : inbox.messages.filter((message) => message.direction === 'inbound').length === 0 ? (
        <p className="detail-empty" data-testid="kommunikation-inbox-empty">{t(reviewOnly ? 'inboundEmail.inbox.emptyReview' : 'inboundEmail.inbox.empty')}</p>
      ) : (
        <BusinessList testId="kommunikation-inbox-list">
          {groupInboxByThread(inbox.messages)
            .map(({ message, count }) => (
              <BusinessListItem
                key={message.id}
                testId="kommunikation-inbox-item"
                to={`/kommunikation/eingang/${message.id}`}
                linkTestId="kommunikation-inbox-link"
                title={message.subject || t('inboundEmail.inbox.noSubject')}
                subtitle={t('inboundEmail.inbox.from').replace('{sender}', inboundSenderLabel(message))}
                meta={contextLine(message, count)}
                status={
                  <StatusBadge
                    tone={message.assignmentStatus === 'needs_review' ? 'warning' : 'success'}
                    label={t(`inboundEmail.status.${message.assignmentStatus ?? 'needs_review'}`)}
                    icon={false}
                  />
                }
                date={formatTimestamp(message.receivedAt)}
              />
            ))}
        </BusinessList>
      )}
    </div>
  );
}
