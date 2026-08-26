import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocumentView } from '../components/invoice/InvoiceDocumentView';
import { InvoicePrintActions } from '../components/invoice/InvoicePrintActions';
import {
  getPaymentSavedToastKey,
  InvoicePaymentForm,
} from '../components/invoice/InvoicePaymentForm';
import { InvoicePaymentHistory } from '../components/invoice/InvoicePaymentHistory';
import { InvoicePaymentSummary } from '../components/invoice/InvoicePaymentSummary';
import { DetailExperienceCard } from '../components/detail/DetailExperienceCard';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { INVOICE_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { Button } from '../components/ui/Button';
import { ShowMoreSection } from '../components/ui/ShowMoreSection';
import { useApp } from '../context/AppContext';
import { isFinalizedInvoice, buildPrintTitle } from '../services/invoiceArchiveService';
import { buildInvoicePrintModelFromInvoice } from '../services/invoicePrintModel';
import {
  calculatePaymentSummary,
  formatPaymentCurrency,
  findLocallyOnlyPayments,
  getInvoicePayments,
  isInvoiceCancelled,
  isInvoicePaymentCloudSynced,
  removePayment,
  reverseInvoicePaymentInCloudForRemoval,
  syncInvoicePaymentToCloud,
} from '../services/invoicePaymentService';
import {
  isInvoicePaymentCloudSilent,
  pullInvoicePaymentsFromCloud,
} from '../services/invoice/workspaceInvoicePaymentCloudService';
import { getLastPersistSuccess } from '../services/persistenceService';
import { printInvoice } from '../services/invoicePrintService';
import { getVorgangById, getVorgangInvoice } from '../services/vorgangService';
import { InvoiceSentPanel } from '../components/invoice/InvoiceSentPanel';
import type { VorgangInvoice } from '../types/models';
import type { TranslationKey } from '../i18n';

export function InvoiceDetailPage() {
  const { id: vorgangId, invoiceId } = useParams<{ id: string; invoiceId: string }>();
  const [searchParams] = useSearchParams();
  const fromOverview = searchParams.get('from') === 'overview';
  const { translate, showToast } = useApp();
  const navigate = useNavigate();

  const [invoice, setInvoice] = useState<VorgangInvoice | undefined>(() =>
    vorgangId && invoiceId ? getVorgangInvoice(vorgangId, invoiceId) : undefined,
  );
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const vorgang = vorgangId ? getVorgangById(vorgangId) : undefined;

  useEffect(() => {
    if (vorgangId && invoiceId) {
      setInvoice(getVorgangInvoice(vorgangId, invoiceId));
      setShowDetails(false);
    }
  }, [vorgangId, invoiceId]);

  const printModel = useMemo(() => {
    if (!invoice || !isFinalizedInvoice(invoice)) return null;
    try {
      return buildInvoicePrintModelFromInvoice(invoice);
    } catch {
      return null;
    }
  }, [invoice]);

  useEffect(() => {
    if (!printModel) return;
    const auto = searchParams.get('auto');
    if (auto === 'print') {
      printInvoice({ title: buildPrintTitle(printModel) });
    }
  }, [printModel, searchParams]);

  const handlePaymentSaved = (updated: VorgangInvoice) => {
    setInvoice(updated);
    if (!getLastPersistSuccess()) {
      showToast(translate('persist.failed.userAction'));
      return;
    }
    showToast(translate(getPaymentSavedToastKey(updated)));
  };

  /**
   * PAYMENT-CLOUD-SAFETY-04B2B2 — der zuletzt bewiesene Cloud-Stand.
   *
   * `null` heißt „unbekannt" und ist der Ausgangszustand: Solange kein Abgleich
   * gelungen ist, behauptet OfficePilot nichts. Ein erfolgreicher Pull setzt
   * eine Liste — **auch eine leere**. Eine frisch angelegte, leere Tabelle ist
   * ein vollständig bekannter Stand, kein Zwischenzustand.
   *
   * Gespeichert werden die Cloud-Kennungen, nicht das Ergebnis des Vergleichs:
   * So hängt der Abgleich nicht an der Objektreferenz der Rechnung, und sein
   * eigenes Ergebnis kann ihn nicht erneut auslösen (04B2B2, Punkt 3).
   */
  const [cloudPaymentIds, setCloudPaymentIds] = useState<string[] | null>(null);
  /** Zählt ausdrücklich gewünschte Abgleiche — nach Sicherung oder Stornierung. */
  const [cloudRefreshToken, setCloudRefreshToken] = useState(0);

  const pullCloudPaymentIds = useCallback(async (currentInvoiceId: string) => {
    const pulled = await pullInvoicePaymentsFromCloud();
    if (pulled.outcome !== 'synced') {
      // Kein Beweis, keine Aussage.
      setCloudPaymentIds(null);
      return null;
    }
    /*
     * Bewusst **alle** Kennungen, auch reversierte: Ein Grabstein beweist,
     * dass die Zahlung in der Cloud bekannt ist. Sie als ungesichert
     * anzubieten würde eine Stornierung wiederbeleben.
     */
    const known = pulled.rows
      .filter((row) => row.clientInvoiceId === currentInvoiceId)
      .map((row) => row.clientPaymentId);
    setCloudPaymentIds(known);
    return known;
  }, []);

  useEffect(() => {
    if (!vorgangId || !invoiceId) return;
    setCloudPaymentIds(null);
    void pullCloudPaymentIds(invoiceId);
    // Bewusst ohne `invoice`: Die Objektreferenz wechselt bei jedem lokalen
    // Commit, der Cloud-Stand hängt aber nur an der Rechnung selbst.
  }, [vorgangId, invoiceId, cloudRefreshToken, pullCloudPaymentIds]);

  /**
   * Abgeleitet statt gespeichert: Der Hinweis folgt dem aktuellen lokalen Stand,
   * ohne dafür einen neuen Abgleich zu brauchen.
   */
  const unsyncedPaymentIds = useMemo(() => {
    if (!invoice || !cloudPaymentIds) return null;
    return findLocallyOnlyPayments(invoice, cloudPaymentIds).map((payment) => payment.id);
  }, [invoice, cloudPaymentIds]);

  /** Überträgt eine vorhandene Zahlung — niemals eine neue. */
  const handleSecurePayment = async (paymentId: string) => {
    if (!invoice) return;
    const payment = getInvoicePayments(invoice).find((item) => item.id === paymentId);
    if (!payment) return;

    const outcome = await syncInvoicePaymentToCloud(invoice.id, payment);
    if (!isInvoicePaymentCloudSynced(outcome)) {
      showToast(translate('payment.cloudOnlyLocal'));
      return;
    }
    showToast(translate('payment.cloudSecured'));
    // Ausdrücklicher Erfolg — hier ist ein neuer Abgleich gewollt.
    setCloudRefreshToken((token) => token + 1);
  };

  /**
   * PAYMENT-CLOUD-DURABILITY-04B2B — erst die Cloud, dann lokal.
   *
   * Umgekehrt entstünde der gefährlichste Zustand: lokal hart entfernt,
   * Cloud-Stornierung fehlgeschlagen — und der nächste Abgleich brächte die
   * Zahlung unangekündigt zurück. Scheitert die Stornierung, bleibt die Zahlung
   * sichtbar stehen und der Nutzer erfährt den Grund.
   *
   * PAYMENT-CLOUD-SAFETY-04B2B2 — verschärft: Früher galt auch
   * `supabase_not_configured` als still in Ordnung. Das war falsch. Eine
   * fehlende Konfiguration beweist nicht, dass keine Cloud-Kopie existiert; sie
   * heißt nur, dass wir nicht nachsehen können. Gelöscht wird lokal nur, wenn
   * die Stornierung **bestätigt** ist — oder wenn ein erfolgreicher Pull
   * beweist, dass diese Kennung in der Cloud gar nicht vorkommt. Das ist der
   * einzige nachweisbare Local-only-Fall; fehlende Konfiguration ist keiner.
   */
  const handleRemovePayment = async (paymentId: string) => {
    if (!vorgangId || !invoiceId) return;

    const outcome = await reverseInvoicePaymentInCloudForRemoval(invoiceId, paymentId);
    if (!isInvoicePaymentCloudSynced(outcome)) {
      const known = await pullCloudPaymentIds(invoiceId);
      if (!known || known.includes(paymentId)) {
        showToast(
          translate(
            isInvoicePaymentCloudSilent(outcome)
              ? 'payment.cloudReversalUnavailable'
              : 'payment.cloudReversalFailed',
          ),
        );
        return;
      }
      // Nachgewiesen: Diese Zahlung existiert in der Cloud nicht und kann
      // deshalb auch nicht zurückkehren.
    }

    const result = removePayment(vorgangId, invoiceId, paymentId);
    if (!result.success) {
      showToast(translate(result.errorKey as never));
      return;
    }
    setInvoice(result.invoice);
    showToast(translate('payment.removedSuccess'));
  };

  if (!vorgangId || !invoiceId || !vorgang || !invoice) {
    return (
      <div className="page">
        <p className="empty-state">{translate('invoice.notFound')}</p>
        <Button variant="outline" onClick={() => navigate(`/vorgaenge/${vorgangId ?? ''}`)}>
          {translate('common.back')}
        </Button>
      </div>
    );
  }

  if (!isFinalizedInvoice(invoice) || !printModel) {
    return (
      <div className="page">
        <p className="empty-state">{translate('invoice.readOnlyMissingSnapshots')}</p>
        <Button variant="outline" onClick={() => navigate(`/vorgaenge/${vorgangId}`)}>
          {translate('common.back')}
        </Button>
      </div>
    );
  }

  const paymentSummary = calculatePaymentSummary(invoice);
  const statusKey = `payment.status.${paymentSummary.status}` as TranslationKey;

  const autoDownloadPdf = searchParams.get('auto') === 'pdf';

  const primaryActions = (
    <>
      <InvoicePrintActions
        invoice={invoice}
        model={printModel}
        translate={translate}
        layout="stack"
        autoDownloadPdf={autoDownloadPdf}
      />
      <InvoiceSentPanel
        vorgangId={vorgangId}
        invoice={invoice}
        translate={translate}
        onUpdated={setInvoice}
      />
      {!isInvoiceCancelled(invoice) && (
        <Button type="button" fullWidth onClick={() => setShowPaymentForm(true)}>
          {translate('detail.action.recordPayment')}
        </Button>
      )}
      <Button
        variant="outline"
        fullWidth
        onClick={() =>
          navigate(`/kommunikation?context=invoice&id=${invoice.id}&vorgangId=${vorgangId}`)
        }
      >
        {translate('detail.action.writeMessage')}
      </Button>
    </>
  );

  const technicalPanels = (
    <>
      {(fromOverview || invoice.archiveDocumentId) && (
        <p className="invoice-detail__archive-link">
          {fromOverview && (
            <>
              <Link to="/rechnungen/offen">{translate('overview.backToOverview')}</Link>
              {invoice.archiveDocumentId && ' · '}
            </>
          )}
          {invoice.archiveDocumentId && (
            <Link to={`/dokumente/${invoice.archiveDocumentId}`}>
              {translate('invoice.openArchiveDocument')}
            </Link>
          )}
        </p>
      )}

      <InvoicePaymentSummary invoice={invoice} translate={translate} />
      <InvoicePaymentHistory
        invoice={invoice}
        translate={translate}
        onRemovePayment={handleRemovePayment}
        unsyncedPaymentIds={unsyncedPaymentIds ?? undefined}
        onSecurePayment={handleSecurePayment}
      />

      <CommunicationIntegrationPanel
        contextRef={{
          type: 'invoice',
          id: invoice.id,
          vorgangId: vorgangId ?? '',
        }}
        buttonKeys={INVOICE_COMMUNICATION_BUTTON_KEYS}
        testIdPrefix="invoice"
      />

      <div className="invoice-detail__document">
        <InvoiceDocumentView model={printModel} />
      </div>

      <p className="hint-text">{translate('invoice.readOnlyHint')}</p>
    </>
  );

  return (
    <div className="page page--invoice-detail" data-testid="invoice-detail-page">
      <div className="invoice-detail__toolbar no-print">
        <button
          type="button"
          className="back-link"
          onClick={() => navigate(fromOverview ? '/rechnungen/offen' : `/vorgaenge/${vorgangId}`)}
        >
          ← {fromOverview ? translate('overview.backToOverview') : translate('common.back')}
        </button>

        <DetailExperienceCard
          recognizedTitle={printModel.documentTitle}
          recognizedSummary={`${printModel.invoiceNumber} · ${vorgang.customer}`}
          assistantMessage={translate('invoice.experience.finalized').replace(
            '{amount}',
            formatPaymentCurrency(paymentSummary.totalDue),
          )}
          highlights={
            paymentSummary.openAmount > 0
              ? [
                  translate('invoice.highlight.openAmount').replace(
                    '{amount}',
                    formatPaymentCurrency(paymentSummary.openAmount),
                  ),
                  translate(statusKey),
                ]
              : [translate(statusKey)]
          }
          actions={primaryActions}
          testId="invoice-detail-experience"
        />

        <ShowMoreSection
          expanded={showDetails}
          onToggle={() => setShowDetails((open) => !open)}
          showLabel={translate('common.showMore')}
          hideLabel={translate('common.showLess')}
          testId="invoice-detail-show-more"
        >
          {technicalPanels}
        </ShowMoreSection>
      </div>

      <InvoicePaymentForm
        vorgangId={vorgangId}
        invoice={invoice}
        open={showPaymentForm}
        onClose={() => setShowPaymentForm(false)}
        onSaved={handlePaymentSaved}
        translate={translate}
      />
    </div>
  );
}
