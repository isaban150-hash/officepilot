/**
 * E-MAIL-07E — Detail einer eingegangenen E-Mail (/kommunikation/eingang/:id).
 *
 * Von/An/Cc/Datum/Betreff, die Nachricht ausschließlich als Text (HTML wird
 * serverseitig sicher in Text umgewandelt und hier nie als HTML gesetzt),
 * Anhänge über den angemeldeten Zugriff auf den privaten Bucket (Öffnen /
 * Herunterladen, kein öffentlicher Link), nicht übernommene Anhänge mit Grund
 * und die Zuordnung zu Kunde/Vorgang. Die manuelle Zuordnung prüft der Server
 * (Workspace, Kunde passt zum Vorgang) und protokolliert sie; eine manuell
 * bestätigte Zuordnung überschreibt kein späterer Import.
 *
 * E-MAIL 07F-01A — „Antworten" (genau eine Hauptaktion) öffnet den bestehenden
 * 07D-Editor im Antwortmodus; gesendet wird dort nur nach ausdrücklicher
 * Bestätigung. Gehört die Mail zu einem Verlauf mit weiteren Nachrichten,
 * steht der Gesprächsverlauf über den Einzelangaben (eine Anfrage).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/ui/Badge';
import { DetailSection } from '../components/ui/Section';
import { useApp } from '../context/AppContext';
import { useOptionalAuth } from '../context/AuthContext';
import type { TranslationKey } from '../i18n';
import { isSupabaseConfigured } from '../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';
import { resolveDeliveryWorkspaceId } from '../services/delivery/sendDocumentOrchestrator';
import { getCustomerStoreSnapshot } from '../services/customerStoreService';
import { getAllVorgaenge } from '../services/vorgangService';
import { isEntitySyncActive } from '../services/sync/syncMetaService';
import { buildCustomerOptionLabels } from '../services/customer/customerOptionLabels';
import {
  downloadEmailAttachment,
  rpcAssignInboundEmailMessage,
  rpcGetEmailThread,
  rpcGetInboundEmailMessage,
  type AssignInboundError,
  type EmailMessageListResult,
  type EmailAttachmentDownloadResult,
  type InboundMessageResult,
} from '../services/email/emailMessageCloudService';
import type { EmailMessage, EmailMessageAttachment } from '../types/emailMessage';
import { describeEmailContext, formatBytes, formatTimestamp } from '../components/communication/freeEmailUi';
import { inboundSenderLabel } from '../components/communication/InboxEmailList';
import { EmailConversation, buildConversation } from '../components/communication/EmailConversation';

const VIEWABLE_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);

type LoadMessage = (messageId: string) => Promise<InboundMessageResult>;
type AssignMessage = (input: { messageId: string; customerId?: string; vorgangId?: string; expectedRowVersion: number }) => Promise<{ ok: true; message: EmailMessage } | { ok: false; error: AssignInboundError }>;
type DownloadAttachment = (input: { storagePath: string; mimeType: string; storageBucket: EmailMessageAttachment['storageBucket'] }) => Promise<EmailAttachmentDownloadResult>;
type LoadThread = (messageId: string) => Promise<EmailMessageListResult>;

function workspace(): string | null {
  if (!isSupabaseConfigured()) return null;
  return resolveDeliveryWorkspaceId() || null;
}

async function defaultLoad(messageId: string): Promise<InboundMessageResult> {
  const workspaceId = workspace();
  if (!workspaceId) return { ok: false, error: 'not_configured' };
  return rpcGetInboundEmailMessage({ workspaceId, messageId });
}

/** 07F-01A — Verlauf; fehlt die Migration noch, bleibt es bei der Einzelansicht. */
async function defaultLoadThread(messageId: string): Promise<EmailMessageListResult> {
  const workspaceId = workspace();
  if (!workspaceId) return { ok: true, messages: [] };
  const result = await rpcGetEmailThread({ workspaceId, messageId });
  if (!result.ok && result.error === 'not_deployed') return { ok: true, messages: [] };
  return result;
}

async function defaultAssign(input: Parameters<AssignMessage>[0]) {
  const workspaceId = workspace();
  if (!workspaceId) return { ok: false as const, error: 'not_configured' as const };
  return rpcAssignInboundEmailMessage({ workspaceId, ...input });
}

