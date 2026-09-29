/**
 * E-MAIL-07D — Detail einer freien E-Mail (/kommunikation/email/:id).
 *
 * Zeigt, was tatsächlich gesendet wurde: An/Cc/Bcc, Betreff, Text samt
 * Signatur, Anhänge, Zuordnung und den Versandverlauf aller Versuche
 * (Neuversuche mit Bezug). Aktionen folgen der Serverwahrheit:
 * fehlgeschlagen → „Erneut senden" (exakt dieselbe E-Mail), unklar → nur nach
 * ausdrücklicher Bestätigung, läuft → „Status prüfen".
 *
 * E-MAIL 07F-01A — gehört die Nachricht zu einem Verlauf (z. B. Antwort auf
 * eine eingegangene Mail), steht der Gesprächsverlauf über den Einzelangaben.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/ui/Badge';
import { DetailSection } from '../components/ui/Section';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { useApp } from '../context/AppContext';
import { useOptionalAuth } from '../context/AuthContext';
import type { TranslationKey } from '../i18n';
import { isSupabaseConfigured } from '../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';
import { resolveDeliveryWorkspaceId } from '../services/delivery/sendDocumentOrchestrator';
import { deliveryErrorLabelKey } from '../services/delivery/documentDeliveryDefaults';
import { downloadEmailAttachment, rpcGetEmailMessageChain, rpcGetEmailThread, rpcListDeliveryEvents, type DeliveryEventsResult, type EmailAttachmentDownloadResult, type EmailMessageListResult } from '../services/email/emailMessageCloudService';
import { deliveryDisplayLabelKey, displayDeliveryStatus } from '../services/delivery/providerDeliveryState';
import { EmailConversation, buildConversation } from '../components/communication/EmailConversation';
import { checkFreeEmailStatus, retryFreeEmail } from '../services/email/freeEmailOrchestrator';
import type { EmailMessage, EmailMessageAttachment } from '../types/emailMessage';
import { describeEmailContext, emailDisplayHintKey, emailDisplayLabelKey, emailDisplayTone, formatBytes, formatTimestamp } from '../components/communication/freeEmailUi';

type LoadChain = (messageId: string) => Promise<EmailMessageListResult>;
type DownloadAttachment = (input: { storagePath: string; mimeType: string }) => Promise<EmailAttachmentDownloadResult>;

/** HALBZEIT-FIX B1 — Typen, die der Browser selbst anzeigen kann; alle anderen nur herunterladen. */
const VIEWABLE_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);

async function defaultLoadChain(messageId: string): Promise<EmailMessageListResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: 'not_configured' };
  const workspaceId = resolveDeliveryWorkspaceId();
  if (!workspaceId) return { ok: false, error: 'not_configured' };
  return rpcGetEmailMessageChain({ workspaceId, messageId });
}

/** 07F-01A — Verlauf; fehlt die Migration noch, bleibt es bei der Einzelansicht. */
async function defaultLoadThread(messageId: string): Promise<EmailMessageListResult> {
  if (!isSupabaseConfigured()) return { ok: true, messages: [] };
  const workspaceId = resolveDeliveryWorkspaceId();
  if (!workspaceId) return { ok: true, messages: [] };
  const result = await rpcGetEmailThread({ workspaceId, messageId });
  if (!result.ok && result.error === 'not_deployed') return { ok: true, messages: [] };
  return result;
}

/** 07F-01B — Zustellverlauf; fehlt die Migration noch, bleibt der Abschnitt weg. */
async function defaultLoadDeliveryEvents(messageId: string): Promise<DeliveryEventsResult> {
  if (!isSupabaseConfigured()) return { ok: true, events: [] };
  const workspaceId = resolveDeliveryWorkspaceId();
  if (!workspaceId) return { ok: true, events: [] };
  const result = await rpcListDeliveryEvents({ workspaceId, emailMessageId: messageId });
  if (!result.ok && result.error === 'not_deployed') return { ok: true, events: [] };
  return result;
}

