/**
 * E-MAIL-07D — „Neue E-Mail" (/kommunikation/email/neu).
 *
 * Freie Geschäfts-E-Mail: An/Cc/Bcc, Betreff, Text mit der zentralen Signatur
 * (genau einmal eingefügt, nie erneut), mehrere Anhänge, optional Kunde und
 * Vorgang. Der Entwurf überlebt einen Reload (feste client_message_id); ein
 * unterbrochener Versand wird fortgesetzt, nie doppelt gesendet.
 *
 * Kunde → E-Mail wird nur vorgeschlagen, nie still eingetragen.
 * Vorgang → bestimmt den Kunden; ein widersprüchlicher Kunde ist nicht wählbar.
 *
 * E-MAIL 07F-01A — Antwortmodus (`?antwortAuf=<Nachricht>`): derselbe Editor,
 * vorbelegt aus dem Original — An (Reply-To vor Von; nie eigene, ungültige
 * oder No-Reply-Adressen, sonst wählt der Benutzer), Cc nur aus dem Cc des
 * Originals (nie Bcc), „Re: <Betreff>" ohne Präfixketten, Kunde/Vorgang per
 * Kennung aus dem Original (nie geraten), Signatur und ein kompaktes
 * Textzitat. Gesendet wird erst nach ausdrücklicher Bestätigung im Dialog —
 * über dieselbe Kette wie jede freie E-Mail (send-email). Nichts sendet
 * automatisch.
 *
 * E-MAIL 07F-01C — „Antwortentwurf vorbereiten" (nur im Antwortmodus, nur auf
 * ausdrücklichen Klick): OfficeTakt setzt einen geprüften KI-Vorschlag VOR
 * Signatur und Zitat in den editierbaren Text. Empfänger, Betreff, Kunde/
 * Vorgang und Verlauf bleiben unberührt. Höchstens drei Generierungen je
 * Entwurf; eigener Text wird nur nach Bestätigung ersetzt; offene
 * Platzhalter („[Termin ergänzen]") sperren den Versand. Kein Auto-Send.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { buildCustomerOptionLabels } from '../services/customer/customerOptionLabels';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { resolveDeliveryWorkspaceId } from '../services/delivery/sendDocumentOrchestrator';
import { buildQuotedReply, normalizeReplySubject, resolveReplyRecipients, type ReplyRecipientProblem } from '../../supabase/functions/_shared/emailThreadRules';
import { inboundSenderLabel } from '../components/communication/InboxEmailList';
import type { EmailMessage } from '../types/emailMessage';
import { isAlreadyAnswered } from '../services/email/emailReplyAiContext';
import {
  composeReplyBody,
  prepareEmailReplyDraft,
  replyPlaceholdersIn,
  replyWouldOverwriteManualText,
  type EmailReplyDraftResult,
} from '../services/email/emailReplyAiService';

/** 07F-01C — höchstens so viele KI-Generierungen je Antwort-Entwurf. */
export const REPLY_AI_MAX_GENERATIONS = 3;
export type PrepareReplyDraft = (input: { parent: EmailMessage; thread: EmailMessage[] }) => Promise<EmailReplyDraftResult>;
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { useApp } from '../context/AppContext';
import { useOptionalAuth } from '../context/AuthContext';
import type { TranslationKey } from '../i18n';
import { isSupabaseConfigured } from '../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';
import { getCustomerStoreSnapshot } from '../services/customerStoreService';
import { getAllVorgaenge } from '../services/vorgangService';
import { isEntitySyncActive } from '../services/sync/syncMetaService';
import { appendSignatureOnce, resolveEmailSignature } from '../services/delivery/deliveryMailComposer';
import { resolveProfileReplyToEmail } from '../services/company/companyProfileSettingsContract';
import {
  EMAIL_ATTACHMENT_MAX_COUNT,
  EMAIL_ATTACHMENT_MAX_FILE_BYTES,
  EMAIL_ATTACHMENT_MAX_TOTAL_BYTES,
  EMAIL_BODY_MAX,
  EMAIL_MAX_RECIPIENTS,
  EMAIL_MAX_TO,
  EMAIL_SUBJECT_MAX,
  checkAttachmentAddition,
  normalizeEmailAddress,
  sanitizeAttachmentFilename,
  splitRecipientInput,
} from '../../supabase/functions/_shared/emailMessageRules';
import { rpcGetEmailThread, rpcGetInboundEmailMessage, rpcListMailboxConnections, uploadEmailAttachment } from '../services/email/emailMessageCloudService';
import {
  clearFreeEmailDraft,
  createFreeEmailDraft,
  loadFreeEmailDraft,
  saveFreeEmailDraft,
  sendFreeEmail,
  validateFreeEmailDraft,
  type FreeEmailDraft,
  type FreeEmailValidationError,
} from '../services/email/freeEmailOrchestrator';
import { formatBytes, formatTimestamp } from '../components/communication/freeEmailUi';

