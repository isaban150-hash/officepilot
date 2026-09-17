import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { SendDocumentDialog } from './SendDocumentDialog';
import { DeliveryHistoryList } from './DeliveryHistoryList';
import { useApp } from '../../context/AppContext';
import { useOptionalAuth } from '../../context/AuthContext';
import { isSupabaseConfigured } from '../../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import { isFinalizedInvoice } from '../../services/invoiceArchiveService';
import { buildInvoicePdfFilename } from '../../services/invoicePdfService';
import { formatInvoiceDate } from '../../services/invoicePrintModel';
import {
  findAcceptedDelivery,
  resolveDeliveryDraftDefaults,
} from '../../services/delivery/documentDeliveryDefaults';
import { hasUncertainDelivery, isDeliveryRetryable } from '../../services/delivery/documentDeliveryContract';
import {
  clearSendDraft,
  createSendDraft,
  loadSendDraft,
  refreshDeliveries,
  runSendDocument,
  type SendDocumentClientError,
  type SendDraftState,
  type SendPhase,
} from '../../services/delivery/sendDocumentOrchestrator';
import type { DeliveryDocumentIdentity, DocumentDelivery } from '../../types/documentDelivery';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/**
 * EMAIL-01B3 — Abschnitt „Versand per E-Mail" auf der Rechnungsdetailseite.
 *
 * Zeigt die Herkunft der Versandwahrheit (manuell / OfficePilot), die
 * Delivery-Historie mit ehrlichen Statusbegriffen („übergeben", nie
 * „zugestellt" ohne Provider-Ereignis) und bietet den Versand an. Die
 * manuelle Aktion „Extern als versendet markieren" bleibt im eigenen Panel.
 *
 * Identisch für freie und Vorgangsrechnung: die Identität ist
 * `{kind:'invoice', clientInvoiceId}`, nie ein Vorgang.
 */
interface Props {
  vorgangId: string | null;
  invoice: VorgangInvoice;
  onInvoiceUpdated: (invoice: VorgangInvoice) => void;
  /** EMAIL-01B4 — `invoice_correction`: der Korrekturbeleg der stornierten Rechnung; gleicher Unterbau. */
  documentKind?: 'invoice' | 'invoice_correction';
}

const CLIENT_ERROR_KEYS: Record<SendDocumentClientError, TranslationKey> = {
  not_configured: 'delivery.panel.cloudRequired' as TranslationKey,
  workspace_missing: 'delivery.panel.cloudRequired' as TranslationKey,
  invoice_missing: 'delivery.error.notSendable' as TranslationKey,
  invalid_recipient: 'delivery.dialog.recipientInvalid' as TranslationKey,
  pdf_failed: 'delivery.error.pdfFailed' as TranslationKey,
  upload_failed: 'delivery.error.uploadFailed' as TranslationKey,
  idempotency_conflict: 'delivery.error.idempotencyConflict' as TranslationKey,
  forbidden: 'delivery.error.forbidden' as TranslationKey,
  not_sendable: 'delivery.error.notSendable' as TranslationKey,
  document_missing: 'delivery.error.documentMissing' as TranslationKey,
  document_not_sendable: 'delivery.error.documentNotSendable' as TranslationKey,
  uncertain_pending: 'delivery.error.uncertainPending' as TranslationKey,
  server_unavailable: 'delivery.error.serverUnavailable' as TranslationKey,
  unauthenticated: 'delivery.error.forbidden' as TranslationKey,
  rpc_failed: 'delivery.error.serverUnavailable' as TranslationKey,
};

