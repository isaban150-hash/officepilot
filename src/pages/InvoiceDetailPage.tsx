import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveCloudConfirmedActionAccess } from '../services/workspace/workspaceRoleService';
import { releaseReconciliationForPayment } from '../services/bank/bankReconciliationStore';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocumentView } from '../components/invoice/InvoiceDocumentView';
import { InvoicePrintActions } from '../components/invoice/InvoicePrintActions';
import { EInvoicePanel } from '../components/invoice/EInvoicePanel';
import { XRechnungPanel } from '../components/invoice/XRechnungPanel';
import { Card } from '../components/ui/Card';
import {
  getPaymentSavedToastKey,
  InvoicePaymentForm,
} from '../components/invoice/InvoicePaymentForm';
import { InvoiceCancelDialog } from '../components/invoice/InvoiceCancelDialog';
import {
  canOfferInvoiceCancel,
  findFinalInvoiceBlockingPaymentReversal,
} from '../services/invoice/invoiceCancelEligibility';
import { InvoicePaymentHistory } from '../components/invoice/InvoicePaymentHistory';
import { InvoicePaymentSummary } from '../components/invoice/InvoicePaymentSummary';
import { AccountingAssignmentPanel } from '../components/accounting/AccountingAssignmentPanel';
import { ensureInvoiceAccountingAssignment } from '../services/accounting/accountingAssignmentService';
import { getAccountingAssignmentForSource } from '../services/accounting/accountingStore';
import { DetailSection as AccountingSection } from '../components/ui/Section';
import { DetailExperienceCard } from '../components/detail/DetailExperienceCard';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { buildKommunikationPath } from '../components/communication/communicationNavigation';
import {
  canDocumentDunningForInvoice,
  formatDunningKindLabel,
  getLatestDunningDocumentation,
} from '../services/dunningDocumentationService';
import { INVOICE_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { Button } from '../components/ui/Button';
import { ShowMoreSection } from '../components/ui/ShowMoreSection';
import { StatusBadge } from '../components/ui/Badge';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { PageHeader } from '../components/ui/PageHeader';
import { DetailSection } from '../components/ui/Section';
import { paymentStatusTone } from '../services/ui/statusTone';
import { useApp } from '../context/AppContext';
import { isFinalizedInvoice, buildPrintTitle } from '../services/invoiceArchiveService';
import { buildInvoicePrintModelFromInvoice, formatInvoiceDate } from '../services/invoicePrintModel';
import { resolveInvoiceNet } from '../services/invoice/invoiceNetResolution';
import { InvoiceNetUnresolvedNotice } from '../components/invoice/InvoiceNetUnresolvedNotice';
import {
  acknowledgeInvoicePaymentOverpayment,
  calculatePaymentSummary,
  canRecordInvoicePayment,
  discardRejectedInvoicePayment,
  formatPaymentCurrency,
  findLocallyOnlyPayments,
  getInvoicePayments,
  getRejectedInvoicePayments,
  isInvoiceCancelled,
  isInvoicePaymentCloudSynced,
  isRejectedInvoicePaymentOutcome,
  quarantineRejectedInvoicePayment,
  removePayment,
  restoreRejectedInvoicePaymentAsOverpayment,
  reverseInvoicePaymentInCloudForRemoval,
  syncInvoicePaymentToCloud,
} from '../services/invoicePaymentService';
import {
  isInvoicePaymentCloudSilent,
  pullInvoicePaymentsFromCloud,
} from '../services/invoice/workspaceInvoicePaymentCloudService';
import {
  getInvoicePaymentResyncBlocks,
  isFinalInvoicePaymentResyncOutcome,
  markInvoicePaymentResyncNeeded,
  recordInvoicePaymentResyncBlock,
  releaseInvoicePaymentResyncConflict,
  subscribeInvoicePaymentResyncBlocks,
} from '../services/invoice/invoicePaymentCloudResyncService';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { formatDisplayDate, formatEuroAmount } from '../utils/displayFormat';
import { getLastPersistSuccess, persistAll } from '../services/persistenceService';
import { printInvoice } from '../services/invoicePrintService';
import { getVorgangById } from '../services/vorgangService';
import { resolveInvoiceDetailRoute } from '../services/invoice/invoiceDetailRouteResolver';
import { buildInvoiceDetailHighlights } from '../services/invoice/invoiceDetailHighlights';
import { buildInvoiceReachPath, buildOpenInvoicesPath } from '../services/invoiceNavigation';
import { buildInvoiceCorrectionModel } from '../services/invoice/invoiceCorrectionModel';
import { generateInvoiceCorrectionPdf } from '../services/invoicePdfService';
import { InvoiceSentPanel } from '../components/invoice/InvoiceSentPanel';
import { InvoiceDeliveryPanel } from '../components/invoice/InvoiceDeliveryPanel';
import {
  alignInvoiceSentWithCloudForMember,
  readInvoiceSentStateFromCloud,
  type InvoiceSentCloudState,
} from '../services/invoiceSentService';
import { InvoiceServicePeriodConfirmPanel } from '../components/invoice/InvoiceServicePeriodConfirmPanel';
import {
  alignServicePeriodConfirmationForMember,
  readInvoiceServicePeriodConfirmationFromCloud,
} from '../services/invoice/invoiceServicePeriodConfirmService';
import {
  hasServicePeriodCloudProof,
  recordServicePeriodCloudProofs,
  resolveActiveCloudWorkspaceId,
  resolveInvoiceOutputHold,
} from '../services/invoice/invoiceOutputClearance';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';
import { useOptionalAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { validateFinalizedInvoiceForPdf } from '../services/invoiceValidationService';
import type { VorgangInvoice } from '../types/models';
import type { TranslationKey } from '../i18n';
import { toBusinessDay } from '../services/businessDateService';
import { formatDisplayDatePadded } from '../utils/displayFormat';

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
  /*
   * GO-LIVE-SECURITY-01 — wer die Seite bedient. Auf dem Gerät eines Mitglieds
   * gleicht sie Versand und Leistungszeitraum nach dem Cloud-Read an (siehe
   * `invoiceMemberAlignment`); die Panels zeigen dann einen Hinweis.
   */
  const authUserId = useOptionalAuth()?.user?.id ?? null;
  const cloudConfigured = isSupabaseConfigured();
  const [sentRoleAligned, setSentRoleAligned] = useState(false);
  const [servicePeriodRoleAligned, setServicePeriodRoleAligned] = useState(false);

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

  /*
   * FINANZ-CORE-01A (KUN-12) — Kopf und Karte nennen den Empfänger des Belegs (eingefrorener
   * Snapshot), nicht den heutigen Auftragskunden; nur ein Altbeleg ohne Namen fällt zurück.
   */
  const belegEmpfaenger = printModel?.customer.name?.trim() || vorgang?.customer || '';

  /*
   * GO-LIVE-SECURITY-01 — ohne Schreibrecht gibt eine lokale Bestätigung des
   * Leistungszeitraums Druck, PDF und ZUGFeRD erst frei, wenn die Cloud sie
   * nachweislich trägt (siehe `invoiceOutputClearance`). Inhaber, Verwaltung
   * und der lokale Betrieb bleiben beim lokalen Stand, auch offline.
   */
  const [servicePeriodProofCheckedFor, setServicePeriodProofCheckedFor] = useState<string | null>(null);
  const [servicePeriodProofToken, setServicePeriodProofToken] = useState(0);
  const retryServicePeriodProof = useCallback(() => setServicePeriodProofToken((token) => token + 1), []);
  /*
   * GO-LIVE-SECURITY-01 / ABSCHLUSS — dieselbe Rollenauskunft für Ausgabe und
   * Geld: Zahlung erfassen, Storno, Kontierung und das Sichern lokaler Zahlungen
   * bietet die Seite nur Inhaber, Verwaltung und dem lokalen Betrieb an. Der
   * Server weist Mitglieder ohnehin ab (finance_forbidden_role); ohne diese
   * Sperre zeigte ein Mitgliedsgerät einen Scheinerfolg.
   */
  const writeAccess = resolveWorkspaceWriteAccess({ userId: authUserId, cloudConfigured });
  // EINRICHTUNG-01 (AP2, Vertrag 1.11) — zusätzlich gesperrt, solange die Rechte nur aus dem Zwischenspeicher stammen.
  const darfFinanzen = resolveCloudConfirmedActionAccess(writeAccess);
  const outputHold = invoice
    ? resolveInvoiceOutputHold({
        access: writeAccess,
        localConfirmed: invoice.servicePeriodConfirmed === true,
        proven: hasServicePeriodCloudProof(resolveActiveCloudWorkspaceId(), invoice.id),
        cloudCheckDone: servicePeriodProofCheckedFor === invoice.id,
      })
    : null;
  /*
   * GO-LIVE-SECURITY-01 / ABSCHLUSS — der Druck über das Browsermenü (Strg+P, Teilen →
   * Drucken) folgt derselben Regel wie der Druckknopf: Ausgabesperre oder ein Blocker des
   * PDF-Validators (etwa ein unbestätigter Leistungszeitraum). Das Rechnungsdokument bleibt
   * am Bildschirm sichtbar; gedruckt wird statt seiner ein Hinweis (index.css).
   */
  const printBlocked = invoice
    ? Boolean(outputHold) || validateFinalizedInvoiceForPdf(invoice).blockingErrors.length > 0
    : false;
  const printBlockedClass = printBlocked ? ' invoice-print-document--print-blocked' : '';
  const printBlockedNotice = printBlocked ? (
    <p className="invoice-print-blocked-notice" data-testid="invoice-print-blocked-notice">
      {translate('invoice.print.blockedNotice')}
    </p>
  ) : null;

  /*
   * FINANZ-CORE-01A (AUS-05) — `?auto=print` druckt genau einmal je Rechnung und
   * Ansicht. Ohne diesen Schutz lief der Effekt bei jeder neuen Rechnungskopie
   * erneut (Zahlung, Versandvermerk, Cloud-Abgleich; unter StrictMode doppelt):
   * Es öffneten sich zweite und dritte Druckdialoge.
   */
  const autoPrintedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!printModel || !invoice) return;
    const auto = searchParams.get('auto');
    if (auto !== 'print') return;
    const autoPrintKey = `${invoice.id}:${correctionView ? 'korrektur' : 'rechnung'}`;
    if (autoPrintedRef.current === autoPrintKey) return;
    // GO-LIVE-SECURITY-01 — auch der Direktaufruf wartet auf den Nachweis.
    if (outputHold) return;
    /*
     * LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B — auch der Direktaufruf über
     * `?auto=print` läuft durch denselben Validator wie das PDF. Ein Link darf
     * kein Weg an einer Prüfung vorbei sein.
     */
    if (validateFinalizedInvoiceForPdf(invoice).blockingErrors.length > 0) return;
    // 01B — in der Korrekturansicht steht das Korrekturdokument im DOM; nur der Titel wechselt.
    if (correctionView) {
      if (invoice.cancellationKind !== 'correction') return;
      autoPrintedRef.current = autoPrintKey;
      printInvoice({ title: `Rechnungskorrektur ${invoice.number}` });
      return;
    }
    autoPrintedRef.current = autoPrintKey;
    printInvoice({ title: buildPrintTitle(printModel) });
  }, [printModel, invoice, searchParams, correctionView, outputHold]);

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
    setServicePeriodProofCheckedFor(null);
    if (!invoiceId || !localServicePeriodConfirmed) {
      setServicePeriodCloudConfirmed(null);
      return;
    }
    let cancelled = false;
    void readInvoiceServicePeriodConfirmationFromCloud(invoiceId).then((state) => {
      if (cancelled) return;
      const actor = { userId: authUserId, cloudConfigured };
      /*
       * GO-LIVE-SECURITY-01 — der Nachweis für die Ausgabe ohne Schreibrecht.
       * Auf dem Gerät von Inhaber und Verwaltung wird nichts vermerkt.
       */
      if (state === 'confirmed' && !resolveWorkspaceWriteAccess(actor).canWrite) {
        recordServicePeriodCloudProofs(resolveActiveCloudWorkspaceId(), [invoiceId]);
      }
      setServicePeriodProofCheckedFor(invoiceId);
      /*
       * GO-LIVE-SECURITY-01 — Gerät eines Mitglieds: Trägt die Cloud die
       * Bestätigung nachweislich nicht, ist die lokale nicht freigegeben. Sie
       * wird zurückgenommen, bevor sie PDF oder Druck freigibt.
       */
      if (vorgangId !== undefined) {
        const angeglichen = alignServicePeriodConfirmationForMember(vorgangId, invoiceId, state, actor);
        if (angeglichen) {
          setInvoice(angeglichen);
          setServicePeriodRoleAligned(true);
          setServicePeriodCloudConfirmed(null);
          return;
        }
      }
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
  }, [invoiceId, localServicePeriodConfirmed, vorgangId, authUserId, cloudConfigured, servicePeriodProofToken]);

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
    void readInvoiceSentStateFromCloud(vorgangId, invoiceId).then(async (state) => {
      if (cancelled) return;
      /*
       * GO-LIVE-SECURITY-01 — Gerät eines Mitglieds: Ein Versandstand, den die
       * Cloud nicht trägt, ist nicht freigegeben. Es gilt der Cloud-Stand,
       * bevor er hier eine Mahnung oder andere Folgeaktion freigibt.
       */
      if (state.kind === 'pending' || state.kind === 'conflict') {
        const angeglichen = await alignInvoiceSentWithCloudForMember(vorgangId, invoiceId, {
          userId: authUserId,
          cloudConfigured,
        });
        if (cancelled) return;
        if (angeglichen) {
          setInvoice(angeglichen);
          setSentRoleAligned(true);
          setSentCloudState({ kind: 'synced' });
          return;
        }
      }
      setSentCloudState(state);
    });
    return () => {
      cancelled = true;
    };
    // Bewusst ohne `invoice`: Die Objektreferenz wechselt bei jedem lokalen
    // Commit; der Cloud-Stand hängt aber nur an der Rechnung selbst.
  }, [vorgangId, invoiceId, invoiceFinalized, authUserId, cloudConfigured]);

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
  /* STEUERBERATER-06A — laesst die Kontierung neu lesen; kein zweiter Bestand. */
  const [accountingToken, setAccountingToken] = useState(0);

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

  /*
   * FINANZ-CORE-01A (WEISS-Nacharbeit N01) — endgültig abgewiesene Zahlungen tragen einen
   * dauerhaften Vermerk; der Hinweis an der Zahlung nennt den Grund. Neu gelesen nach jeder
   * eigenen Sicherung und jedem Abgleich.
   */
  const [resyncBlockVersion, setResyncBlockVersion] = useState(0);
  const resyncBlocks = useMemo(
    () => (invoiceId ? getInvoicePaymentResyncBlocks(invoiceId) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- neu gelesen auf Signal, nicht auf Objektwechsel
    [invoiceId, resyncBlockVersion, cloudPaymentIds],
  );
  // Auch ein Vermerk des Hintergrundlaufs (nach dem Start, nach einem Abgleich) erscheint sofort.
  useEffect(() => subscribeInvoicePaymentResyncBlocks(() => setResyncBlockVersion((version) => version + 1)), []);

  /**
   * FINANZ-CORE-01A (SQL-05/ZAH-02) — Zahlung, die der Server als unbestätigte
   * Überzahlung abwies. Der Nutzer entscheidet: doppelt erfasst (entfernen) oder echte
   * Überzahlung (bestätigen).
   */
  const [overpaymentQuestionId, setOverpaymentQuestionId] = useState<string | null>(null);

  /** Überträgt eine vorhandene Zahlung — niemals eine neue. */
  const handleSecurePayment = async (paymentId: string, current: VorgangInvoice | undefined = invoice) => {
    if (!current) return;
    const payment = getInvoicePayments(current).find((item) => item.id === paymentId);
    if (!payment) return;

    /*
     * FINANZ-CORE-01A (WEISS-Nacharbeit N01) — „Sichern" ist die bewusste neue Handlung:
     * Ein früherer Vermerk dieser Zahlung fällt. Weist der Server erneut endgültig ab,
     * wird das wieder dauerhaft vermerkt — der Hintergrunddienst sendet sie dann nicht
     * still, auch nicht nach einem Neustart oder Rechtewechsel.
     */
    releaseInvoicePaymentResyncConflict(current.id, paymentId);
    const outcome = await syncInvoicePaymentToCloud(current.id, payment);
    if (!isInvoicePaymentCloudSynced(outcome)) {
      if (isFinalInvoicePaymentResyncOutcome(outcome)) {
        recordInvoicePaymentResyncBlock(current.id, paymentId, outcome);
      } else {
        // FINANZ-CORE-01A (ZAH-02) — Netz oder Server: der nächste erfolgreiche Abgleich versucht es erneut.
        markInvoicePaymentResyncNeeded();
      }
      /*
       * FINANZ-CORE-01A (END18-R3) — fachlich abgewiesen heißt: Der Server kennt diese Zahlung nicht. Sie
       * verliert ihre Finanzwirkung und steht als abgewiesen da, bis der Nutzer entscheidet.
       */
      if (isRejectedInvoicePaymentOutcome(outcome) && vorgangId !== undefined) {
        const abgewiesen = quarantineRejectedInvoicePayment(vorgangId, current.id, paymentId, outcome);
        if (abgewiesen.success) setInvoice(abgewiesen.invoice);
      }
      setResyncBlockVersion((version) => version + 1);
      if (outcome === 'overpayment_unconfirmed') {
        setOverpaymentQuestionId(paymentId);
        return;
      }
      /* R1-SEC-01 — Ablehnung beim Namen nennen, statt sie als Netzproblem auszugeben. */
      showToast(
        translate(
          outcome === 'denied'
            ? 'payment.cloudDenied'
            : outcome === 'conflict'
              ? 'payment.cloudConflict'
              : outcome === 'invoice_cancelled'
                ? 'payment.cloudInvoiceCancelled'
                : outcome === 'final_invoice_exists'
                  ? 'payment.cloudFinalInvoiceExists'
                  : outcome === 'skonto_deadline_unclear'
                    ? 'payment.cloudSkontoDeadlineUnclear'
                    : 'payment.cloudOnlyLocal',
        ),
      );
      return;
    }
    showToast(translate('payment.cloudSecured'));
    setResyncBlockVersion((version) => version + 1);
    // Ausdrücklicher Erfolg — hier ist ein neuer Abgleich gewollt.
    setCloudRefreshToken((token) => token + 1);
  };

  const handleAcknowledgeOverpayment = async (paymentId: string) => {
    if (vorgangId === undefined || !invoiceId) return;
    // END18-R3 — eine abgewiesene Zahlung kehrt erst mit der bewussten Bestätigung zurück und wird gesendet.
    const abgewiesen = invoice ? getRejectedInvoicePayments(invoice).some((entry) => entry.id === paymentId) : false;
    const result = abgewiesen
      ? restoreRejectedInvoicePaymentAsOverpayment(vorgangId, invoiceId, paymentId)
      : acknowledgeInvoicePaymentOverpayment(vorgangId, invoiceId, paymentId);
    if (!result.success) {
      showToast(translate(result.errorKey as never));
      return;
    }
    setInvoice(result.invoice);
    releaseInvoicePaymentResyncConflict(invoiceId, paymentId);
    await handleSecurePayment(paymentId, result.invoice);
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
  /** END18-R3 — der Nutzer verwirft eine abgewiesene Zahlung bewusst; der Server kannte sie nie. */
  const handleDiscardRejectedPayment = (paymentId: string) => {
    if (vorgangId === undefined || !invoiceId) return;
    const result = discardRejectedInvoicePayment(vorgangId, invoiceId, paymentId);
    if (!result.success) {
      showToast(translate(result.errorKey as never));
      return;
    }
    releaseInvoicePaymentResyncConflict(invoiceId, paymentId);
    setInvoice(result.invoice);
    setResyncBlockVersion((version) => version + 1);
  };

  const handleRemovePayment = async (paymentId: string) => {
    if (vorgangId === undefined || !invoiceId) return;
    // FC01A-Nacharbeit (A2) — vor dem Serveraufruf: Die Schlussrechnung hält diese Abschlagszahlung fest.
    if (invoice && findFinalInvoiceBlockingPaymentReversal(vorgangId, invoice)) {
      showToast(translate('payment.reverseBlockedByFinalInvoice'));
      return;
    }

    const outcome = await reverseInvoicePaymentInCloudForRemoval(invoiceId, paymentId);
    if (!isInvoicePaymentCloudSynced(outcome)) {
      const known = await pullCloudPaymentIds(invoiceId);
      if (!known || known.includes(paymentId)) {
        showToast(
          translate(
            outcome === 'denied'
              ? 'payment.cloudReversalDenied'
              : isInvoicePaymentCloudSilent(outcome)
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
    /*
     * BLOCK 5 — die Bankzuordnung faellt mit der Zahlung. Serverseitig
     * geschieht das in derselben Transaktion wie der Storno; hier faellt sie
     * im selben Augenblick auf dem Geraet, damit die Bankbewegung nicht bis
     * zum naechsten Abzug weiter „Zugeordnet“ zeigt.
     */
    // FINANZ-CORE-01A (ZAH-20) — die Freigabe auch dauerhaft, nicht nur im Arbeitsspeicher.
    if (releaseReconciliationForPayment(paymentId) > 0) persistAll();
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
        <EmptyStateBlock
          title={translate('invoice.notFound')}
          description=""
          actions={
            <Button
              variant="outline"
              onClick={() =>
                navigate(routeVorgangId ? `/vorgaenge/${routeVorgangId}` : buildOpenInvoicesPath())
              }
            >
              {translate('common.back')}
            </Button>
          }
        />
      </div>
    );
  }

  /*
   * FC01A-P1-Restkorrektur (lokaler Altbestand) — ohne verlässliches Netto gibt es kein Druckmodell.
   * Statt „kann nicht angezeigt werden" stehen hier die festen Angaben und der Berichtigungsweg.
   */
  if (isFinalizedInvoice(invoice) && invoice.companySnapshot && invoice.customerSnapshot && !resolveInvoiceNet(invoice).ok) {
    return <InvoiceNetUnresolvedNotice invoice={invoice} translate={translate} onBack={() => navigate(backPath)} />;
  }

  if (!isFinalizedInvoice(invoice) || !printModel) {
    return (
      <div className="page">
        <EmptyStateBlock
          title={translate('invoice.readOnlyMissingSnapshots')}
          description=""
          actions={
            <Button variant="outline" onClick={() => navigate(backPath)}>
              {translate('common.back')}
            </Button>
          }
        />
      </div>
    );
  }

  /** MANUAL-INVOICE-UI-01B2 — die freie Rechnung hat keinen Auftrag. */
  const isFreeInvoice = vorgangId === null;

  const paymentSummary = calculatePaymentSummary(invoice);
  const statusKey = `payment.status.${paymentSummary.status}` as TranslationKey;

  /*
   * PAYMENT-REMINDER-WITHOUT-VORGANG-01 — Mahnen hängt an der Rechnung, nicht
   * am Auftrag. Die Aktion erscheint nur, wenn der Dienst sie auch annehmen
   * würde (versendet, nicht storniert, offener Betrag); der dokumentierte
   * Stand steht beim Zahlungsstand, damit er nach der Dokumentation sichtbar
   * bleibt. Der Weg führt in den bestehenden Kommunikationsbereich — ohne
   * Auftrag entfällt lediglich der `vorgangId`-Parameter.
   */
  const canRemind = canDocumentDunningForInvoice(invoice);
  const latestDunning = getLatestDunningDocumentation(vorgangId ?? null, invoice.id);
  const reminderPath = buildKommunikationPath(
    vorgangId ? { type: 'invoice', id: invoice.id, vorgangId } : { type: 'invoice', id: invoice.id },
  );

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
  /*
   * TEILRECHNUNG-03C — die Teilrechnung ist eine echte Forderung und verbraucht
   * abgerechnete Menge. Sie muss sich wie jede Rechnung zurückholen lassen;
   * ohne Auftrag gibt es sie ohnehin nicht.
   *
   * RECHNUNGSBEREICH-03D — dasselbe gilt für die Abschlagsrechnung: Der
   * mengenbasierte Abschlag verbraucht Menge, der pauschale nimmt Geld vorweg,
   * das die Schlussrechnung abzieht. Beides muss sich zurücknehmen lassen.
   */
  // FINANZ-CORE-01A — dieselbe Regel, die der Test prüft (invoiceCancelEligibility).
  const canCancelInvoice = canOfferInvoiceCancel(invoice, vorgangId) && !invoiceCancelled;
  // FC01A-Nacharbeit (A2) — hinter einer wirksamen Schlussrechnung keine Rücknahme der Abschlagszahlung.
  const paymentReversalBlocked = findFinalInvoiceBlockingPaymentReversal(vorgangId, invoice) !== null;

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
          <EmptyStateBlock
            title={translate('invoice.correction.notFound')}
            description=""
            actions={
              <Button variant="outline" onClick={() => navigate(buildInvoiceReachPath(vorgangId, invoice.id))}>
                {translate('invoice.correction.backToOriginal')}
              </Button>
            }
          />
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
          <PageHeader
            title={translate('invoice.correction.title')}
            subtitle={translate('invoice.correction.reference')
              .replace('{number}', invoice.number)
              .replace('{date}', formatInvoiceDate(invoice.issueDate ?? invoice.date))}
            backLabel={translate('invoice.correction.backToOriginal')}
            backHref={buildInvoiceReachPath(vorgangId, invoice.id)}
            backTestId="invoice-correction-back"
          />
          <DetailExperienceCard
            recognizedTitle={translate('invoice.correction.title')}
            recognizedSummary={translate('invoice.correction.reference')
              .replace('{number}', invoice.number)
              .replace('{date}', formatInvoiceDate(invoice.issueDate ?? invoice.date))}
            assistantMessage={`${translate('invoice.correction.reasonLabel')}: ${invoice.cancelReason}`}
            /*
             * FINANZ-CORE-01A (WEISS-Nacharbeit N12) — der operative Betrag der Korrektur ist ihr
             * Zahlbetrag. Bei einer Schlussrechnung mit Abzügen stand hier unbezeichnet die
             * Gesamtsumme (−1.190 €), während Beleg und Archiv −714 € zeigten. Jetzt steht der
             * Zahlbetrag benannt vorn; die Gesamtsumme nur bei Abzügen, ausdrücklich als solche.
             */
            highlights={[
              `${translate('invoice.correction.issueDate')}: ${formatInvoiceDate(correctionModel.issueDate)}`,
              `${translate('invoice.correction.amountDueLabel')}: ${formatPaymentCurrency(correctionModel.summary.amountDue)}`,
              ...(correctionModel.summary.deductionLines.length > 0
                ? [
                    `${translate('invoice.correction.grossTotalLabel')}: ${formatPaymentCurrency(correctionModel.summary.grossTotal)}`,
                  ]
                : []),
            ]}
            actions={
              <InvoicePrintActions
                key={`print-correction-${invoice.id}`}
                invoice={invoice}
                model={correctionModel}
                translate={translate}
                layout="stack"
                autoDownloadPdf={autoDownloadPdf}
                generatePdf={generateInvoiceCorrectionPdf}
                outputHold={outputHold}
                onRetryOutputCheck={retryServicePeriodProof}
              />
            }
            hideIdentity
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
          {/*
            * FINANZ-CORE-01A (STO-09/AUS-08) — die Rechnungskorrektur als E-Rechnung:
            * Gutschrift (381) mit eigener Nummer und Bezug auf das Original. Ein
            * ZUGFeRD-PDF gibt es dafür nicht: Das Korrektur-PDF zeigt die Beträge als
            * Gegenbuchung, die Gutschrift positiv — beides in einer Datei wäre widersprüchlich.
            */}
          <Card className="invoice-einvoice" data-testid="invoice-correction-einvoice-panel">
            <h3 className="ui-section-header__title">E-Rechnung</h3>
            <div className="invoice-einvoice__formats">
              <XRechnungPanel invoice={invoice} variant="correction" outputBlocked={Boolean(outputHold)} />
            </div>
          </Card>
        </div>
        <div
          className={`invoice-detail__document invoice-print-document${printBlockedClass}`}
          data-testid="invoice-correction-document"
        >
          {printBlockedNotice}
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
        roleAligned={servicePeriodRoleAligned}
      />
      {/* FINANZ-CORE-01A (AUS-14) — Meldung und ?auto=pdf gehören zu genau dieser Rechnung. */}
      <InvoicePrintActions
        key={`print-${invoice.id}`}
        invoice={invoice}
        model={printModel}
        translate={translate}
        layout="stack"
        autoDownloadPdf={autoDownloadPdf}
        outputHold={outputHold}
        onRetryOutputCheck={retryServicePeriodProof}
      />
      {/*
        * E-RECHNUNG-04D — die strukturierte Rechnung neben dem PDF.
        *
        * Nur fuer einen freigegebenen Beleg und nur auf ausdrueckliche
        * Anforderung. Eine eigene Seite braucht es dafuer nicht: Es ist
        * dieselbe Rechnung in einer anderen Ausgabeform.
        */}
      {!invoiceCancelled && <EInvoicePanel invoice={invoice} outputBlocked={Boolean(outputHold)} />}
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
              {/* 03D — der Serverzeitpunkt ist UTC; gezeigt wird der lokale Tag. */}
              {/* FINANZ-CORE-01A (F-03) — der Geschäftstag, deutsch geschrieben. */}
              <span className="data-row__value">{formatDisplayDatePadded(toBusinessDay(invoice.cancelledAt))}</span>
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
      {/* EMAIL-01B3 — echter Versand per OfficePilot; die manuelle Markierung bleibt darunter getrennt. */}
      {/* FINANZ-CORE-01A (AUS-04) — je Rechnung neu montiert: die Route behält die Seite beim Wechsel zwischen Rechnungen, und ein Entwurf von A darf nie auf B erscheinen. */}
      <InvoiceDeliveryPanel key={`delivery-${invoice.id}`} vorgangId={vorgangId} invoice={invoice} onInvoiceUpdated={setInvoice} />
      {/* EMAIL-01B4 — Korrekturbeleg der stornierten Rechnung: gleicher Unterbau, eigener Bereich, Original bleibt unberührt. */}
      {invoice.cancellationKind === 'correction' && invoice.correctionDocumentId ? (
        <InvoiceDeliveryPanel key={`delivery-correction-${invoice.id}`} vorgangId={vorgangId} invoice={invoice} onInvoiceUpdated={setInvoice} documentKind="invoice_correction" />
      ) : null}
      <InvoiceSentPanel
        key={`sent-${invoice.id}`}
        vorgangId={vorgangId}
        invoice={invoice}
        translate={translate}
        onUpdated={setInvoice}
        cloudState={sentCloudState}
        onCloudStateChange={setSentCloudState}
        roleAligned={sentRoleAligned}
      />
      {/* FINANZCORE-05C — kein Zahlungsknopf, wenn nichts mehr offen ist; Korrektur laeuft ueber die Zahlungsliste. */}
      {canRecordInvoicePayment(invoice) && darfFinanzen && (
        <Button type="button" fullWidth onClick={() => setShowPaymentForm(true)}>
          {translate('detail.action.recordPayment')}
        </Button>
      )}
      {/* GO-LIVE-SECURITY-01 / ABSCHLUSS — Mitglieder sehen, warum Zahlung und Storno fehlen. */}
      {!darfFinanzen && (canRecordInvoicePayment(invoice) || canCancelInvoice) && (
        <p className="invoice-hint" data-testid="invoice-finance-role-hint">
          {translate('invoice.finance.roleHint')}
        </p>
      )}
      {/*
        * PAYMENT-REMINDER-WITHOUT-VORGANG-01 — auch die Rechnung ohne Auftrag
        * führt in den Kommunikationsbereich; ihr Kontext kommt aus dem
        * eigenen Rechnungs-/Kundensnapshot. Kein künstlicher Auftrag.
        */}
      <Button
        variant="outline"
        fullWidth
        onClick={() => navigate(reminderPath)}
        data-testid="invoice-write-message"
      >
        {translate('detail.action.writeMessage')}
      </Button>
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
      {canCancelInvoice && darfFinanzen && (
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

      <CommunicationIntegrationPanel
        contextRef={vorgangId ? { type: 'invoice', id: invoice.id, vorgangId } : { type: 'invoice', id: invoice.id }}
        buttonKeys={INVOICE_COMMUNICATION_BUTTON_KEYS}
        testIdPrefix="invoice"
      />

      <p className="hint-text">{translate('invoice.readOnlyHint')}</p>
    </>
  );

  return (
    <div className="page page--invoice-detail" data-testid="invoice-detail-page">
      <div className="invoice-detail__toolbar no-print">
        {/*
          * UIUX-FOUNDATION-01E — Detailmuster: Back (berechnetes Ziel aus
          * from-Parameter/Freier Rechnung), Identität, Zahlungsstatus. Die
          * fachlichen nächsten Schritte bleiben in der Experience-Card.
          */}
        <PageHeader
          title={printModel.documentTitle}
          subtitle={`${printModel.invoiceNumber} · ${belegEmpfaenger}`}
          status={<StatusBadge tone={paymentStatusTone(paymentSummary.status)} label={translate(statusKey)} data-testid="invoice-detail-status" />}
          backLabel={fromOverview || isFreeInvoice ? translate('overview.backToOverview') : translate('common.back')}
          backHref={backPath}
          backTestId="invoice-detail-back"
          testId="invoice-detail-header"
        />

        {/* VISUAL-POLISH-01C — Desktop zweispaltig: links nächste Aktion und Versand, rechts Betrag & Zahlung. */}
        <div className="work-detail-grid invoice-detail__grid">
        <div className="work-detail-grid__main">
        <DetailExperienceCard
          recognizedTitle={printModel.documentTitle}
          recognizedSummary={`${printModel.invoiceNumber} · ${belegEmpfaenger}`}
          assistantMessage={translate('invoice.experience.finalized').replace(
            '{amount}',
            formatPaymentCurrency(paymentSummary.totalDue),
          )}
          highlights={buildInvoiceDetailHighlights({
            status: paymentSummary.status,
            openAmount: paymentSummary.openAmount,
            openAmountText: translate('invoice.highlight.openAmount').replace(
              '{amount}',
              formatPaymentCurrency(paymentSummary.openAmount),
            ),
            statusText: translate(statusKey),
          })}
          actions={primaryActions}
          hideIdentity
          testId="invoice-detail-experience"
        />
        </div>

        <div className="work-detail-grid__side">
        {/*
          * STEUERBERATER-06A — die Kontierung steht fuer sich: nicht im
          * Zahlungsbereich und nicht bei der E-Rechnung. Sie beantwortet eine
          * eigene Frage fuer einen eigenen Leser, den Steuerberater.
          */}
        <AccountingSection title={translate('accounting.title')} testId="invoice-detail-section-accounting">
          <AccountingAssignmentPanel
            key={`${invoice.id}:${accountingToken}`}
            readOnly={!darfFinanzen}
            assignment={getAccountingAssignmentForSource('invoice', invoice.id)}
            onStart={() => {
              ensureInvoiceAccountingAssignment(invoice);
              setAccountingToken((value) => value + 1);
            }}
            onChanged={() => setAccountingToken((value) => value + 1)}
            translate={translate}
            testIdPrefix="invoice"
            // FINANZ-CORE-01A (WEISS-Nacharbeit N06) — die Steuer der Kontierung folgt der Rechnung.
            sourceTaxTreatment={invoice.taxStatus}
          />
        </AccountingSection>

        <DetailSection title={translate('invoiceDetail.section.payment')} surface testId="invoice-detail-section-payment">
          <InvoicePaymentSummary
            invoice={invoice}
            translate={translate}
            vorgangId={vorgangId}
            onInvoiceChange={(updated) => setInvoice(updated)}
            actor={{ userId: authUserId ?? undefined, cloudConfigured }}
          />
          {/* PAYMENT-REMINDER-01 — dokumentierter Mahnstand direkt beim Zahlungsstand, nicht versteckt. */}
          <div className="data-row" data-testid="invoice-dunning-status">
            <span className="data-row__label">{translate('invoice.dunning.statusLabel')}</span>
            <span className="data-row__value" data-dunning-kind={latestDunning?.kind ?? 'none'}>
              {latestDunning
                ? translate('invoice.dunning.documented')
                    .replace('{kind}', formatDunningKindLabel(latestDunning.kind, translate))
                    .replace('{date}', formatInvoiceDate(latestDunning.documentedAt))
                : translate('invoice.dunning.none')}
            </span>
          </div>
          {canRemind ? (
            <Button
              type="button"
              variant="outline"
              fullWidth
              onClick={() => navigate(reminderPath)}
              data-testid="invoice-dunning-remind"
            >
              {translate('invoice.dunning.writeReminder')}
            </Button>
          ) : null}
          <InvoicePaymentHistory
            invoice={invoice}
            translate={translate}
            onRemovePayment={handleRemovePayment}
            allowRemove={darfFinanzen}
            removeBlockedReason={
              paymentReversalBlocked ? translate('payment.reverseBlockedByFinalInvoice') : undefined
            }
            unsyncedPaymentIds={unsyncedPaymentIds ?? undefined}
            blockedPaymentReasons={resyncBlocks}
            onSecurePayment={darfFinanzen ? handleSecurePayment : undefined}
            onConfirmRejectedPayment={darfFinanzen ? (paymentId) => setOverpaymentQuestionId(paymentId) : undefined}
            onDiscardRejectedPayment={darfFinanzen ? handleDiscardRejectedPayment : undefined}
          />
        </DetailSection>
        </div>
        </div>

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
        }${printBlockedClass}`}
        data-testid="invoice-print-document"
      >
        {printBlockedNotice}
        <InvoiceDocumentView model={printModel} />
      </div>

      <InvoicePaymentForm
        vorgangId={vorgangId}
        invoice={invoice}
        open={showPaymentForm}
        onClose={() => setShowPaymentForm(false)}
        onSaved={handlePaymentSaved}
        onReverted={setInvoice}
        // FINANZ-CORE-01A (F-02) — bestätigte Sicherung: gezielt neu abgleichen, wie nach „Sichern“.
        onCloudSynced={() => setCloudRefreshToken((token) => token + 1)}
        translate={translate}
      />

      {/*
        * Der Dialog wird nur montiert, wenn die Aktion fachlich zulässig ist.
        * Damit gibt es keinen Weg, ihn über einen Zustandsrest an einer
        * Rechnung zu öffnen, die gar nicht stornierbar ist.
        */}
      {canCancelInvoice && darfFinanzen && (
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
      {(() => {
        // END18-R3 — die Frage gilt auch einer abgewiesenen Zahlung (sie steht dann unter den abgewiesenen).
        const pending = [...getInvoicePayments(invoice), ...getRejectedInvoicePayments(invoice)].find(
          (entry) => entry.id === overpaymentQuestionId,
        );
        return (
          <SimpleConfirmDialog
            open={Boolean(pending)}
            title={translate('payment.overpaymentQuestionTitle')}
            message={
              pending
                ? `${translate('payment.overpaymentQuestionMessage')} ${formatDisplayDate(pending.date)} · ${formatEuroAmount(pending.amount)}`
                : translate('payment.overpaymentQuestionMessage')
            }
            confirmLabel={translate('payment.overpaymentQuestionConfirm')}
            cancelLabel={translate('common.cancel')}
            dialogTestId="payment-overpayment-dialog"
            confirmTestId="payment-overpayment-confirm"
            cancelTestId="payment-overpayment-cancel"
            onConfirm={() => {
              const id = pending?.id;
              setOverpaymentQuestionId(null);
              if (id) void handleAcknowledgeOverpayment(id);
              return true;
            }}
            onCancel={() => setOverpaymentQuestionId(null)}
          />
        );
      })()}
    </div>
  );
}
