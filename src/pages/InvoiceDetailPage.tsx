import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocumentView } from '../components/invoice/InvoiceDocumentView';
import { InvoicePrintActions } from '../components/invoice/InvoicePrintActions';
import {
  getPaymentSavedToastKey,
  InvoicePaymentForm,
} from '../components/invoice/InvoicePaymentForm';
import { InvoiceCancelDialog } from '../components/invoice/InvoiceCancelDialog';
import { InvoicePaymentHistory } from '../components/invoice/InvoicePaymentHistory';
import { InvoicePaymentSummary } from '../components/invoice/InvoicePaymentSummary';
import { DetailExperienceCard } from '../components/detail/DetailExperienceCard';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { INVOICE_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { Button } from '../components/ui/Button';
import { ShowMoreSection } from '../components/ui/ShowMoreSection';
import { useApp } from '../context/AppContext';
import { isFinalizedInvoice, buildPrintTitle } from '../services/invoiceArchiveService';
import { buildInvoicePrintModelFromInvoice, formatInvoiceDate } from '../services/invoicePrintModel';
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
import { getVorgangById } from '../services/vorgangService';
import { resolveInvoiceDetailRoute } from '../services/invoice/invoiceDetailRouteResolver';
import { buildInvoiceReachPath, buildOpenInvoicesPath } from '../services/invoiceNavigation';
import { buildInvoiceCorrectionModel } from '../services/invoice/invoiceCorrectionModel';
import { generateInvoiceCorrectionPdf } from '../services/invoicePdfService';
import { InvoiceSentPanel } from '../components/invoice/InvoiceSentPanel';
import {
  readInvoiceSentStateFromCloud,
  type InvoiceSentCloudState,
} from '../services/invoiceSentService';
import { InvoiceServicePeriodConfirmPanel } from '../components/invoice/InvoiceServicePeriodConfirmPanel';
import { readInvoiceServicePeriodConfirmationFromCloud } from '../services/invoice/invoiceServicePeriodConfirmService';
import { validateFinalizedInvoiceForPdf } from '../services/invoiceValidationService';
import type { VorgangInvoice } from '../types/models';
import type { TranslationKey } from '../i18n';

export function InvoiceDetailPage() {
  /*
   * MANUAL-INVOICE-UI-01B2 — eine Seite, zwei Routen. `id` ist nur auf dem
   * Vorgangsweg gesetzt; die globale Route `/rechnungen/:invoiceId` kennt
   * keinen Vorgang in der URL. Der Ablageort kommt aus der Auflösung.
   */
  const { id: routeVorgangId, invoiceId } = useParams<{ id?: string; invoiceId?: string }>();
  const [searchParams] = useSearchParams();
  const fromOverview = searchParams.get('from') === 'overview';
  /** NORMAL-INVOICE-CANCELLATION-01B — `?doc=korrektur` zeigt den Korrekturbeleg. */
  const correctionView = searchParams.get('doc') === 'korrektur';
  const { translate, showToast } = useApp();
  const navigate = useNavigate();

  const resolution = useMemo(
    () => resolveInvoiceDetailRoute({ routeVorgangId, invoiceId }),
    [routeVorgangId, invoiceId],
  );
  /** `null` = freie Rechnung ohne Auftrag; `undefined` = nicht auflösbar. */
  const vorgangId: string | null | undefined =
    resolution.kind === 'found' ? resolution.vorgangId : undefined;

  const [invoice, setInvoice] = useState<VorgangInvoice | undefined>(() =>
    resolution.kind === 'found' ? resolution.invoice : undefined,
  );
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const vorgang = vorgangId ? getVorgangById(vorgangId) : undefined;

  useEffect(() => {
    setInvoice(resolution.kind === 'found' ? resolution.invoice : undefined);
    setShowDetails(false);
  }, [resolution]);

  /** Wohin „Zurück" führt, wenn es keinen Vorgang gibt: die Übersicht. */
  const backPath =
    fromOverview || !vorgangId ? buildOpenInvoicesPath() : `/vorgaenge/${vorgangId}`;

  const printModel = useMemo(() => {
    if (!invoice || !isFinalizedInvoice(invoice)) return null;
    try {
      return buildInvoicePrintModelFromInvoice(invoice);
    } catch {
      return null;
    }
  }, [invoice]);

  useEffect(() => {
    if (!printModel || !invoice) return;
    const auto = searchParams.get('auto');
    if (auto !== 'print') return;
    /*
     * LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B — auch der Direktaufruf über
     * `?auto=print` läuft durch denselben Validator wie das PDF. Ein Link darf
     * kein Weg an einer Prüfung vorbei sein.
     */
    if (validateFinalizedInvoiceForPdf(invoice).blockingErrors.length > 0) return;
    // 01B — in der Korrekturansicht steht das Korrekturdokument im DOM; nur der Titel wechselt.
    if (correctionView) {
      if (invoice.cancellationKind !== 'correction') return;
      printInvoice({ title: `Rechnungskorrektur ${invoice.number}` });
      return;
    }
    printInvoice({ title: buildPrintTitle(printModel) });
  }, [printModel, invoice, searchParams, correctionView]);

  /**
   * LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B — der zuletzt bewiesene
   * Cloud-Stand der Leistungszeitraum-Bestätigung.
   *
   * `null` heißt „unbekannt" und ist der Ausgangszustand. Gelesen wird nur,
   * wenn lokal überhaupt etwas zu sichern ist — eine unbestätigte Rechnung
   * braucht Recovery, keinen Abgleich. Bewusst kein gespeicherter Marker: Der
   * Zustand entsteht jedes Mal neu aus lokalem Wert plus Einzelread und kann
   * deshalb auch nach einem Neustart nicht verloren gehen.
   */
  const [servicePeriodCloudConfirmed, setServicePeriodCloudConfirmed] = useState<boolean | null>(
    null,
  );

  const localServicePeriodConfirmed = invoice?.servicePeriodConfirmed === true;

  useEffect(() => {
    if (!invoiceId || !localServicePeriodConfirmed) {
      setServicePeriodCloudConfirmed(null);
      return;
    }
    let cancelled = false;
    void readInvoiceServicePeriodConfirmationFromCloud(invoiceId).then((state) => {
      if (cancelled) return;
      /*
       * Weder „gesichert" noch „nicht gesichert" ohne Beweis. `missing`,
       * `unknown` und `not_configured` führen alle zu `null`: Im ersten Fall
       * gibt es nichts zu ergänzen, in den anderen keinen Beweis — in keinem
       * darf ein Sicherungsknopf erscheinen (01B2).
       */
      setServicePeriodCloudConfirmed(
        state === 'confirmed' ? true : state === 'not_confirmed' ? false : null,
      );
    });
    return () => {
      cancelled = true;
    };
    // Nach einer Sicherung meldet das Panel den neuen Stand selbst — kein Neulesen nötig.
  }, [invoiceId, localServicePeriodConfirmed]);

  /**
   * INVOICE-SENT-CLOUD-DURABILITY-01B — der abgeleitete Cloud-Versandstand.
   *
   * Anders als beim Leistungszeitraum wird **immer** gelesen, sobald die
   * Rechnung finalisiert ist — nicht nur, wenn lokal etwas zu sichern wäre.
   * Grund: Ein Versand, den es nur in der Cloud gibt, kommt real vor (ein
   * anderes Gerät hat markiert), und genau dieser Fall wäre sonst unsichtbar.
   *
   * Kein gespeicherter Marker: Der Zustand entsteht jedes Mal neu aus lokalem
   * Versandsatz und Einzelread und überlebt deshalb jeden Neustart.
   */
  const [sentCloudState, setSentCloudState] = useState<InvoiceSentCloudState | null>(null);
  const invoiceFinalized = invoice ? isFinalizedInvoice(invoice) : false;

  useEffect(() => {
    // `vorgangId === null` ist die freie Rechnung — auch sie hat einen Versandstand.
    if (vorgangId === undefined || !invoiceId || !invoiceFinalized) {
      setSentCloudState(null);
      return;
    }
    let cancelled = false;
    void readInvoiceSentStateFromCloud(vorgangId, invoiceId).then((state) => {
      if (!cancelled) setSentCloudState(state);
    });
    return () => {
      cancelled = true;
    };
    // Bewusst ohne `invoice`: Die Objektreferenz wechselt bei jedem lokalen
    // Commit; der Cloud-Stand hängt aber nur an der Rechnung selbst.
  }, [vorgangId, invoiceId, invoiceFinalized]);

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
    if (vorgangId === undefined || !invoiceId) return;
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
    if (vorgangId === undefined || !invoiceId) return;

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

  /*
   * Fail closed: nicht auflösbar, Vorgang der alten Route fehlt, oder die
   * Rechnung gehört zu einem anderen Vorgang als die URL behauptet — in allen
   * Fällen dasselbe „nicht gefunden", nie eine andere Rechnung.
   */
  if (vorgangId === undefined || !invoiceId || !invoice || (vorgangId !== null && !vorgang)) {
    return (
      <div className="page" data-testid="invoice-detail-not-found">
        <p className="empty-state">{translate('invoice.notFound')}</p>
        <Button
          variant="outline"
          onClick={() =>
            navigate(routeVorgangId ? `/vorgaenge/${routeVorgangId}` : buildOpenInvoicesPath())
          }
        >
          {translate('common.back')}
        </Button>
      </div>
    );
  }

  if (!isFinalizedInvoice(invoice) || !printModel) {
    return (
      <div className="page">
        <p className="empty-state">{translate('invoice.readOnlyMissingSnapshots')}</p>
        <Button variant="outline" onClick={() => navigate(backPath)}>
          {translate('common.back')}
        </Button>
      </div>
    );
  }

  /** MANUAL-INVOICE-UI-01B2 — die freie Rechnung hat keinen Auftrag. */
  const isFreeInvoice = vorgangId === null;

  const paymentSummary = calculatePaymentSummary(invoice);
  const statusKey = `payment.status.${paymentSummary.status}` as TranslationKey;

  /*
   * FINAL-INVOICE-CANCELLATION-UI-01A — wann die Stornoaktion überhaupt
   * erscheint. Drei Bedingungen, alle drei notwendig; die endgültige Prüfung
   * bleibt beim Server.
   */
  const invoiceCancelled = isInvoiceCancelled(invoice);
  /*
   * NORMAL-INVOICE-CANCELLATION-01B — normale Rechnungen (mit und ohne
   * Auftrag) und Schlussrechnungen; Abschläge bleiben ausgeschlossen. Ohne
   * Auftrag ist nur `rechnung` möglich — dieselbe Regel wie im Server.
   */
  const canCancelInvoice =
    (invoice.type === 'rechnung' || (invoice.type === 'schluss' && vorgangId !== null)) &&
    (invoice.status === 'vorbereitet' || invoice.status === 'versendet') &&
    !invoiceCancelled;

  const autoDownloadPdf = searchParams.get('auto') === 'pdf';
  const correctionPath = `${buildInvoiceReachPath(vorgangId, invoice.id)}?doc=korrektur`;

  /*
   * 01B — die Korrekturansicht: dasselbe Dokument-Rendering mit dem
   * kanonischen Korrekturmodell. Eigener Druck/PDF-Weg, kein Zahlungs-,
   * Versand- oder Stornopanel; Zurück führt zur Originalrechnung.
   */
  if (correctionView) {
    if (invoice.cancellationKind !== 'correction' || !invoice.cancelledAt || !invoice.cancelReason) {
      return (
        <div className="page" data-testid="invoice-correction-not-found">
          <p className="empty-state">{translate('invoice.correction.notFound')}</p>
          <Button variant="outline" onClick={() => navigate(buildInvoiceReachPath(vorgangId, invoice.id))}>
            {translate('invoice.correction.backToOriginal')}
          </Button>
        </div>
      );
    }
    const correctionModel = buildInvoiceCorrectionModel(invoice, {
      cancelledAt: invoice.cancelledAt,
      cancelReason: invoice.cancelReason,
    });
    return (
      <div className="page page--invoice-detail" data-testid="invoice-correction-page">
        <div className="invoice-detail__toolbar no-print">
          <button
            type="button"
            className="back-link"
            onClick={() => navigate(buildInvoiceReachPath(vorgangId, invoice.id))}
            data-testid="invoice-correction-back"
          >
            ← {translate('invoice.correction.backToOriginal')}
          </button>
          <DetailExperienceCard
            recognizedTitle={translate('invoice.correction.title')}
            recognizedSummary={translate('invoice.correction.reference')
              .replace('{number}', invoice.number)
              .replace('{date}', formatInvoiceDate(invoice.issueDate ?? invoice.date))}
            assistantMessage={`${translate('invoice.correction.reasonLabel')}: ${invoice.cancelReason}`}
            highlights={[
              `${translate('invoice.correction.issueDate')}: ${formatInvoiceDate(correctionModel.issueDate)}`,
              formatPaymentCurrency(correctionModel.summary.grossTotal),
            ]}
            actions={
              <InvoicePrintActions
                invoice={invoice}
                model={correctionModel}
                translate={translate}
                layout="stack"
                autoDownloadPdf={autoDownloadPdf}
                generatePdf={generateInvoiceCorrectionPdf}
              />
            }
            testId="invoice-correction-experience"
          />
          {invoice.correctionArchiveDocumentId ? (
            <p className="invoice-detail__archive-link">
              <Link
                to={`/dokumente/${invoice.correctionArchiveDocumentId}`}
                data-testid="invoice-correction-archive-link"
              >
                {translate('invoice.openArchiveDocument')}
              </Link>
            </p>
          ) : null}
        </div>
        <div className="invoice-detail__document invoice-print-document" data-testid="invoice-correction-document">
          <InvoiceDocumentView model={correctionModel} />
        </div>
      </div>
    );
  }

  const primaryActions = (
    <>
      {/*
        * LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B — vor den Ausgabeaktionen:
        * Solange der Leistungszeitraum unbestätigt ist, sind Druck und PDF
        * gesperrt, und hier steht der Weg, das zu ändern.
        */}
      <InvoiceServicePeriodConfirmPanel
        vorgangId={vorgangId}
        invoice={invoice}
        cloudConfirmed={servicePeriodCloudConfirmed}
        translate={translate}
        onUpdated={setInvoice}
        onCloudStateChange={setServicePeriodCloudConfirmed}
      />
      <InvoicePrintActions
        invoice={invoice}
        model={printModel}
        translate={translate}
        layout="stack"
        autoDownloadPdf={autoDownloadPdf}
      />
      {/*
        * FINAL-INVOICE-CANCELLATION-UI-01A — der Storno steht **über** dem
        * Versandpanel und ersetzt es nicht: „versendet" bleibt ein Faktum der
        * Vergangenheit, auch wenn die Rechnung danach storniert wurde.
        */}
      {invoiceCancelled && (
        <section className="invoice-cancelled-panel" data-testid="invoice-cancelled-panel">
          <p className="invoice-hint invoice-hint--warning" data-testid="invoice-cancelled-notice">
            {translate('invoice.cancel.cancelledNotice')}
          </p>
          {invoice.cancelledAt ? (
            <div className="data-row" data-testid="invoice-cancelled-at">
              <span className="data-row__label">{translate('invoice.cancel.cancelledAt')}</span>
              <span className="data-row__value">{invoice.cancelledAt.slice(0, 10)}</span>
            </div>
          ) : null}
          {invoice.cancelReason ? (
            <div className="data-row" data-testid="invoice-cancelled-reason">
              <span className="data-row__label">{translate('invoice.cancel.cancelledReason')}</span>
              <span className="data-row__value">{invoice.cancelReason}</span>
            </div>
          ) : null}
          {/*
            * NORMAL-INVOICE-CANCELLATION-01B — Art des Stornos und, nach
            * Versand, der Weg zum Korrekturbeleg. Fehlt die lokale Projektion
            * noch (Cloud vollständig, Pull steht aus), sagt die Seite das —
            * sie erfindet keinen Link.
            */}
          {invoice.cancellationKind ? (
            <div className="data-row" data-testid={`invoice-cancelled-kind-${invoice.cancellationKind}`}>
              <span className="data-row__label">{translate('invoice.cancel.kindLabel')}</span>
              <span className="data-row__value">
                {translate(
                  invoice.cancellationKind === 'correction'
                    ? 'invoice.cancel.kind.correction'
                    : 'invoice.cancel.kind.internal',
                )}
              </span>
            </div>
          ) : null}
          {invoice.cancellationKind === 'correction' ? (
            <Button
              type="button"
              variant="outline"
              fullWidth
              onClick={() => navigate(correctionPath)}
              data-testid="invoice-open-correction"
            >
              {translate('invoice.cancel.openCorrection')}
            </Button>
          ) : null}
          {invoice.cancellationKind === 'correction' && !invoice.correctionArchiveDocumentId ? (
            <p className="hint-text" data-testid="invoice-correction-archive-pending">
              {translate('invoice.cancel.correctionPending')}
            </p>
          ) : null}
        </section>
      )}
      <InvoiceSentPanel
        vorgangId={vorgangId}
        invoice={invoice}
        translate={translate}
        onUpdated={setInvoice}
        cloudState={sentCloudState}
        onCloudStateChange={setSentCloudState}
      />
      {!isInvoiceCancelled(invoice) && (
        <Button type="button" fullWidth onClick={() => setShowPaymentForm(true)}>
          {translate('detail.action.recordPayment')}
        </Button>
      )}
      {/*
        * MANUAL-INVOICE-UI-01B2 — der Kommunikationskontext einer Rechnung
        * braucht fachlich einen Vorgang (`communicationContextService`). Ohne
        * ihn wird die Aktion nicht mit einer erfundenen Kennung aufgerufen,
        * sondern bleibt weg; E-Mail-Versand ist ein späterer Block.
        */}
      {isFreeInvoice ? (
        <p className="hint-text" data-testid="invoice-communication-unavailable">
          {translate('invoice.communicationNeedsVorgang')}
        </p>
      ) : (
        <Button
          variant="outline"
          fullWidth
          onClick={() =>
            navigate(`/kommunikation?context=invoice&id=${invoice.id}&vorgangId=${vorgangId}`)
          }
        >
          {translate('detail.action.writeMessage')}
        </Button>
      )}
      {/*
        * FINAL-INVOICE-CANCELLATION-UI-01A — Stornierung, bewusst als letzte
        * Aktion und optisch als destruktiv gekennzeichnet.
        *
        * Sichtbar nur für eine **freigegebene Schlussrechnung, die noch nicht
        * storniert ist**. Entwürfe, Abschläge und andere Belegarten bieten sie
        * gar nicht erst an; der Server weist sie zusätzlich ab
        * (`invoice_cancel_type_not_supported`). Der Klick storniert nichts — er
        * öffnet den Bestätigungsdialog.
        */}
      {canCancelInvoice && (
        <Button
          variant="danger"
          fullWidth
          onClick={() => setShowCancelDialog(true)}
          data-testid="invoice-cancel-action"
        >
          {translate('invoice.cancel.action')}
        </Button>
      )}
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
            <Link
              to={`/dokumente/${invoice.archiveDocumentId}`}
              data-testid="invoice-detail-archive-link"
            >
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

      {!isFreeInvoice && (
        <CommunicationIntegrationPanel
          contextRef={{
            type: 'invoice',
            id: invoice.id,
            vorgangId,
          }}
          buttonKeys={INVOICE_COMMUNICATION_BUTTON_KEYS}
          testIdPrefix="invoice"
        />
      )}

      <p className="hint-text">{translate('invoice.readOnlyHint')}</p>
    </>
  );

  return (
    <div className="page page--invoice-detail" data-testid="invoice-detail-page">
      <div className="invoice-detail__toolbar no-print">
        <button
          type="button"
          className="back-link"
          onClick={() => navigate(backPath)}
          data-testid="invoice-detail-back"
        >
          ←{' '}
          {fromOverview || isFreeInvoice
            ? translate('overview.backToOverview')
            : translate('common.back')}
        </button>

        <DetailExperienceCard
          recognizedTitle={printModel.documentTitle}
          recognizedSummary={`${printModel.invoiceNumber} · ${
            vorgang ? vorgang.customer : printModel.customer.name
          }`}
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

      {/*
        * INVOICE-MOBILE-PRINT-RENDERING-01B — das Rechnungsdokument steht
        * **ausserhalb** der Werkzeugleiste und **ausserhalb** von
        * `ShowMoreSection`.
        *
        * Beides war nötig: `ShowMoreSection` rendert eingeklappt gar keine
        * Kinder, und `.invoice-detail__toolbar.no-print` wird im Druck auf
        * `display:none` gesetzt — ein Nachfahre davon ist unrettbar. Solange
        * das Dokument dort hing, druckte Safari die App statt der Rechnung.
        *
        * Am Bildschirm bleibt die bisherige UX: sichtbar erst über „Mehr
        * anzeigen". Neu ist nur, dass die **DOM-Präsenz** davon nicht mehr
        * abhängt — die Sichtbarkeit steuert CSS, nicht das Rendern.
        */}
      <div
        className={`invoice-detail__document invoice-print-document${
          showDetails ? '' : ' invoice-print-document--screen-hidden'
        }`}
        data-testid="invoice-print-document"
      >
        <InvoiceDocumentView model={printModel} />
      </div>

      <InvoicePaymentForm
        vorgangId={vorgangId}
        invoice={invoice}
        open={showPaymentForm}
        onClose={() => setShowPaymentForm(false)}
        onSaved={handlePaymentSaved}
        translate={translate}
      />

      {/*
        * Der Dialog wird nur montiert, wenn die Aktion fachlich zulässig ist.
        * Damit gibt es keinen Weg, ihn über einen Zustandsrest an einer
        * Rechnung zu öffnen, die gar nicht stornierbar ist.
        */}
      {canCancelInvoice && (
        <InvoiceCancelDialog
          vorgangId={vorgangId}
          invoice={invoice}
          open={showCancelDialog}
          onClose={() => setShowCancelDialog(false)}
          onCancelled={(updated, outcome) => {
            setInvoice(updated);
            // 01B — ein Replay überschreibt nichts; der Nutzer erfährt es.
            if (outcome?.alreadyCancelled) showToast(translate('invoice.cancel.alreadyCancelled'));
          }}
          translate={translate}
        />
      )}
    </div>
  );
}