export function InvoiceDeliveryPanel({ vorgangId, invoice, onInvoiceUpdated, documentKind = 'invoice' }: Props) {
  const { translate, language, showToast, companyProfile } = useApp();
  const isCorrection = documentKind === 'invoice_correction';
  const user = useOptionalAuth()?.user ?? null;
  const identity = useMemo<DeliveryDocumentIdentity>(() => ({ kind: documentKind, clientInvoiceId: invoice.id }), [documentKind, invoice.id]);
  const cloud = isSupabaseConfigured();
  const access = useMemo(() => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: cloud }), [user?.id, cloud]);
  const documentAvailable = isCorrection
    ? invoice.cancellationKind === 'correction' && Boolean(invoice.correctionDocumentId)
    : !invoice.cancelledAt;
  const canSend = cloud && access.canWrite && isFinalizedInvoice(invoice) && documentAvailable;

  const [deliveries, setDeliveries] = useState<DocumentDelivery[] | null>(null);
  const [dialog, setDialog] = useState<{ mode: 'send' | 'retry' | 'resume'; draft?: SendDraftState; retryOf?: DocumentDelivery } | null>(null);
  const [phase, setPhase] = useState<SendPhase | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  const inFlight = useRef(false);
  const [pendingDraft, setPendingDraft] = useState<SendDraftState | null>(() => loadSendDraft(identity));

  /*
   * Defaults nur für einen **neuen** Entwurf: Workspace-Standard (Rechnung)
   * bzw. fester i18n-Text (Korrektur). Ein vorhandener Entwurf, ein Retry oder
   * eine Delivery tragen ihre eigenen, tatsächlich verwendeten Werte.
   */
  const defaults = useMemo(
    () => resolveDeliveryDraftDefaults(invoice, language, { profile: companyProfile, kind: documentKind }),
    [invoice, language, companyProfile, documentKind],
  );

  const refresh = useCallback(async () => {
    if (!cloud || !isFinalizedInvoice(invoice)) return;
    const result = await refreshDeliveries({ vorgangId, invoice, identity });
    if (!result.ok) return;
    setDeliveries(result.deliveries);
    if (result.invoice !== invoice) onInvoiceUpdated(result.invoice);
  }, [cloud, invoice, vorgangId, identity, onInvoiceUpdated]);

  useEffect(() => {
    void refresh();
    // Nur bei Wechsel der Rechnung neu laden — nicht bei jedem lokalen Commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.id, cloud]);

  /*
   * Resume: ein begonnener Versuch dieser Rechnung. Existiert die Delivery
   * bereits auf dem Server, entscheidet ihr Status (nie erneut senden bei
   * provider_accepted/unknown); ein reiner Dialog-Entwurf wird wiederhergestellt.
   */
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
  const alreadySent = isCorrection ? Boolean(accepted) : invoice.sentSource === 'officepilot' || Boolean(accepted);
  /*
   * V1-B1 — solange irgendein Versuch dieses Dokuments `unknown` ist (Handoff
   * ungewiss), gibt es weder „Erneut versuchen" noch „Per E-Mail senden":
   * Der Provider könnte die Mail bereits angenommen haben; ein neuer Versand
   * wäre eine mögliche Doppelzustellung. Nur „Status prüfen" bleibt.
   */
  const uncertain = deliveries ? hasUncertainDelivery(deliveries) : false;

  const runWith = async (draft: SendDraftState) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErrorKey(null);
    setErrorDetail(undefined);
    try {
      const result = await runSendDocument({ draft, vorgangId }, { onPhase: setPhase });
      if (!result.ok) {
        setErrorKey(CLIENT_ERROR_KEYS[result.error]);
        setErrorDetail(result.message);
        setPendingDraft(result.draft);
        return;
      }
      setDeliveries(result.deliveries);
      // Abgeschlossener Versuch — der Resume-Entwurf ist erledigt (Orchestrator räumt ihn ebenfalls).
      clearSendDraft(identity, draft.scopeKey);
      setPendingDraft(null);
      setDialog(null);
      const updated = await refreshDeliveries({ vorgangId, invoice, identity });
      if (updated.ok) {
        setDeliveries(updated.deliveries);
        onInvoiceUpdated(updated.invoice);
      }
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
    // V1-B1 — zweite Sperre hinter der Oberfläche: kein neuer Versuch bei ungewissem Handoff.
    if (uncertain && !(dialog.mode === 'resume' && dialog.draft)) {
      setErrorKey('delivery.error.uncertainPending' as TranslationKey);
      return;
    }
    // Resume mit vorhandenem Draft: dieselbe client_delivery_id (technischer Replay).
    if (dialog.draft && dialog.mode === 'resume' && dialog.draft.recipientEmail === fields.recipientEmail && dialog.draft.subject === fields.subject && dialog.draft.bodyText === fields.bodyText) {
      void runWith(dialog.draft);
      return;
    }
    // Neuer Versuch: neue ID (bei Retry mit Bezug auf die gescheiterte Delivery).
    if (dialog.draft) clearSendDraft(identity, dialog.draft.scopeKey);
    const draft = createSendDraft({ identity, vorgangId, ...fields, retryOfDeliveryId: dialog.retryOf?.id });
    setPendingDraft(draft);
    void runWith(draft);
  };

  const closeDialog = () => {
    if (busy) return;
    if (dialog?.draft && (dialog.draft.phase === 'draft')) {
      clearSendDraft(identity, dialog.draft.scopeKey);
      setPendingDraft(null);
    }
    setDialog(null);
    setErrorKey(null);
  };

  const sourceKey: TranslationKey = (invoice.status === 'versendet'
    ? invoice.sentSource === 'officepilot'
      ? 'delivery.source.officepilot'
      : 'delivery.source.manual'
    : 'delivery.source.none') as TranslationKey;

  return (
    <section className="invoice-delivery-panel" data-testid={isCorrection ? 'invoice-correction-delivery-panel' : 'invoice-delivery-panel'} data-document-kind={documentKind}>
      <Card>
        <CardTitle>{translate((isCorrection ? 'delivery.correction.panel.title' : 'delivery.panel.title') as TranslationKey)}</CardTitle>
        <p className="hint-text">{translate((isCorrection ? 'delivery.correction.panel.hint' : 'delivery.panel.hint') as TranslationKey)}</p>

        {isCorrection ? null : (
        <div className="data-row" data-testid="invoice-delivery-source">
          <span className="data-row__label">{translate('invoice.sent.title' as TranslationKey)}</span>
          <span className="data-row__value" data-source={invoice.status === 'versendet' ? invoice.sentSource ?? 'manual' : 'none'}>
            {translate(sourceKey)}
            {invoice.status === 'versendet' && invoice.sentAt ? ` · ${formatInvoiceDate(invoice.sentAt)}` : ''}
          </span>
        </div>
        )}
        {invoice.sentManualPrior?.sentAt ? (
          <p className="hint-text" data-testid="invoice-delivery-manual-prior">
            {translate('delivery.source.manualPrior' as TranslationKey)
              .replace('{date}', formatInvoiceDate(invoice.sentManualPrior.sentAt))
              .replace('{via}', invoice.sentManualPrior.sentVia ? translate(`invoice.sent.via.${invoice.sentManualPrior.sentVia}` as TranslationKey) : '—')}
          </p>
        ) : null}

        {!cloud ? (
          <p className="hint-text" data-testid="invoice-delivery-cloud-required">{translate('delivery.panel.cloudRequired' as TranslationKey)}</p>
        ) : !access.canWrite ? (
          <p className="hint-text" data-testid="invoice-delivery-readonly">{translate('delivery.panel.readOnly' as TranslationKey)}</p>
        ) : null}

        <h4 className="invoice-delivery-panel__history-title">{translate('delivery.history.title' as TranslationKey)}</h4>
        <DeliveryHistoryList deliveries={deliveries} emptyKey={(isCorrection ? 'delivery.correction.history.empty' : 'delivery.history.empty') as TranslationKey} translate={translate} />

        {canSend ? (
          <div className="invoice-delivery-panel__actions">
            {uncertain ? (
              <Button type="button" variant="outline" onClick={() => void refresh()} disabled={busy} data-testid="invoice-delivery-check-status">
                {translate('delivery.action.checkStatus' as TranslationKey)}
              </Button>
            ) : latest && isDeliveryRetryable(latest.status) && latest.status !== 'bounced' ? (
              <Button type="button" onClick={() => setDialog({ mode: 'retry', retryOf: latest })} disabled={busy} data-testid="invoice-delivery-retry">
                {translate('delivery.action.retry' as TranslationKey)}
              </Button>
            ) : latest?.status === 'queued' && pendingDraft ? (
              <Button type="button" onClick={() => setDialog({ mode: 'resume', draft: pendingDraft })} disabled={busy} data-testid="invoice-delivery-resume">
                {translate('delivery.action.resume' as TranslationKey)}
              </Button>
            ) : (
              <Button type="button" onClick={() => setDialog({ mode: 'send' })} disabled={busy} data-testid="invoice-delivery-send">
                {translate((isCorrection
                  ? alreadySent ? 'delivery.correction.action.sendAgain' : 'delivery.correction.action.send'
                  : alreadySent ? 'delivery.action.sendAgain' : 'delivery.action.send') as TranslationKey)}
              </Button>
            )}
          </div>
        ) : null}
      </Card>

      {dialog ? (
        <SendDocumentDialog
          open
          invoice={invoice}
          initialRecipient={dialog.draft?.recipientEmail ?? dialog.retryOf?.recipientEmail ?? defaults.recipient.email}
          canonicalRecipient={defaults.recipient.email}
          initialSubject={dialog.draft?.subject ?? dialog.retryOf?.subject ?? defaults.subject}
          initialBody={dialog.draft?.bodyText ?? dialog.retryOf?.bodyText ?? defaults.bodyText}
          attachmentFilename={buildInvoicePdfFilename(isCorrection ? `Rechnungskorrektur-${invoice.number}` : invoice.number)}
          alreadySent={alreadySent}
          mode={dialog.mode}
          documentKind={documentKind}
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