interface PendingUpload {
  localId: string;
  name: string;
  size: number;
}

interface AttachmentNotice {
  id: string;
  key: string;
  name: string;
  limit?: string;
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.txt,.csv,.docx,.xlsx';

/** E-MAIL 07F-01A — Antwortkontext: Original und ob der Empfänger sicher bestimmt ist. */
export interface ReplyContext {
  parent: EmailMessage;
  problem: ReplyRecipientProblem | null;
  /** 07F-01C — Verlauf der Originalmail (für den Antwortentwurf und „bereits beantwortet"). */
  thread: EmailMessage[];
}

export type LoadReplySource = (parentId: string) => Promise<{ ok: true; parent: EmailMessage | null; ownAddresses: string[]; thread?: EmailMessage[] } | { ok: false }>;

/** Original über den Verlauf laden (eine Anfrage) + eigene Postfachadressen (nie als Antwortziel). */
async function defaultLoadReplySource(parentId: string): ReturnType<LoadReplySource> {
  if (!isSupabaseConfigured()) return { ok: false };
  const workspaceId = resolveDeliveryWorkspaceId();
  if (!workspaceId) return { ok: false };
  const [thread, connections] = await Promise.all([
    rpcGetEmailThread({ workspaceId, messageId: parentId }),
    rpcListMailboxConnections({ workspaceId }),
  ]);
  const ownAddresses = connections.ok ? connections.connections.map((connection) => connection.mailboxAddress) : [];
  if (!thread.ok) {
    // Verlaufs-Migration noch nicht aktiv: Original über den 07E-Weg laden (Senden prüft der Server).
    if (thread.error !== 'not_deployed') return { ok: false };
    const single = await rpcGetInboundEmailMessage({ workspaceId, messageId: parentId });
    return single.ok ? { ok: true, parent: single.message, ownAddresses, thread: single.message ? [single.message] : [] } : { ok: false };
  }
  return { ok: true, parent: thread.messages.find((message) => message.id === parentId) ?? null, ownAddresses, thread: thread.messages };
}

export function KommunikationEmailComposePage({
  loadReplySource = defaultLoadReplySource,
  prepareReplyDraft = prepareEmailReplyDraft,
}: { loadReplySource?: LoadReplySource; prepareReplyDraft?: PrepareReplyDraft } = {}) {
  const [searchParams] = useSearchParams();
  const replyToId = searchParams.get('antwortAuf')?.trim() || '';
  if (!replyToId) return <EmailComposeForm />;
  return <ReplyCompose key={replyToId} parentId={replyToId} loadSource={loadReplySource} prepareReplyDraft={prepareReplyDraft} />;
}

function ReplyCompose({ parentId, loadSource, prepareReplyDraft }: { parentId: string; loadSource: LoadReplySource; prepareReplyDraft: PrepareReplyDraft }) {
  const { translate, language, companyProfile } = useApp();
  const t = (key: string) => translate(key as TranslationKey);
  const [state, setState] = useState<{ phase: 'loading' | 'missing' | 'error' } | { phase: 'ready'; draft: FreeEmailDraft; reply: ReplyContext }>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void loadSource(parentId).then((result) => {
      if (cancelled) return;
      if (!result.ok) return setState({ phase: 'error' });
      const parent = result.parent;
      if (!parent) return setState({ phase: 'missing' });
      const own = [...result.ownAddresses, companyProfile?.email ?? '', resolveProfileReplyToEmail(companyProfile) ?? ''].filter(Boolean);
      const recipients = resolveReplyRecipients({ fromAddress: parent.fromAddress, replyToAddresses: parent.replyToAddresses, cc: parent.cc }, own);
      const thread = result.thread ?? [parent];
      const existing = loadFreeEmailDraft(undefined, parent.id);
      if (existing) return setState({ phase: 'ready', draft: existing, reply: { parent, problem: recipients.problem, thread } });
      // Kontext nur per Kennung aus dem Original — und nur, wenn er hier bekannt ist (sonst nichts erfinden).
      const customerId = parent.customerId && getCustomerStoreSnapshot().some((customer) => customer.id === parent.customerId) ? parent.customerId : undefined;
      const vorgangId = parent.vorgangId && getAllVorgaenge().some((vorgang) => vorgang.id === parent.vorgangId) ? parent.vorgangId : undefined;
      const signature = resolveEmailSignature(companyProfile, language);
      const quote = buildQuotedReply(
        { bodyText: parent.bodyText, senderLabel: parent.direction === 'inbound' ? inboundSenderLabel(parent) : parent.senderName, dateLabel: formatTimestamp(parent.receivedAt ?? parent.providerAcceptedAt ?? parent.createdAt) },
        { wrote: t('emailThread.wrote') },
      );
      // Deterministischer Schluss (Signatur + Zitat); ein KI-Entwurf wird davor eingesetzt (07F-01C).
      const tail = `${signature ? `${appendSignatureOnce('', signature)}\n\n` : ''}${quote}`;
      const draft = createFreeEmailDraft({
        to: recipients.to.join(', '),
        cc: recipients.cc.join(', '),
        subject: normalizeReplySubject(parent.subject),
        bodyText: `\n\n${tail}`,
        signatureApplied: Boolean(signature),
        customerId,
        vorgangId,
        replyToMessageId: parent.id,
        replyTail: tail,
      });
      setState({ phase: 'ready', draft, reply: { parent, problem: recipients.problem, thread } });
    });
    return () => {
      cancelled = true;
    };
    // Nur einmal je Original laden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId]);

  if (state.phase === 'ready') return <EmailComposeForm initialDraft={state.draft} reply={state.reply} prepareReplyDraft={prepareReplyDraft} />;
  return (
    <div className="page kommunikation-email-compose" data-testid="kommunikation-email-compose">
      <PageHeader title={t('emailThread.replyTitle')} backHref={`/kommunikation/eingang/${encodeURIComponent(parentId)}`} backLabel={t('emailThread.backToMessage')} backTestId="kommunikation-email-compose-back" />
      <p className="detail-empty" data-testid={`kommunikation-reply-${state.phase}`}>
        {t(state.phase === 'loading' ? 'emailThread.replyLoading' : state.phase === 'missing' ? 'emailThread.replyMissing' : 'emailThread.replyError')}
      </p>
    </div>
  );
}

function EmailComposeForm({ initialDraft, reply, prepareReplyDraft = prepareEmailReplyDraft }: { initialDraft?: FreeEmailDraft; reply?: ReplyContext; prepareReplyDraft?: PrepareReplyDraft } = {}) {
  const { translate, language, companyProfile, showToast } = useApp();
  const t = (key: string) => translate(key as TranslationKey);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const user = useOptionalAuth()?.user ?? null;
  const cloud = isSupabaseConfigured();
  const access = useMemo(() => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: cloud }), [user?.id, cloud]);
  const canSend = cloud && access.canWrite;

  const customers = useMemo(
    () => getCustomerStoreSnapshot().filter((customer) => isEntitySyncActive(customer)).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'de')),
    [],
  );
  const vorgaenge = useMemo(() => getAllVorgaenge().sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', 'de')), []);
  // E-MAIL-HALBZEIT-FIX B5 — gleichnamige Kunden unterscheidbar (nur Anzeige).
  const customerLabels = useMemo(
    () => buildCustomerOptionLabels(customers, { created: translate('customer.option.created'), id: translate('customer.option.id') }),
    [customers, translate],
  );

  const [draft, setDraftState] = useState<FreeEmailDraft>(() => {
    if (initialDraft) return initialDraft;
    const existing = loadFreeEmailDraft();
    if (existing) return existing;
    const signature = resolveEmailSignature(companyProfile, language);
    const vorgangId = searchParams.get('vorgangId') ?? undefined;
    const vorgang = vorgangId ? vorgaenge.find((entry) => entry.id === vorgangId) : undefined;
    const customerId = vorgang?.customerId ?? searchParams.get('customerId') ?? undefined;
    return createFreeEmailDraft({
      bodyText: signature ? `\n\n${appendSignatureOnce('', signature)}` : '',
      signatureApplied: Boolean(signature),
      customerId: customers.some((customer) => customer.id === customerId) ? customerId : undefined,
      vorgangId: vorgang?.id,
    });
  });
  const [showCcBcc, setShowCcBcc] = useState(() => Boolean(draft.cc || draft.bcc));
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [notices, setNotices] = useState<AttachmentNotice[]>([]);
  const [validation, setValidation] = useState<{ errors: FreeEmailValidationError[]; invalid: string[] } | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 07F-01A: Antworten erst nach ausdrücklicher Bestätigung senden.
  const [confirmSend, setConfirmSend] = useState(false);
  // 07F-01C — KI-Antwortentwurf (nur Antwortmodus).
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErrorKey, setAiErrorKey] = useState<string | null>(null);
  const [aiConfirmOverwrite, setAiConfirmOverwrite] = useState(false);
  const aiInFlight = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const locked = draft.phase !== 'editing';
  const setDraft = (patch: Partial<FreeEmailDraft>) => {
    const next = saveFreeEmailDraft({ ...draftRef.current, ...patch });
    draftRef.current = next;
    setDraftState(next);
  };

  // Ein anderer Tab hat den Entwurf geändert oder den Versand abgeschlossen.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!event.key || !event.key.startsWith('officepilot.freeEmailDraft.v1')) return;
      const latest = loadFreeEmailDraft(undefined, draftRef.current.replyToMessageId);
      if (latest && latest.clientMessageId === draftRef.current.clientMessageId) {
        draftRef.current = latest;
        setDraftState(latest);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const selectedVorgang = draft.vorgangId ? vorgaenge.find((entry) => entry.id === draft.vorgangId) : undefined;
  const customerFromVorgang = Boolean(selectedVorgang?.customerId);
  const selectedCustomer = draft.customerId ? customers.find((entry) => entry.id === draft.customerId) : undefined;
  const vorgangOptions = draft.customerId && !customerFromVorgang
    ? vorgaenge.filter((entry) => !entry.customerId || entry.customerId === draft.customerId)
    : vorgaenge;

  const allRecipients = useMemo(
    () => new Set([...splitRecipientInput(draft.to), ...splitRecipientInput(draft.cc), ...splitRecipientInput(draft.bcc)].map(normalizeEmailAddress)),
    [draft.to, draft.cc, draft.bcc],
  );
  const customerEmail = (selectedCustomer?.email ?? '').trim();
  const suggestEmail = customerEmail && !allRecipients.has(normalizeEmailAddress(customerEmail)) ? customerEmail : '';

  const handleCustomer = (value: string) => {
    const customerId = value || undefined;
    const vorgang = draft.vorgangId ? vorgaenge.find((entry) => entry.id === draft.vorgangId) : undefined;
    // Ein Vorgang eines anderen Kunden passt nicht mehr: Zuordnung zum Vorgang wird gelöst.
    const keepVorgang = vorgang && (!vorgang.customerId || vorgang.customerId === customerId);
    setDraft({ customerId, vorgangId: keepVorgang ? draft.vorgangId : undefined });
  };

  const handleVorgang = (value: string) => {
    const vorgang = value ? vorgaenge.find((entry) => entry.id === value) : undefined;
    const derivedCustomer = vorgang?.customerId && customers.some((customer) => customer.id === vorgang.customerId) ? vorgang.customerId : undefined;
    setDraft({ vorgangId: vorgang?.id, customerId: derivedCustomer ?? (vorgang?.customerId ? undefined : draft.customerId) });
  };

  const addSuggestedEmail = () => {
    const current = draft.to.trim();
    setDraft({ to: current ? `${current.replace(/[,;]\s*$/, '')}, ${customerEmail}` : customerEmail });
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    const planned: { sizeBytes: number }[] = [...draftRef.current.attachments, ...pending.map((entry) => ({ sizeBytes: entry.size }))];
    const accepted: { file: File; localId: string; filename: string }[] = [];
    const newNotices: AttachmentNotice[] = [];
    for (const file of files) {
      const problem = checkAttachmentAddition(file, planned);
      if (problem) {
        const limit =
          problem === 'file_too_large' ? formatBytes(EMAIL_ATTACHMENT_MAX_FILE_BYTES)
          : problem === 'total_too_large' ? formatBytes(EMAIL_ATTACHMENT_MAX_TOTAL_BYTES)
          : problem === 'too_many' ? String(EMAIL_ATTACHMENT_MAX_COUNT)
          : undefined;
        newNotices.push({ id: `${file.name}-${Math.random()}`, key: `freeEmail.attachmentError.${problem}`, name: file.name, limit });
        continue;
      }
      planned.push({ sizeBytes: file.size });
      accepted.push({ file, localId: `${Date.now()}-${Math.random()}`, filename: sanitizeAttachmentFilename(file.name)! });
    }
    setNotices((current) => [...current, ...newNotices]);
    if (accepted.length === 0) return;
    setPending((current) => [...current, ...accepted.map((entry) => ({ localId: entry.localId, name: entry.filename, size: entry.file.size }))]);

    await Promise.all(
      accepted.map(async (entry) => {
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await entry.file.arrayBuffer());
        } catch {
          setNotices((current) => [...current, { id: entry.localId, key: 'freeEmail.attachmentError.read_failed', name: entry.filename }]);
          setPending((current) => current.filter((item) => item.localId !== entry.localId));
          return;
        }
        const uploaded = await uploadEmailAttachment({ workspaceId: draftRef.current.workspaceId, filename: entry.filename, bytes });
        setPending((current) => current.filter((item) => item.localId !== entry.localId));
        if (!uploaded.ok) {
          const key = uploaded.error === 'type_not_allowed' ? 'freeEmail.attachmentError.type_not_allowed'
            : uploaded.error === 'too_large' ? 'freeEmail.attachmentError.file_too_large'
            : 'freeEmail.attachmentError.upload_failed';
          setNotices((current) => [...current, { id: entry.localId, key, name: entry.filename, limit: formatBytes(EMAIL_ATTACHMENT_MAX_FILE_BYTES) }]);
          return;
        }
        const existing = draftRef.current.attachments;
        // Dieselbe Datei unter demselben Namen nur einmal.
        if (existing.some((item) => item.sha256 === uploaded.attachment.sha256 && item.filename === uploaded.attachment.filename)) return;
        setDraft({ attachments: [...existing, uploaded.attachment] });
      }),
    );
  };

  const removeAttachment = (index: number) => {
    setDraft({ attachments: draft.attachments.filter((_, position) => position !== index) });
  };

  const noticeText = (notice: AttachmentNotice) =>
    t(notice.key).replace('{name}', notice.name).replace('{limit}', notice.limit ?? '');

  const validationText = (error: FreeEmailValidationError): string => {
    const text = t(`freeEmail.validation.${error}`);
    if (error === 'recipient_invalid') return text.replace('{list}', validation?.invalid.join(', ') ?? '');
    if (error === 'too_many_to') return text.replace('{limit}', String(EMAIL_MAX_TO));
    if (error === 'too_many_recipients') return text.replace('{limit}', String(EMAIL_MAX_RECIPIENTS));
    return text;
  };

  const uploading = pending.length > 0;

  // 07F-01C — offene KI-Platzhalter im eigenen Antworttext (nicht im Zitat).
  const placeholders = reply ? replyPlaceholdersIn(draft.bodyText, draft.replyTail) : [];
  const aiGenerations = draft.aiGenerations ?? 0;
  const aiLimitReached = aiGenerations >= REPLY_AI_MAX_GENERATIONS;
  const alreadyAnswered = reply ? isAlreadyAnswered(reply.parent, reply.thread) : false;

  const runReplyAi = async (confirmedOverwrite = false) => {
    if (!reply || aiInFlight.current || busy || locked) return;
    const current = draftRef.current;
    if ((current.aiGenerations ?? 0) >= REPLY_AI_MAX_GENERATIONS) return;
    if (!confirmedOverwrite && replyWouldOverwriteManualText(current.bodyText, current.replyTail, current.aiInsertedText)) {
      setAiConfirmOverwrite(true);
      return;
    }
    aiInFlight.current = true;
    setAiBusy(true);
    setAiErrorKey(null);
    try {
      const result = await prepareReplyDraft({ parent: reply.parent, thread: reply.thread });
      const latest = draftRef.current;
      if (result.ok) {
        setDraft({
          bodyText: composeReplyBody(latest.bodyText, result.body, latest.replyTail, latest.aiInsertedText),
          aiInsertedText: result.body,
          aiGenerations: (latest.aiGenerations ?? 0) + 1,
        });
        return;
      }
      // Ungeeignete Mail: kein KI-Aufruf erfolgt — zählt nicht. Alles andere zählt als Versuch.
      if (!result.error.startsWith('unsuitable_')) setDraft({ aiGenerations: (latest.aiGenerations ?? 0) + 1 });
      setAiErrorKey(`emailThread.ai.error.${result.error}`);
    } finally {
      aiInFlight.current = false;
      setAiBusy(false);
    }
  };

  const handleSend = async (confirmed = false) => {
    if (busy || uploading || !canSend || aiBusy) return;
    setErrorKey(null);
    const current = draftRef.current;
    const checked = validateFreeEmailDraft(current);
    if (!checked.ok) {
      setValidation({ errors: checked.errors, invalid: checked.invalidRecipients });
      return;
    }
    setValidation(null);
    // 07F-01C: offene Platzhalter zuerst ersetzen oder entfernen.
    if (reply && replyPlaceholdersIn(current.bodyText, current.replyTail).length > 0) {
      setErrorKey('emailThread.ai.placeholdersBlock');
      return;
    }
    // Antwort: erst prüfen lassen, dann ausdrücklich bestätigen (unterbrochener Versand setzt ohne Dialog fort).
    if (reply && !confirmed && current.phase === 'editing') {
      setConfirmSend(true);
      return;
    }
    setBusy(true);
    try {
      const result = await sendFreeEmail(current, {
        onPhase: () => {
          const latest = loadFreeEmailDraft(undefined, draftRef.current.replyToMessageId);
          if (latest) {
            draftRef.current = latest;
            setDraftState(latest);
          }
        },
      });
      if (result.ok) {
        const toastKey = result.action === 'failed' ? 'freeEmail.result.failed'
          : result.action === 'unknown_pending' ? 'freeEmail.result.unknown'
          : result.action === 'in_progress' ? 'freeEmail.result.in_progress'
          : 'freeEmail.result.sent';
        showToast(t(toastKey));
        navigate(`/kommunikation/email/${result.message.id}`);
        return;
      }
      const latest = loadFreeEmailDraft(undefined, draftRef.current.replyToMessageId);
      if (latest) {
        draftRef.current = latest;
        setDraftState(latest);
      }
      setErrorKey(`freeEmail.error.${result.error}`);
    } finally {
      setBusy(false);
    }
  };

  const backHref = reply ? `/kommunikation/eingang/${encodeURIComponent(reply.parent.id)}` : '/kommunikation';
  const handleDiscard = () => {
    clearFreeEmailDraft(draft.scopeKey, draft.replyToMessageId);
    navigate(backHref);
  };

  const totalSize = draft.attachments.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const replyTo = resolveProfileReplyToEmail(companyProfile);

  return (
    <div className="page kommunikation-email-compose" data-testid="kommunikation-email-compose">
      <PageHeader
        title={t(reply ? 'emailThread.replyTitle' : 'freeEmail.compose.title')}
        backHref={backHref}
        backLabel={t(reply ? 'emailThread.backToMessage' : 'freeEmail.compose.back')}
        backTestId="kommunikation-email-compose-back"
      />

      {reply ? (
        <div className="email-reply-original" data-testid="kommunikation-reply-original">
          <p className="email-reply-original__label">{t('emailThread.replyingTo')}</p>
          <p className="email-reply-original__subject" data-testid="kommunikation-reply-original-subject">{reply.parent.subject || t('inboundEmail.inbox.noSubject')}</p>
          <p className="form-hint" data-testid="kommunikation-reply-original-meta">
            {(reply.parent.direction === 'inbound' ? inboundSenderLabel(reply.parent) : reply.parent.senderName)}
            {' · '}
            {formatTimestamp(reply.parent.receivedAt ?? reply.parent.providerAcceptedAt ?? reply.parent.createdAt)}
          </p>
          {reply.problem && !draft.to.trim() ? (
            <p className="form-error" role="alert" data-testid="kommunikation-reply-recipient-problem">{t(`emailThread.recipientProblem.${reply.problem}`)}</p>
          ) : null}
        </div>
      ) : null}

      {!cloud ? (
        <p className="hint-text" data-testid="kommunikation-email-compose-cloud-required">{t('freeEmail.compose.cloudRequired')}</p>
      ) : !access.canWrite ? (
        <p className="hint-text" data-testid="kommunikation-email-compose-read-only">{t('freeEmail.compose.readOnly')}</p>
      ) : null}

      {locked ? (
        <div className="hint-text" data-testid="kommunikation-email-compose-resume-hint">
          <p>{t('freeEmail.compose.resumeHint')}</p>
        </div>
      ) : null}

      <form
        className="settings-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void handleSend();
        }}
      >
        <fieldset className="form-group settings-form__section" disabled={locked || busy || aiBusy || !canSend}>
          <div className="settings-form__field">
            <label htmlFor="free-email-to">{t('freeEmail.compose.to')}</label>
            <input
              id="free-email-to"
              type="text"
              inputMode="email"
              autoComplete="off"
              className={`input${validation?.errors.includes('to_missing') ? ' input--error' : ''}`}
              value={draft.to}
              onChange={(event) => setDraft({ to: event.target.value })}
              data-testid="free-email-to"
            />
            <p className="form-hint">{t('freeEmail.compose.recipientsHint')}</p>
            {suggestEmail ? (
              <Button type="button" variant="ghost" size="sm" onClick={addSuggestedEmail} data-testid="free-email-suggest-customer-email">
                {t('freeEmail.compose.suggestEmail').replace('{email}', suggestEmail)}
              </Button>
            ) : null}
          </div>
          {showCcBcc ? (
            <>
              <div className="settings-form__field">
                <label htmlFor="free-email-cc">{t('freeEmail.compose.cc')}</label>
                <input id="free-email-cc" type="text" inputMode="email" autoComplete="off" className="input" value={draft.cc} onChange={(event) => setDraft({ cc: event.target.value })} data-testid="free-email-cc" />
              </div>
              <div className="settings-form__field">
                <label htmlFor="free-email-bcc">{t('freeEmail.compose.bcc')}</label>
                <input id="free-email-bcc" type="text" inputMode="email" autoComplete="off" className="input" value={draft.bcc} onChange={(event) => setDraft({ bcc: event.target.value })} data-testid="free-email-bcc" />
              </div>
            </>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowCcBcc(true)} data-testid="free-email-show-cc-bcc">
              {t('freeEmail.compose.showCcBcc')}
            </Button>
          )}

          <div className="settings-form__field">
            <label htmlFor="free-email-customer">{t('freeEmail.compose.customer')}</label>
            <select
              id="free-email-customer"
              className="input"
              value={draft.customerId ?? ''}
              disabled={customerFromVorgang}
              onChange={(event) => handleCustomer(event.target.value)}
              data-testid="free-email-customer"
            >
              <option value="">{t('freeEmail.compose.customerNone')}</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>{customerLabels.get(customer.id) ?? (customer.name || customer.id)}</option>
              ))}
            </select>
            {customerFromVorgang ? <p className="form-hint" data-testid="free-email-customer-from-vorgang">{t('freeEmail.compose.customerFromVorgang')}</p> : null}
          </div>
          <div className="settings-form__field">
            <label htmlFor="free-email-vorgang">{t('freeEmail.compose.vorgang')}</label>
            <select
              id="free-email-vorgang"
              className="input"
              value={draft.vorgangId ?? ''}
              onChange={(event) => handleVorgang(event.target.value)}
              data-testid="free-email-vorgang"
            >
              <option value="">{t('freeEmail.compose.vorgangNone')}</option>
              {vorgangOptions.map((vorgang) => (
                <option key={vorgang.id} value={vorgang.id}>{vorgang.title || vorgang.id}</option>
              ))}
            </select>
          </div>

          <div className="settings-form__field">
            <label htmlFor="free-email-subject">{t('freeEmail.compose.subject')}</label>
            <input
              id="free-email-subject"
              type="text"
              className={`input${validation?.errors.includes('subject_missing') ? ' input--error' : ''}`}
              value={draft.subject}
              maxLength={EMAIL_SUBJECT_MAX}
              onChange={(event) => setDraft({ subject: event.target.value })}
              data-testid="free-email-subject"
            />
          </div>
          {reply ? (
            <div className="email-reply-ai" data-testid="kommunikation-reply-ai">
              <div className="email-reply-ai__actions">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={aiBusy}
                  disabled={aiBusy || aiLimitReached}
                  onClick={() => void runReplyAi()}
                  data-testid="kommunikation-reply-ai-generate"
                >
                  {aiBusy ? t('emailThread.ai.generating') : draft.aiInsertedText ? t('emailThread.ai.regenerate') : t('emailThread.ai.generate')}
                </Button>
                <span className="form-hint" data-testid="kommunikation-reply-ai-remaining">
                  {t('emailThread.ai.remaining').replace('{n}', String(Math.max(0, REPLY_AI_MAX_GENERATIONS - aiGenerations)))}
                </span>
              </div>
              {aiBusy ? <p className="form-hint" role="status" data-testid="kommunikation-reply-ai-loading">{t('emailThread.ai.loadingHint')}</p> : null}
              {aiLimitReached ? <p className="form-hint" data-testid="kommunikation-reply-ai-limit">{t('emailThread.ai.limit')}</p> : null}
              {alreadyAnswered ? <p className="form-hint" data-testid="kommunikation-reply-ai-answered">{t('emailThread.ai.alreadyAnswered')}</p> : null}
              {aiErrorKey ? <p className="form-error" role="alert" data-testid="kommunikation-reply-ai-error">{t(aiErrorKey)}</p> : null}
              {draft.aiInsertedText && !aiBusy ? <p className="form-hint" data-testid="kommunikation-reply-ai-review">{t('emailThread.ai.reviewHint')}</p> : null}
            </div>
          ) : null}
          <div className="settings-form__field">
            <label htmlFor="free-email-body">{t('freeEmail.compose.body')}</label>
            <textarea
              id="free-email-body"
              className={`input settings-invoices__textarea${validation?.errors.includes('body_missing') ? ' input--error' : ''}`}
              rows={12}
              value={draft.bodyText}
              maxLength={EMAIL_BODY_MAX}
              onChange={(event) => setDraft({ bodyText: event.target.value })}
              data-testid="free-email-body"
            />
            {draft.signatureApplied ? <p className="form-hint" data-testid="free-email-body-hint">{t('freeEmail.compose.bodyHint')}</p> : null}
            {placeholders.length > 0 ? (
              <div className="email-reply-ai__placeholders" role="status" data-testid="kommunikation-reply-ai-placeholders">
                <p className="form-hint">{t('emailThread.ai.placeholdersHint')}</p>
                <ul>
                  {placeholders.map((placeholder) => <li key={placeholder} data-testid="kommunikation-reply-ai-placeholder">{placeholder}</li>)}
                </ul>
              </div>
            ) : null}
          </div>

          <div className="settings-form__field" data-testid="free-email-attachments">
            <label htmlFor="free-email-file">{t('freeEmail.compose.attachments')}</label>
            <p className="form-hint">
              {t('freeEmail.compose.attachmentsHint')
                .replace('{file}', formatBytes(EMAIL_ATTACHMENT_MAX_FILE_BYTES))
                .replace('{total}', formatBytes(EMAIL_ATTACHMENT_MAX_TOTAL_BYTES))
                .replace('{count}', String(EMAIL_ATTACHMENT_MAX_COUNT))}
            </p>
            <ul className="free-email-attachment-list" data-testid="free-email-attachment-list">
              {draft.attachments.map((attachment, index) => (
                <li key={`${attachment.sha256}-${attachment.filename}`} data-testid="free-email-attachment">
                  <span data-testid="free-email-attachment-name">{attachment.filename}</span>
                  {' · '}
                  <span data-testid="free-email-attachment-size">{formatBytes(attachment.sizeBytes)}</span>
                  {' · '}
                  <span>{t('freeEmail.compose.uploaded')}</span>{' '}
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeAttachment(index)} data-testid="free-email-attachment-remove">
                    {t('freeEmail.compose.removeAttachment')}
                  </Button>
                </li>
              ))}
              {pending.map((entry) => (
                <li key={entry.localId} data-testid="free-email-attachment-pending">
                  {entry.name} · {formatBytes(entry.size)} · {t('freeEmail.compose.uploading')}
                </li>
              ))}
            </ul>
            {draft.attachments.length > 0 ? (
              <p className="form-hint" data-testid="free-email-attachment-total">{t('freeEmail.compose.totalSize').replace('{size}', formatBytes(totalSize))}</p>
            ) : null}
            {notices.length > 0 ? (
              <ul className="form-error" role="alert" data-testid="free-email-attachment-errors">
                {notices.map((notice) => (
                  <li key={notice.id} data-testid="free-email-attachment-error">{noticeText(notice)}</li>
                ))}
              </ul>
            ) : null}
            <input
              ref={fileInput}
              id="free-email-file"
              type="file"
              multiple
              accept={ACCEPT}
              className="sr-only"
              onChange={(event) => void handleFiles(event)}
              data-testid="free-email-file-input"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} data-testid="free-email-add-attachment">
              {t('freeEmail.compose.addAttachment')}
            </Button>
          </div>
        </fieldset>

        {validation && validation.errors.length > 0 ? (
          <ul className="form-error" role="alert" data-testid="free-email-validation">
            {validation.errors.map((error) => (
              <li key={error} data-testid={`free-email-validation-${error}`}>{validationText(error)}</li>
            ))}
          </ul>
        ) : null}
        {errorKey ? (
          <p className="form-error" role="alert" data-testid="free-email-error">{t(errorKey)}</p>
        ) : null}
        {canSend && replyTo ? <p className="form-hint">{t('freeEmail.compose.noRealSendHint').replace('{replyTo}', replyTo)}</p> : null}
        {uploading ? <p className="form-hint" data-testid="free-email-send-locked">{t('freeEmail.compose.sendLockedUploads')}</p> : null}

        <div className="settings-form__actions">
          <Button type="submit" loading={busy} disabled={!canSend || uploading || busy || aiBusy} data-testid="free-email-send">
            {locked ? t('freeEmail.compose.resume') : busy ? t('freeEmail.compose.sending') : t(reply ? 'emailThread.sendReply' : 'freeEmail.compose.send')}
          </Button>
          <Button type="button" variant="ghost" onClick={handleDiscard} disabled={busy || locked} data-testid="free-email-discard">
            {t('freeEmail.compose.discard')}
          </Button>
        </div>
      </form>

      {reply ? (
        <SimpleConfirmDialog
          open={confirmSend}
          title={t('emailThread.confirmTitle')}
          message={t('emailThread.confirmMessage')
            .replace('{to}', [draft.to, draft.cc].filter((entry) => entry.trim()).join(', '))
            .replace('{subject}', draft.subject.trim())
            .replace('{attachments}', String(draft.attachments.length))}
          confirmLabel={t('emailThread.confirmSend')}
          confirmVariant="primary"
          cancelLabel={t('common.cancel')}
          confirmTestId="kommunikation-reply-confirm-send"
          cancelTestId="kommunikation-reply-confirm-cancel"
          dialogTestId="kommunikation-reply-confirm"
          onConfirm={() => {
            setConfirmSend(false);
            void handleSend(true);
            return true;
          }}
          onCancel={() => setConfirmSend(false)}
        />
      ) : null}

      {reply ? (
        <SimpleConfirmDialog
          open={aiConfirmOverwrite}
          title={t('emailThread.ai.overwriteTitle')}
          message={t('emailThread.ai.overwriteMessage')}
          confirmLabel={t('emailThread.ai.overwriteConfirm')}
          cancelLabel={t('common.cancel')}
          confirmVariant="primary"
          confirmTestId="kommunikation-reply-ai-overwrite-confirm"
          cancelTestId="kommunikation-reply-ai-overwrite-cancel"
          dialogTestId="kommunikation-reply-ai-overwrite"
          onConfirm={() => {
            setAiConfirmOverwrite(false);
            void runReplyAi(true);
            return true;
          }}
          onCancel={() => setAiConfirmOverwrite(false)}
        />
      ) : null}
    </div>
  );
}