export function KommunikationInboundEmailPage({
  loadMessage = defaultLoad,
  assign = defaultAssign,
  downloadAttachment = downloadEmailAttachment,
  loadThread = defaultLoadThread,
}: {
  loadMessage?: LoadMessage;
  assign?: AssignMessage;
  downloadAttachment?: DownloadAttachment;
  /** 07F-01A — Gesprächsverlauf laden (Tests ersetzen ihn). */
  loadThread?: LoadThread;
}) {
  const { translate, showToast } = useApp();
  const t = (key: string) => translate(key as TranslationKey);
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [thread, setThread] = useState<EmailMessage[]>([]);
  const user = useOptionalAuth()?.user ?? null;
  const cloud = isSupabaseConfigured();
  const canWrite = useMemo(() => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: cloud }).canWrite, [user?.id, cloud]);
  const [message, setMessage] = useState<EmailMessage | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [vorgangId, setVorgangId] = useState('');
  const [saving, setSaving] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [attachmentBusy, setAttachmentBusy] = useState<number | null>(null);
  const [attachmentError, setAttachmentError] = useState<{ position: number; text: string } | null>(null);

  const customers = useMemo(
    () => getCustomerStoreSnapshot().filter((customer) => isEntitySyncActive(customer)).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'de')),
    [],
  );
  const customerLabels = useMemo(
    () => buildCustomerOptionLabels(customers, { created: translate('customer.option.created'), id: translate('customer.option.id') }),
    [customers, translate],
  );
  const vorgaenge = useMemo(() => getAllVorgaenge().sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', 'de')), []);

  const applyMessage = useCallback((next: EmailMessage | null) => {
    setMessage(next);
    if (next) {
      setCustomerId(next.customerId ?? '');
      // Ein Vorschlag wird nur vorbelegt — gespeichert wird erst nach Bestätigung.
      setVorgangId(next.vorgangId ?? (next.assignmentStatus === 'needs_review' ? next.suggestedVorgangId ?? '' : ''));
      if (!next.customerId && next.assignmentStatus === 'needs_review' && next.suggestedVorgangId) {
        const suggested = vorgaenge.find((vorgang) => vorgang.id === next.suggestedVorgangId);
        if (suggested?.customerId) setCustomerId(suggested.customerId);
      }
    }
  }, [vorgaenge]);

  useEffect(() => {
    let cancelled = false;
    setMessage(undefined);
    void loadMessage(id).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(result.error === 'not_configured' ? 'inboundEmail.inbox.cloudOnly' : result.error === 'not_deployed' ? 'inboundEmail.inbox.notDeployed' : 'inboundEmail.inbox.error');
        return;
      }
      setLoadError(null);
      applyMessage(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, [id, loadMessage, applyMessage]);

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

  const header = (title: string) => (
    <PageHeader title={title} eyebrow={t('inboundEmail.label')} backHref="/kommunikation" backLabel={t('inboundEmail.detail.back')} backTestId="kommunikation-inbound-back" />
  );

  if (loadError) {
    return (
      <div className="page" data-testid="kommunikation-inbound-detail">
        {header(t('inboundEmail.detail.title'))}
        <p className="detail-empty" data-testid="kommunikation-inbound-unavailable">{t(loadError)}</p>
      </div>
    );
  }
  if (message === undefined) {
    return (
      <div className="page" data-testid="kommunikation-inbound-detail">
        {header(t('inboundEmail.detail.title'))}
        <p className="detail-empty" data-testid="kommunikation-inbound-loading">{t('inboundEmail.detail.loading')}</p>
      </div>
    );
  }
  if (message === null) {
    return (
      <div className="page" data-testid="kommunikation-inbound-detail">
        {header(t('inboundEmail.detail.title'))}
        <p className="detail-empty" data-testid="kommunikation-inbound-not-found">{t('inboundEmail.detail.notFound')}</p>
      </div>
    );
  }

  const context = describeEmailContext(message);
  const selectedVorgang = vorgangId ? vorgaenge.find((vorgang) => vorgang.id === vorgangId) : undefined;
  const customerFromVorgang = Boolean(selectedVorgang?.customerId);
  const vorgangOptions = customerId && !customerFromVorgang
    ? vorgaenge.filter((vorgang) => !vorgang.customerId || vorgang.customerId === customerId)
    : vorgaenge;
  const suggested = message.assignmentStatus === 'needs_review' && message.suggestedVorgangId ? vorgaenge.find((vorgang) => vorgang.id === message.suggestedVorgangId) : undefined;
  const changed = (customerId || '') !== (message.customerId ?? '') || (vorgangId || '') !== (message.vorgangId ?? '');

  const chooseCustomer = (value: string) => {
    setCustomerId(value);
    // Kunde entfernt oder gewechselt: ein Vorgang eines anderen Kunden bleibt nicht widersprüchlich stehen.
    if (selectedVorgang?.customerId && selectedVorgang.customerId !== value) setVorgangId('');
  };
  const chooseVorgang = (value: string) => {
    setVorgangId(value);
    const vorgang = value ? vorgaenge.find((entry) => entry.id === value) : undefined;
    if (vorgang?.customerId) setCustomerId(vorgang.customerId);
  };

  const save = async () => {
    if (saving || !canWrite) return;
    setSaving(true);
    setAssignError(null);
    try {
      const result = await assign({ messageId: message.id, customerId: customerId || undefined, vorgangId: vorgangId || undefined, expectedRowVersion: message.rowVersion });
      if (!result.ok) {
        const key = result.error === 'context_conflict' || result.error === 'context_invalid' || result.error === 'stale' || result.error === 'forbidden'
          ? `inboundEmail.assign.error.${result.error}`
          : 'inboundEmail.assign.error.generic';
        setAssignError(t(key));
        return;
      }
      applyMessage(result.message);
      showToast(t('inboundEmail.assign.saved'));
    } finally {
      setSaving(false);
    }
  };

  const handleAttachment = async (attachment: EmailMessageAttachment, mode: 'open' | 'download') => {
    if (attachmentBusy !== null) return;
    setAttachmentError(null);
    setAttachmentBusy(attachment.position);
    const pending = mode === 'open' ? window.open('', '_blank') : null;
    try {
      const result = await downloadAttachment({ storagePath: attachment.storagePath, mimeType: attachment.mimeType, storageBucket: attachment.storageBucket });
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

  const row = (label: string, value: string, testId: string) => (
    <div>
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );

  return (
    <div className="page kommunikation-inbound-detail" data-testid="kommunikation-inbound-detail">
      <PageHeader
        title={message.subject || t('inboundEmail.inbox.noSubject')}
        eyebrow={t('inboundEmail.label')}
        backHref="/kommunikation"
        backLabel={t('inboundEmail.detail.back')}
        backTestId="kommunikation-inbound-back"
        status={
          <StatusBadge
            tone={message.assignmentStatus === 'needs_review' ? 'warning' : 'success'}
            label={t(`inboundEmail.status.${message.assignmentStatus ?? 'needs_review'}`)}
            icon={false}
            data-testid="kommunikation-inbound-status"
          />
        }
        primaryAction={
          cloud && canWrite ? (
            <Button type="button" onClick={() => navigate(`/kommunikation/email/neu?antwortAuf=${encodeURIComponent(message.id)}`)} data-testid="kommunikation-inbound-reply">
              {t('emailThread.reply')}
            </Button>
          ) : undefined
        }
      />

      {buildConversation(thread).length > 1 ? (
        <DetailSection title={t('emailThread.title')} testId="kommunikation-inbound-thread">
          <EmailConversation messages={thread} currentId={message.id} testId="kommunikation-inbound-conversation" />
        </DetailSection>
      ) : null}

      <DetailSection title={t('inboundEmail.detail.title')} testId="kommunikation-inbound-envelope">
        <dl className="settings-invoices__preview-list">
          {row(t('inboundEmail.detail.from'), inboundSenderLabel(message), 'kommunikation-inbound-from')}
          {row(t('inboundEmail.detail.to'), message.to.join(', ') || '—', 'kommunikation-inbound-to')}
          {message.cc.length > 0 ? row(t('inboundEmail.detail.cc'), message.cc.join(', '), 'kommunikation-inbound-cc') : null}
          {row(t('inboundEmail.detail.date'), formatTimestamp(message.receivedAt), 'kommunikation-inbound-date')}
          {row(t('inboundEmail.detail.subject'), message.subject || t('inboundEmail.inbox.noSubject'), 'kommunikation-inbound-subject')}
        </dl>
      </DetailSection>

      <DetailSection title={t('inboundEmail.detail.body')} testId="kommunikation-inbound-body-section">
        {/* Nur Text: React setzt den Inhalt als Textknoten, nie als HTML. */}
        <pre className="free-email-body" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }} data-testid="kommunikation-inbound-body">
          {message.bodyText || t('inboundEmail.detail.emptyBody')}
        </pre>
        {message.hasHtml ? <p className="form-hint" data-testid="kommunikation-inbound-html-hint">{t('inboundEmail.detail.htmlHint')}</p> : null}
      </DetailSection>

      <DetailSection title={t('inboundEmail.detail.attachments')} testId="kommunikation-inbound-attachments">
        {message.attachments.length === 0 ? (
          <p className="detail-empty">{t('inboundEmail.detail.noAttachments')}</p>
        ) : (
          <ul>
            {message.attachments.map((attachment) => (
              <li key={attachment.position} data-testid="kommunikation-inbound-attachment-row">
                <span data-testid="kommunikation-inbound-attachment">
                  {attachment.filename} · {formatBytes(attachment.sizeBytes)}
                </span>{' '}
                {VIEWABLE_MIME_TYPES.has(attachment.mimeType) ? (
                  <Button type="button" variant="ghost" size="sm" disabled={attachmentBusy !== null} onClick={() => void handleAttachment(attachment, 'open')} data-testid="kommunikation-inbound-attachment-open">
                    {t('freeEmail.detail.openAttachment')}
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" size="sm" disabled={attachmentBusy !== null} onClick={() => void handleAttachment(attachment, 'download')} data-testid="kommunikation-inbound-attachment-download">
                  {t('freeEmail.detail.downloadAttachment')}
                </Button>
                {attachmentError?.position === attachment.position ? (
                  <p className="form-error" role="alert" data-testid="kommunikation-inbound-attachment-error">{attachmentError.text}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {message.skippedAttachments.length > 0 ? (
          <>
            <p className="form-hint">{t('inboundEmail.detail.skipped')}</p>
            <ul data-testid="kommunikation-inbound-skipped">
              {message.skippedAttachments.map((skipped, index) => (
                <li key={`${skipped.filename}-${index}`} data-testid="kommunikation-inbound-skipped-item">
                  {skipped.filename} · {t(`inboundEmail.detail.skip.${skipped.reason}`)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </DetailSection>

      <DetailSection title={t('inboundEmail.assign.title')} testId="kommunikation-inbound-assignment">
        <p data-testid="kommunikation-inbound-assignment-current">
          {message.customerId ? (
            <>
              {t('inboundEmail.assign.customer')}:{' '}
              <Link to={`/kunden/customer/${encodeURIComponent(message.customerId)}`}>{context.customer ?? t('inboundEmail.assign.unknownContext')}</Link>
            </>
          ) : (
            t('inboundEmail.inbox.unassigned')
          )}
          {message.vorgangId ? (
            <>
              {' · '}
              {t('inboundEmail.assign.vorgang')}:{' '}
              <Link to={`/vorgaenge/${encodeURIComponent(message.vorgangId)}`}>{context.vorgang ?? t('inboundEmail.assign.unknownContext')}</Link>
            </>
          ) : null}
        </p>
        {message.assignmentSource ? (
          <p className="form-hint" data-testid="kommunikation-inbound-assignment-source">{t(`inboundEmail.assign.source.${message.assignmentSource}`)}</p>
        ) : null}
        {message.assignmentStatus === 'needs_review' ? (
          <p className="form-hint" data-testid="kommunikation-inbound-review-hint">{t('inboundEmail.assign.reviewHint')}</p>
        ) : null}
        {suggested ? (
          <p className="form-hint" data-testid="kommunikation-inbound-suggestion">{t('inboundEmail.assign.suggestion').replace('{vorgang}', suggested.title || suggested.id)}</p>
        ) : null}
        {message.assignedAt ? (
          <p className="form-hint" data-testid="kommunikation-inbound-assigned-at">{t('inboundEmail.assign.changedAt').replace('{date}', formatTimestamp(message.assignedAt))}</p>
        ) : null}

        <fieldset className="form-group settings-form__section" disabled={!canWrite || saving}>
          <div className="settings-form__field">
            <label htmlFor="inbound-customer">{t('inboundEmail.assign.customer')}</label>
            <select id="inbound-customer" className="input" value={customerId} disabled={customerFromVorgang} onChange={(event) => chooseCustomer(event.target.value)} data-testid="kommunikation-inbound-customer">
              <option value="">{t('inboundEmail.assign.customerNone')}</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>{customerLabels.get(customer.id) ?? customer.name}</option>
              ))}
            </select>
            {customerFromVorgang ? <p className="form-hint">{t('inboundEmail.assign.customerFromVorgang')}</p> : null}
          </div>
          <div className="settings-form__field">
            <label htmlFor="inbound-vorgang">{t('inboundEmail.assign.vorgang')}</label>
            <select id="inbound-vorgang" className="input" value={vorgangId} onChange={(event) => chooseVorgang(event.target.value)} data-testid="kommunikation-inbound-vorgang">
              <option value="">{t('inboundEmail.assign.vorgangNone')}</option>
              {vorgangOptions.map((vorgang) => (
                <option key={vorgang.id} value={vorgang.id}>{vorgang.title || vorgang.id}</option>
              ))}
            </select>
          </div>
        </fieldset>
        {assignError ? <p className="form-error" role="alert" data-testid="kommunikation-inbound-assign-error">{assignError}</p> : null}
        {canWrite ? (
          <Button type="button" onClick={() => void save()} loading={saving} disabled={saving || !changed} data-testid="kommunikation-inbound-assign-save">
            {t('inboundEmail.assign.save')}
          </Button>
        ) : null}
      </DetailSection>
    </div>
  );
}
