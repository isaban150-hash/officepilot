import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { SendDocumentDialog } from '../invoice/SendDocumentDialog';
import { DeliveryHistoryList } from '../invoice/DeliveryHistoryList';
import { useApp } from '../../context/AppContext';
import { useOptionalAuth } from '../../context/AuthContext';
import { isSupabaseConfigured } from '../../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import { downloadInvoicePdfBytes } from '../../services/invoicePdfService';
import { getVorgangById } from '../../services/vorgangService';
import { findAcceptedDelivery, resolveDocumentDeliveryDraftDefaults } from '../../services/delivery/documentDeliveryDefaults';
import { hasUncertainDelivery, isDeliveryRetryable } from '../../services/delivery/documentDeliveryContract';
import {
  findArchivedDocumentPdfFileRefId,
  prepareArchivedDocumentDeliveryAttachment,
  resolveArchivedDocumentDeliveryKind,
} from '../../services/delivery/documentDeliveryCloudService';
import {
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
  server_unavailable: 'delivery.error.serverUnavailable' as TranslationKey,
  unauthenticated: 'delivery.error.forbidden' as TranslationKey,
  rpc_failed: 'delivery.error.serverUnavailable' as TranslationKey,
};

/** Synchron: Gibt es eine gebundene PDF-Datei? (Archiv-PDF wird beim Senden zusätzlich geprüft.) */
export function isArchivedDocumentEmailSendable(document: CompanyDocument): boolean {
  if (document.sync?.deleted) return false;
  return Boolean(findArchivedDocumentPdfFileRefId(document));
}

export function DocumentDeliveryPanel({ document }: Props) {
  const { translate, language, showToast, companyProfile } = useApp();
  const user = useOptionalAuth()?.user ?? null;
  const kind = resolveArchivedDocumentDeliveryKind(document);
  const identity = useMemo<DeliveryDocumentIdentity>(() => ({ kind, clientDocumentId: document.id }), [kind, document.id]);
  const cloud = isSupabaseConfigured();
  const access = useMemo(() => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: cloud }), [user?.id, cloud]);
  const sendable = isArchivedDocumentEmailSendable(document);
  const canSend = cloud && access.canWrite && sendable;

  const [deliveries, setDeliveries] = useState<DocumentDelivery[] | null>(null);
  const [dialog, setDialog] = useState<{ mode: 'send' | 'retry' | 'resume'; draft?: SendDraftState; retryOf?: DocumentDelivery } | null>(null);
  const [phase, setPhase] = useState<SendPhase | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  const inFlight = useRef(false);
  const [pendingDraft, setPendingDraft] = useState<SendDraftState | null>(() => loadSendDraft(identity));

  const defaults = useMemo(() => {
    const vorgang = document.linkedVorgang ? getVorgangById(document.linkedVorgang.vorgangId) : undefined;
    return resolveDocumentDeliveryDraftDefaults(
      { title: document.title, vorgangCustomerEmail: vorgang?.customerBilling?.email ?? null, profile: companyProfile },
      language,
    );
  }, [document.title, document.linkedVorgang, companyProfile, language]);

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
  const uncertain = deliveries ? hasUncertainDelivery(deliveries) : false;

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
      if (result.action === 'sent' || result.action === 'replayed') showToast(translate('delivery.toast.accepted' as TranslationKey));
      else if (result.action === 'unknown_pending') showToast(translate('delivery.toast.unknown' as TranslationKey));
      else showToast(translate('delivery.toast.failed' as TranslationKey));
    } finally {
      inFlight.current = false;
      setBusy(false);
      setPhase(null);
    }
  };

  const handleSend = (fields: { recipientEmail: string; subject: string; bodyText: string }) => {
    if (!dialog) return;
    if (uncertain && !(dialog.mode === 'resume' && dialog.draft)) {
      setErrorKey('delivery.error.uncertainPending' as TranslationKey);
      return;
    }
    if (dialog.draft && dialog.mode === 'resume' && dialog.draft.recipientEmail === fields.recipientEmail && dialog.draft.subject === fields.subject && dialog.draft.bodyText === fields.bodyText) {
      void runWith(dialog.draft);
      return;
    }
    if (dialog.draft) clearSendDraft(identity, dialog.draft.scopeKey);
    const draft = createSendDraft({ identity, vorgangId: null, ...fields, retryOfDeliveryId: dialog.retryOf?.id });
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

  const attachmentFilename = `${(document.title || 'Dokument').replace(/\.pdf$/i, '')}.pdf`;

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
        ) : null}

        {cloud ? (
          <>
            <h4 className="invoice-delivery-panel__history-title">{translate('delivery.history.title' as TranslationKey)}</h4>
            <DeliveryHistoryList deliveries={deliveries} emptyKey={'delivery.document.history.empty' as TranslationKey} translate={translate} />
          </>
        ) : null}

        {canSend ? (
          <div className="invoice-delivery-panel__actions">
            {uncertain ? (
              <Button type="button" variant="outline" onClick={() => void refresh()} disabled={busy} data-testid="document-delivery-check-status">
                {translate('delivery.action.checkStatus' as TranslationKey)}
              </Button>
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
              <Button type="button" variant="outline" onClick={() => setDialog({ mode: 'send' })} disabled={busy} data-testid="document-delivery-send">
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
          alreadySent={alreadySent}
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
    </section>
  );
}
