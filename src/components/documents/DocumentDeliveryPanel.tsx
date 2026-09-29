import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
import { SendDocumentDialog } from '../invoice/SendDocumentDialog';
import { DeliveryHistoryList } from '../invoice/DeliveryHistoryList';
import { useApp } from '../../context/AppContext';
import { useOptionalAuth } from '../../context/AuthContext';
import { isSupabaseConfigured } from '../../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import { downloadInvoicePdfBytes } from '../../services/invoicePdfService';
import { getVorgangById } from '../../services/vorgangService';
import { resolveBusinessLetterCustomerEmail } from '../../services/letter/businessLetterArchiveService';
import { composeDocumentDeliveryDraft, findAcceptedDelivery } from '../../services/delivery/documentDeliveryDefaults';
import { resolveDeliveryDocumentFacts } from '../../services/delivery/deliveryDocumentFacts';
import { findOpenUncertainDelivery, isDeliveryInProgress, isDeliveryRetryable } from '../../services/delivery/documentDeliveryContract';
import {
  buildArchivedDocumentAttachmentFilename,
  findArchivedDocumentPdfFileRefId,
  isArchivedDocumentSyncBlocked,
  prepareArchivedDocumentDeliveryAttachment,
  resolveArchivedDocumentDeliveryKind,
} from '../../services/delivery/documentDeliveryCloudService';
import {
  checkDeliveryStatus,
  clearSendDraft,
  createSendDraft,
  loadSendDraft,
  refreshDocumentDeliveries,
  runSendDocument,
  type SendDocumentClientError,
  type SendDraftState,
  type SendPhase,
} from '../../services/delivery/sendDocumentOrchestrator';
import type { DeliveryDocumentIdentity, DocumentDelivery } from '../../types/documentDelivery';
import type { CompanyDocument } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/**
 * V1-B2 — Versand eines normalen archivierten Dokuments (Brief, Angebot,
 * sonstiges) per E-Mail. Dieselbe Kette wie beim Rechnungsversand
 * (Orchestrator, Delivery-Historie, Dialog, B1-Regeln), aber:
 *   - Bezug ist das Dokument (`clientDocumentId`), nie eine Rechnung
 *   - Anhang ist die gebundene PDF-Datei des Dokuments (kein Rendern)
 *   - Absender ist das aktuelle Firmenprofil (Server prüft fail-closed)
 *   - kein Rechnungsstatus wird berührt
 * Versendbar nur, wenn zum Dokument eine PDF-Datei vorliegt.
 */
interface Props {
  document: CompanyDocument;
  /** ANGEBOT-01B — Empfaenger aus dem Angebot, wenn das Dokument keinen Auftrag traegt. */
  recipientEmail?: string | null;
  /** ANGEBOT-01B — nach angenommenem Versand (sent/replayed): der Aufrufer fuehrt seinen Zustand nach. */
  onAccepted?: () => void;
}

const CLIENT_ERROR_KEYS: Record<SendDocumentClientError, TranslationKey> = {
  not_configured: 'delivery.panel.cloudRequired' as TranslationKey,
  workspace_missing: 'delivery.panel.cloudRequired' as TranslationKey,
  invoice_missing: 'delivery.error.notSendable' as TranslationKey,
  document_missing: 'delivery.error.documentMissing' as TranslationKey,
  document_not_sendable: 'delivery.error.documentNotSendable' as TranslationKey,
  invalid_recipient: 'delivery.dialog.recipientInvalid' as TranslationKey,
  pdf_failed: 'delivery.error.documentNotSendable' as TranslationKey,
  upload_failed: 'delivery.error.uploadFailed' as TranslationKey,
  idempotency_conflict: 'delivery.error.idempotencyConflict' as TranslationKey,
  forbidden: 'delivery.error.forbidden' as TranslationKey,
  not_sendable: 'delivery.error.documentNotSendable' as TranslationKey,
  uncertain_pending: 'delivery.error.uncertainPending' as TranslationKey,
  uncertain_retry_exists: 'delivery.error.uncertainRetryExists' as TranslationKey,
  rate_limited: 'delivery.error.rateLimited' as TranslationKey,
  attachment_not_synced: 'delivery.error.attachmentNotSynced' as TranslationKey,
  attachment_unavailable: 'delivery.error.attachmentUnavailable' as TranslationKey,
  document_sync_blocked: 'delivery.error.documentSyncBlocked' as TranslationKey,
  server_unavailable: 'delivery.error.serverUnavailable' as TranslationKey,
  unauthenticated: 'delivery.error.forbidden' as TranslationKey,
  rpc_failed: 'delivery.error.serverUnavailable' as TranslationKey,
};