export function KommunikationEmailDetailPage({
  loadChain = defaultLoadChain,
  downloadAttachment = downloadEmailAttachment,
  loadThread = defaultLoadThread,
  loadDeliveryEvents = defaultLoadDeliveryEvents,
}: {
  /** 07F-01B — Zustellverlauf laden (Tests ersetzen ihn). */
  loadDeliveryEvents?: (messageId: string) => Promise<DeliveryEventsResult>;
  loadChain?: LoadChain;
  /** 07F-01A — Gesprächsverlauf laden (Tests ersetzen ihn). */
  loadThread?: (messageId: string) => Promise<EmailMessageListResult>;
  /** Nur zum Testen: Laden des Anhangs ersetzen. */
  downloadAttachment?: DownloadAttachment;
}) {
  const { translate, showToast } = useApp();
  const t = (key: string) => translate(key as TranslationKey);
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const user = useOptionalAuth()?.user ?? null;
  const cloud = isSupabaseConfigured();
  const access = useMemo(() => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: cloud }), [user?.id, cloud]);
  const [chain, setChain] = useState<EmailMessage[] | null>(null);
  const [thread, setThread] = useState<EmailMessage[]>([]);
  const [deliveryEvents, setDeliveryEvents] = useState<{ messageId: string; events: Extract<DeliveryEventsResult, { ok: true }>['events'] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [confirmUncertain, setConfirmUncertain] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState<number | null>(null);
  const [attachmentError, setAttachmentError] = useState<{ position: number; text: string } | null>(null);

  const reload = useCallback(async () => {
    const result = await loadChain(id);
    if (!result.ok) {
      setLoadError(result.error === 'not_configured' ? 'freeEmail.sent.cloudOnly' : result.error === 'not_deployed' ? 'freeEmail.sent.notDeployed' : 'freeEmail.sent.error');
      return;
    }
    setLoadError(null);
    setChain(result.messages);
  }, [id, loadChain]);

  useEffect(() => {
    setChain(null);
    void reload();
  }, [reload]);

  // 07F-01B — Zustellverlauf des aktuellen Versuchs (Rückmeldungen des E-Mail-Dienstes).
  const latestId = chain && chain.length > 0 ? chain[chain.length - 1].id : null;
  useEffect(() => {
    let cancelled = false;
    setDeliveryEvents(null);
    if (!latestId) return undefined;
    void loadDeliveryEvents(latestId).then((result) => {
      if (!cancelled && result.ok) setDeliveryEvents({ messageId: latestId, events: result.events });
    });
    return () => {
      cancelled = true;
    };
  }, [latestId, loadDeliveryEvents]);

  // 07F-01A — Verlauf nachladen; Fehler lassen die Einzelansicht unverändert.
  useEffect(() => {
    let cancelled = false;
    setThread([]);
    void loadThread(id).then((result) => {
      if (!cancelled && result.ok) setThread(result.messages);
    });
    return () => {
      cancelled = true;
    };
  }, [id, loadThread]);

  if (loadError) {
    return (
      <div className="page" data-testid="kommunikation-email-detail">
        <PageHeader title={t('freeEmail.detail.title')} backHref="/kommunikation" backLabel={t('freeEmail.detail.back')} />
        <p className="detail-empty" data-testid="kommunikation-email-detail-unavailable">{t(loadError)}</p>
      </div>
    );
  }
  if (!chain) {
    return (
      <div className="page" data-testid="kommunikation-email-detail">
        <PageHeader title={t('freeEmail.detail.title')} backHref="/kommunikation" backLabel={t('freeEmail.detail.back')} />
        <p className="detail-empty" data-testid="kommunikation-email-detail-loading">{t('freeEmail.detail.loading')}</p>
      </div>
    );
  }
  const latest = chain[chain.length - 1];
  if (!latest) {
    return (
      <div className="page" data-testid="kommunikation-email-detail">
        <PageHeader title={t('freeEmail.detail.title')} backHref="/kommunikation" backLabel={t('freeEmail.detail.back')} />
        <p className="detail-empty" data-testid="kommunikation-email-detail-not-found">{t('freeEmail.detail.notFound')}</p>
      </div>
    );
  }

  const context = describeEmailContext(latest);
  const byId = new Map(chain.map((entry) => [entry.id, entry]));
  const canAct = cloud && access.canWrite;

  const handleResult = (result: Awaited<ReturnType<typeof retryFreeEmail>>) => {
    if (!result.ok) {
      setErrorKey(`freeEmail.error.${result.error}`);
      return;
    }
    setErrorKey(null);
    setChain(result.chain.length > 0 ? result.chain : chain);
    if (result.message.id !== id) navigate(`/kommunikation/email/${result.message.id}`, { replace: true });
  };

  const run = async (action: () => Promise<Awaited<ReturnType<typeof retryFreeEmail>>>) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await action();
      handleResult(result);
      if (result.ok) {
        showToast(
          t(result.action === 'failed' ? 'freeEmail.result.failed' : result.action === 'unknown_pending' ? 'freeEmail.result.unknown' : result.action === 'in_progress' ? 'freeEmail.result.in_progress' : 'freeEmail.result.sent'),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const recipientsRow = (label: string, list: string[], testId: string) =>
    list.length > 0 ? (
      <div>
        <dt>{label}</dt>
        <dd data-testid={testId}>{list.join(', ')}</dd>
      </div>
    ) : null;

  /*
   * HALBZEIT-FIX B1 — Anhang aus dem privaten Speicher laden (angemeldet,
   * nur Mitglieder). Die Datei wird als lokale, kurzlebige Blob-Adresse
   * geöffnet bzw. unter ihrem gespeicherten Namen heruntergeladen — es gibt
   * keinen öffentlichen Link.
   */
  const handleAttachment = async (attachment: EmailMessageAttachment, mode: 'open' | 'download') => {
    if (attachmentBusy !== null) return;
    setAttachmentError(null);
    setAttachmentBusy(attachment.position);
    // Fenster im Klick öffnen, sonst blockiert der Browser das spätere Öffnen.
    const pending = mode === 'open' ? window.open('', '_blank') : null;
    try {
      const result = await downloadAttachment({ storagePath: attachment.storagePath, mimeType: attachment.mimeType });
      if (!result.ok) {
        pending?.close();
        const key = result.error === 'missing' ? 'freeEmail.detail.attachmentMissing' : result.error === 'forbidden' ? 'freeEmail.detail.attachmentForbidden' : 'freeEmail.detail.attachmentFailed';
        setAttachmentError({ position: attachment.position, text: t(key).replace('{name}', attachment.filename) });
        return;
      }
      const url = URL.createObjectURL(result.blob);
      if (mode === 'open' && pending) {
        pending.location.href = url;
      } else {
        const link = document.createElement('a');
        link.href = url;
        if (mode === 'download') link.download = attachment.filename;
        else link.target = '_blank';
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setAttachmentBusy(null);
    }
  };

  const errorText = (message: EmailMessage) => {
    if (!message.errorCategory && !message.errorMessageSafe) return null;
    // Anhang-Fehler nennen die Datei (sicherer Servertext); sonst die Kategorie in Alltagssprache.
    if (message.errorCategory === 'attachment' && message.errorMessageSafe) return message.errorMessageSafe;
    return t(deliveryErrorLabelKey({ errorCategory: message.errorCategory, errorCode: message.errorCode }));
  };

  return (
    <div className="page kommunikation-email-detail" data-testid="kommunikation-email-detail">
      <PageHeader
        title={latest.subject}
        eyebrow={t('freeEmail.label')}
        backHref="/kommunikation"
        backLabel={t('freeEmail.detail.back')}
        backTestId="kommunikation-email-detail-back"
        status={<StatusBadge tone={emailDisplayTone(latest)} label={t(emailDisplayLabelKey(latest))} icon={false} data-testid="kommunikation-email-detail-status" />}
      />

      {buildConversation(thread).length > 1 ? (
        <DetailSection title={t('emailThread.title')} testId="kommunikation-email-detail-thread">
          <EmailConversation messages={thread} currentId={latest.id} testId="kommunikation-email-detail-conversation" />
        </DetailSection>
      ) : null}

      <DetailSection title={t('freeEmail.detail.title')} testId="kommunikation-email-detail-envelope">
        <dl className="settings-invoices__preview-list">
          <div>
            <dt>{t('freeEmail.detail.from')}</dt>
            <dd data-testid="kommunikation-email-detail-from">{latest.senderName}</dd>
          </div>
          <div>
            <dt>{t('freeEmail.detail.replyTo')}</dt>
            <dd data-testid="kommunikation-email-detail-reply-to">{latest.replyToEmail}</dd>
          </div>
          {recipientsRow(t('freeEmail.detail.to'), latest.to, 'kommunikation-email-detail-to')}
          {recipientsRow(t('freeEmail.detail.cc'), latest.cc, 'kommunikation-email-detail-cc')}
          {recipientsRow(t('freeEmail.detail.bcc'), latest.bcc, 'kommunikation-email-detail-bcc')}
          <div>
            <dt>{t('freeEmail.detail.subject')}</dt>
            <dd data-testid="kommunikation-email-detail-subject">{latest.subject}</dd>
          </div>
          <div>
            <dt>{t('freeEmail.detail.context')}</dt>
            <dd data-testid="kommunikation-email-detail-context">
              {!latest.customerId && !latest.vorgangId ? t('freeEmail.sent.noContext') : null}
              {latest.customerId ? (
                <>
                  {t('freeEmail.detail.customer')}:{' '}
                  <Link to={`/kunden/customer/${encodeURIComponent(latest.customerId)}`} data-testid="kommunikation-email-detail-customer">
                    {context.customer ?? t('freeEmail.detail.unknownContext')}
                  </Link>
                </>
              ) : null}
              {latest.customerId && latest.vorgangId ? ' · ' : null}
              {latest.vorgangId ? (
                <>
                  {t('freeEmail.detail.vorgang')}:{' '}
                  <Link to={`/vorgaenge/${encodeURIComponent(latest.vorgangId)}`} data-testid="kommunikation-email-detail-vorgang">
                    {context.vorgang ?? t('freeEmail.detail.unknownContext')}
                  </Link>
                </>
              ) : null}
            </dd>
          </div>
        </dl>
      </DetailSection>

      <DetailSection title={t('freeEmail.detail.body')} testId="kommunikation-email-detail-body-section">
        <pre className="free-email-body" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }} data-testid="kommunikation-email-detail-body">
          {latest.bodyText}
        </pre>
      </DetailSection>

      <DetailSection title={t('freeEmail.detail.attachments')} testId="kommunikation-email-detail-attachments">
        {latest.attachments.length === 0 ? (
          <p className="detail-empty">{t('freeEmail.detail.noAttachments')}</p>
        ) : (
          <ul>
            {latest.attachments.map((attachment) => (
              <li key={attachment.position} className="free-email-attachment" data-testid="kommunikation-email-detail-attachment-row">
                <span data-testid="kommunikation-email-detail-attachment">
                  {attachment.filename} · {formatBytes(attachment.sizeBytes)}
                </span>{' '}
                {VIEWABLE_MIME_TYPES.has(attachment.mimeType) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={attachmentBusy !== null}
                    onClick={() => void handleAttachment(attachment, 'open')}
                    data-testid="kommunikation-email-detail-attachment-open"
                  >
                    {t('freeEmail.detail.openAttachment')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={attachmentBusy !== null}
                  onClick={() => void handleAttachment(attachment, 'download')}
                  data-testid="kommunikation-email-detail-attachment-download"
                >
                  {t('freeEmail.detail.downloadAttachment')}
                </Button>
                {attachmentError?.position === attachment.position ? (
                  <p className="form-error" role="alert" data-testid="kommunikation-email-detail-attachment-error">{attachmentError.text}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title={t('freeEmail.detail.history')} testId="kommunikation-email-detail-history">
        <ol>
          {chain.map((attempt) => {
            const previous = attempt.retryOfMessageId ? byId.get(attempt.retryOfMessageId) : undefined;
            const error = errorText(attempt);
            return (
              <li key={attempt.id} data-testid="kommunikation-email-detail-attempt">
                <strong>{t('freeEmail.detail.attempt').replace('{n}', String(attempt.attemptNumber))}</strong>
                {': '}
                <span data-testid="kommunikation-email-detail-attempt-status">{t(emailDisplayLabelKey(attempt))}</span>
                {' · '}
                {t('freeEmail.detail.createdAt')} {formatTimestamp(attempt.createdAt)}
                {attempt.providerAcceptedAt ? ` · ${t('freeEmail.detail.acceptedAt')} ${formatTimestamp(attempt.providerAcceptedAt)}` : ''}
                {attempt.failedAt ? ` · ${t('freeEmail.detail.failedAt')} ${formatTimestamp(attempt.failedAt)}` : ''}
                {previous ? ` · ${t('freeEmail.detail.retryOf').replace('{n}', String(previous.attemptNumber))}` : ''}
                {error ? <p className="form-hint" data-testid="kommunikation-email-detail-attempt-error">{error}</p> : null}
                {attempt.status === 'unknown' ? <p className="form-hint">{t('delivery.status.unknownHint')}</p> : null}
                {attempt.status === 'sending' ? <p className="form-hint">{t('delivery.status.sendingHint')}</p> : null}
                {emailDisplayHintKey(attempt) ? <p className="form-hint" data-testid="kommunikation-email-detail-state-hint">{t(emailDisplayHintKey(attempt)!)}</p> : null}
              </li>
            );
          })}
        </ol>

        {deliveryEvents && deliveryEvents.messageId === latest.id && deliveryEvents.events.length > 0 ? (
          <div className="email-delivery-history" data-testid="kommunikation-email-detail-delivery-history">
            <p className="email-delivery-history__title">{t('delivery.state.history.title')}</p>
            <ol>
              {deliveryEvents.events.map((event, index) => (
                <li key={`${event.at}-${index}`} data-testid="kommunikation-email-detail-delivery-event">
                  {formatTimestamp(event.at)} · {t(deliveryDisplayLabelKey(displayDeliveryStatus('provider_accepted', event.state)))}
                </li>
              ))}
            </ol>
            <p className="form-hint">{t('delivery.state.history.hint')}</p>
          </div>
        ) : null}

        {errorKey ? <p className="form-error" role="alert" data-testid="kommunikation-email-detail-error">{t(errorKey)}</p> : null}

        {canAct ? (
          <div className="settings-form__actions">
            {latest.status === 'queued' || latest.status === 'sending' ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => checkFreeEmailStatus(latest))} data-testid="kommunikation-email-detail-check-status">
                {t('freeEmail.detail.checkStatus')}
              </Button>
            ) : null}
            {latest.status === 'failed' ? (
              <>
                <p className="form-hint">{t('freeEmail.detail.retryHint')}</p>
                <Button type="button" disabled={busy} onClick={() => void run(() => retryFreeEmail({ previous: latest }))} data-testid="kommunikation-email-detail-retry">
                  {t('freeEmail.detail.retry')}
                </Button>
              </>
            ) : null}
            {latest.status === 'unknown' ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmUncertain(true)}
                data-testid="kommunikation-email-detail-retry-uncertain"
              >
                {t('freeEmail.detail.retryUncertain')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </DetailSection>

      <SimpleConfirmDialog
        open={confirmUncertain}
        title={t('freeEmail.detail.retryUncertain')}
        message={t('freeEmail.detail.retryUncertainConfirm')}
        confirmLabel={t('freeEmail.detail.retryUncertain')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        dialogTestId="kommunikation-email-detail-retry-uncertain-dialog"
        confirmTestId="kommunikation-email-detail-retry-uncertain-confirm"
        cancelTestId="kommunikation-email-detail-retry-uncertain-cancel"
        onCancel={() => setConfirmUncertain(false)}
        onConfirm={() => {
          setConfirmUncertain(false);
          void run(() => retryFreeEmail({ previous: latest, confirmUncertainRetry: true }));
          return true;
        }}
      />
    </div>
  );
}