/** Synchron: Gibt es eine gebundene PDF-Datei? (Archiv-PDF wird beim Senden zusätzlich geprüft.) */
export function isArchivedDocumentEmailSendable(document: CompanyDocument): boolean {
  if (document.sync?.deleted) return false;
  return Boolean(findArchivedDocumentPdfFileRefId(document));
}

export function DocumentDeliveryPanel({ document, recipientEmail = null, onAccepted }: Props) {
  const { translate, language, showToast, companyProfile } = useApp();
  const user = useOptionalAuth()?.user ?? null;
  const kind = resolveArchivedDocumentDeliveryKind(document);
  const identity = useMemo<DeliveryDocumentIdentity>(() => ({ kind, clientDocumentId: document.id }), [kind, document.id]);
  const cloud = isSupabaseConfigured();
  const access = useMemo(() => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: cloud }), [user?.id, cloud]);
  const sendable = isArchivedDocumentEmailSendable(document);
  // 07B-FIX2 — ungeklärter Sync-Konflikt am Dokument: kein Versand (fail-closed), mit Grund.
  const syncBlocked = isArchivedDocumentSyncBlocked(document);
  const canSend = cloud && access.canWrite && sendable && !syncBlocked;

  const [deliveries, setDeliveries] = useState<DocumentDelivery[] | null>(null);
  const [dialog, setDialog] = useState<{ mode: 'send' | 'retry' | 'resume' | 'retry_uncertain'; draft?: SendDraftState; retryOf?: DocumentDelivery; resendAcknowledged?: boolean } | null>(null);
  /*
   * E-MAIL-HALBZEIT-FIX B2 — nach einem erfolgreichen Versand fragt die App
   * VOR dem Versanddialog ausdrücklich nach (mögliche Doppelzustellung).
   * Abbrechen: kein Dialog, kein Versandauftrag, kein Provider-Aufruf.
   */
  const [resendWarning, setResendWarning] = useState(false);
  const [phase, setPhase] = useState<SendPhase | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  const inFlight = useRef(false);
  const [pendingDraft, setPendingDraft] = useState<SendDraftState | null>(() => loadSendDraft(identity));

  const defaults = useMemo(() => {
    const vorgang = document.linkedVorgang ? getVorgangById(document.linkedVorgang.vorgangId) : undefined;
    /*
     * 07B-FIX1 — ein eigener Geschäftsbrief kennt seinen Kunden strukturell
     * (Brief → customerId). Diese Adresse geht vor; sonst wie bisher der
     * Auftrag bzw. der Aufrufer. Nie über Namen geraten.
     */
    const letterCustomerEmail = resolveBusinessLetterCustomerEmail(document);
    // E-MAIL-07C — Vorlage der Dokumentart (Brief/Angebot/sonst) + zentrale Signatur genau einmal.
    const facts = resolveDeliveryDocumentFacts(document);
    return composeDocumentDeliveryDraft(
      {
        kind,
        // HALBZEIT-FIX A1 — fachlicher Titel (Angebot) vor dem Archivtitel.
        title: facts.documentTitle ?? document.title,
        documentNumber: facts.documentNumber,
        customerName: facts.customerName,
        vorgangCustomerEmail: letterCustomerEmail ?? vorgang?.customerBilling?.email ?? recipientEmail ?? null,
        profile: companyProfile,
      },
      language,
    );
  }, [document, companyProfile, language, recipientEmail, kind]);

  const refresh = useCallback(async () => {
    if (!cloud) return;
    const result = await refreshDocumentDeliveries(identity as Extract<DeliveryDocumentIdentity, { clientDocumentId: string }>);
    if (!result.ok) return;
    setDeliveries(result.deliveries);
  }, [cloud, identity]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, cloud]);

  /* Resume wie beim Rechnungspanel: Serverstatus entscheidet; nie erneut senden bei provider_accepted/unknown. */
  useEffect(() => {
    if (!pendingDraft || deliveries === null) return;
    const existing = deliveries.find((d) => d.clientDeliveryId === pendingDraft.clientDeliveryId);
    if (existing) {
      if (existing.status === 'queued' || existing.status === 'prepared') {
        setDialog({ mode: 'resume', draft: pendingDraft });
      } else {
        clearSendDraft(identity, pendingDraft.scopeKey);
        setPendingDraft(null);
      }
      return;
    }
    if (pendingDraft.phase === 'draft' || pendingDraft.phase === 'preparing' || pendingDraft.phase === 'uploading' || pendingDraft.phase === 'creating') {
      setDialog({ mode: 'resume', draft: pendingDraft });
    }
  }, [pendingDraft, deliveries, identity]);

  const accepted = deliveries ? findAcceptedDelivery(deliveries) : undefined;
  const latest = deliveries?.[0];
  const alreadySent = Boolean(accepted);
  // E-MAIL-07B — dieselben Regeln wie im Rechnungspanel (offener unklarer Versuch, laufender Versand).
  const uncertainDelivery = deliveries ? findOpenUncertainDelivery(deliveries) : undefined;
  const uncertain = Boolean(uncertainDelivery);
  const inProgressDelivery = deliveries?.find((d) => isDeliveryInProgress(d.status));

  const handleCheckStatus = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (inProgressDelivery) await checkDeliveryStatus({ delivery: inProgressDelivery });
      await refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const runWith = async (draft: SendDraftState) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErrorKey(null);
    setErrorDetail(undefined);
    try {
      const result = await runSendDocument({ draft, vorgangId: null }, { onPhase: setPhase });
      if (!result.ok) {
        setErrorKey(CLIENT_ERROR_KEYS[result.error]);
        setErrorDetail(result.message);
        setPendingDraft(result.draft);
        return;
      }
      setDeliveries(result.deliveries);
      clearSendDraft(identity, draft.scopeKey);
      setPendingDraft(null);
      setDialog(null);
      await refresh();
      if (result.action === 'sent' || result.action === 'replayed') {
        showToast(translate('delivery.toast.accepted' as TranslationKey));
        onAccepted?.();
      }
      else if (result.action === 'unknown_pending') showToast(translate('delivery.toast.unknown' as TranslationKey));
      else if (result.action === 'in_progress') showToast(translate('delivery.toast.inProgress' as TranslationKey));
      else showToast(translate('delivery.toast.failed' as TranslationKey));
    } finally {
      inFlight.current = false;
      setBusy(false);
      setPhase(null);
    }
  };

  const handleSend = (fields: { recipientEmail: string; subject: string; bodyText: string }) => {
    if (!dialog) return;
    if (uncertain && dialog.mode !== 'retry_uncertain' && !(dialog.mode === 'resume' && dialog.draft)) {
      setErrorKey('delivery.error.uncertainPending' as TranslationKey);
      return;
    }
    if (dialog.draft && dialog.mode === 'resume' && dialog.draft.recipientEmail === fields.recipientEmail && dialog.draft.subject === fields.subject && dialog.draft.bodyText === fields.bodyText) {
      void runWith(dialog.draft);
      return;
    }
    if (dialog.draft) clearSendDraft(identity, dialog.draft.scopeKey);
    const draft = createSendDraft({
      identity,
      vorgangId: null,
      ...fields,
      retryOfDeliveryId: dialog.retryOf?.id,
      confirmUncertainRetry: dialog.mode === 'retry_uncertain',
    });
    setPendingDraft(draft);
    void runWith(draft);
  };

  const closeDialog = () => {
    if (busy) return;
    if (dialog?.draft && dialog.draft.phase === 'draft') {
      clearSendDraft(identity, dialog.draft.scopeKey);
      setPendingDraft(null);
    }
    setDialog(null);
    setErrorKey(null);
  };

  const previewPdf = async () => {
    const prepared = await prepareArchivedDocumentDeliveryAttachment(document);
    if (prepared.ok) downloadInvoicePdfBytes(prepared.attachment.bytes, prepared.attachment.filename);
    else showToast(translate('delivery.error.documentNotSendable' as TranslationKey));
  };

  // E-MAIL-07B — derselbe Name, der tatsächlich versendet wird (eine Quelle, serverkonform bereinigt).
  const attachmentFilename = buildArchivedDocumentAttachmentFilename(document);

  return (
    <section className="invoice-delivery-panel document-delivery-panel" data-testid="document-delivery-panel" data-document-kind={kind} data-sendable={sendable ? 'true' : 'false'}>
      <Card>
        <CardTitle>{translate('delivery.document.panel.title' as TranslationKey)}</CardTitle>
        <p className="hint-text">{translate('delivery.document.panel.hint' as TranslationKey)}</p>

        {!sendable ? (
          <p className="hint-text" data-testid="document-delivery-not-sendable">{translate('delivery.document.panel.notSendable' as TranslationKey)}</p>
        ) : !cloud ? (
          <p className="hint-text" data-testid="document-delivery-cloud-required">{translate('delivery.panel.cloudRequired' as TranslationKey)}</p>
        ) : !access.canWrite ? (
          <p className="hint-text" data-testid="document-delivery-readonly">{translate('delivery.panel.readOnly' as TranslationKey)}</p>
        ) : syncBlocked ? (
          <p className="hint-text" data-testid="document-delivery-sync-blocked">{translate('delivery.document.panel.syncBlocked' as TranslationKey)}</p>
        ) : null}

        {cloud ? (
          <>
            <h4 className="invoice-delivery-panel__history-title">{translate('delivery.history.title' as TranslationKey)}</h4>
            <DeliveryHistoryList deliveries={deliveries} emptyKey={'delivery.document.history.empty' as TranslationKey} translate={translate} />
          </>
        ) : null}

        {canSend ? (
          <div className="invoice-delivery-panel__actions">
            {inProgressDelivery ? (
              <Button type="button" variant="outline" onClick={() => void handleCheckStatus()} disabled={busy} data-testid="document-delivery-check-status">
                {translate('delivery.action.checkStatus' as TranslationKey)}
              </Button>
            ) : uncertainDelivery ? (
              <>
                <Button type="button" variant="outline" onClick={() => void handleCheckStatus()} disabled={busy} data-testid="document-delivery-check-status">
                  {translate('delivery.action.checkStatus' as TranslationKey)}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialog({ mode: 'retry_uncertain', retryOf: uncertainDelivery })}
                  disabled={busy}
                  data-testid="document-delivery-retry-uncertain"
                >
                  {translate('delivery.action.retryUncertain' as TranslationKey)}
                </Button>
              </>
            ) : latest && isDeliveryRetryable(latest.status) && latest.status !== 'bounced' ? (
              <Button type="button" variant="outline" onClick={() => setDialog({ mode: 'retry', retryOf: latest })} disabled={busy} data-testid="document-delivery-retry">
                {translate('delivery.action.retry' as TranslationKey)}
              </Button>
            ) : latest?.status === 'queued' && pendingDraft ? (
              <Button type="button" variant="outline" onClick={() => setDialog({ mode: 'resume', draft: pendingDraft })} disabled={busy} data-testid="document-delivery-resume">
                {translate('delivery.action.resume' as TranslationKey)}
              </Button>
            ) : (
              /* Sekundäre Aktion: Outline, nie die Hauptaktion der Dokumentseite. */
              <Button type="button" variant="outline" onClick={() => (alreadySent ? setResendWarning(true) : setDialog({ mode: 'send' }))} disabled={busy} data-testid="document-delivery-send">
                {translate((alreadySent ? 'delivery.document.action.sendAgain' : 'delivery.document.action.send') as TranslationKey)}
              </Button>
            )}
          </div>
        ) : null}
      </Card>

      {dialog ? (
        <SendDocumentDialog
          open
          onPreviewPdf={previewPdf}
          initialRecipient={dialog.draft?.recipientEmail ?? dialog.retryOf?.recipientEmail ?? defaults.recipient.email}
          canonicalRecipient={defaults.recipient.email}
          initialSubject={dialog.draft?.subject ?? dialog.retryOf?.subject ?? defaults.subject}
          initialBody={dialog.draft?.bodyText ?? dialog.retryOf?.bodyText ?? defaults.bodyText}
          attachmentFilename={attachmentFilename}
          alreadySent={alreadySent && !dialog.resendAcknowledged}
          mode={dialog.mode}
          documentKind={kind}
          phase={phase}
          busy={busy}
          errorKey={errorKey}
          errorDetail={errorDetail}
          translate={translate}
          onCancel={closeDialog}
          onSend={handleSend}
        />
      ) : null}

      <SimpleConfirmDialog
        open={resendWarning}
        title={translate('delivery.resendWarning.title' as TranslationKey)}
        message={translate('delivery.resendWarning.document' as TranslationKey)}
        confirmLabel={translate('delivery.resendWarning.confirm' as TranslationKey)}
        cancelLabel={translate('delivery.action.cancel' as TranslationKey)}
        confirmVariant="primary"
        dialogTestId="document-delivery-resend-warning"
        confirmTestId="document-delivery-resend-warning-confirm"
        cancelTestId="document-delivery-resend-warning-cancel"
        onCancel={() => setResendWarning(false)}
        onConfirm={() => {
          setResendWarning(false);
          setDialog({ mode: 'send', resendAcknowledged: true });
          return true;
        }}
      />
    </section>
  );
}
