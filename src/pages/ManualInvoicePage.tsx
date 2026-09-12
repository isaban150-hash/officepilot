/**
 * MANUAL-INVOICE-UI-01B1B — die Rechnung ohne Auftrag, sichtbar in vier
 * Schritten: Kunde → Positionen → Rechnungsdetails → Prüfen und Freigeben.
 *
 * Diese Seite ist nur der Container. Fachliche Daten leben im `InvoiceDraft`
 * innerhalb der dauerhaften Sitzung (`useInvoiceDraftDurabilitySession`, seit
 * 01B1A nullfähig) — nie nur im React-Zustand. Freigabe läuft über den
 * bestehenden Coordinator mit `vorgangId: null`; es gibt keine zweite Engine.
 *
 * Bewusst keine Kopie der auftragsgebundenen `RechnungPage`: Was dort an
 * Planmengen, Nachträgen, Abschlägen und Vertragsintelligenz hängt, existiert
 * hier nicht. Was beide brauchen — Steuer-Blocker, §13b-Bindung, Firmen-
 * Drift, Freigabe-UX — kommt aus denselben Diensten.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CustomerDecisionChoice, type CustomerDecisionMode } from '../components/customer/CustomerDecisionChoice';
import {
  buildCustomerInputFromUi,
  createEmptyCustomerExtraFields,
  isCustomerDecisionIncomplete,
  loadSelectableCustomers,
  resolveNewCustomerHintKey,
  type CustomerExtraFields,
} from '../components/customer/customerDecisionUi';
import { InvoiceDocumentView } from '../components/invoice/InvoiceDocumentView';
import { InvoiceDraftEditForm } from '../components/invoice/InvoiceDraftEditForm';
import { ManualInvoicePositionsEditor } from '../components/invoice/ManualInvoicePositionsEditor';
import { ManualInvoiceStepper } from '../components/invoice/ManualInvoiceStepper';
import { Button } from '../components/ui/Button';
import { Card, DataRow, PageHeader } from '../components/ui/Card';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import { billingFromCustomer, createCustomer } from '../services/customerService';
import { getCustomerById } from '../services/customerStoreService';
import { getCompanyProfile } from '../services/companyProfileService';
import {
  applyCriticalCompanyProfileFields,
  buildCriticalCompanyFingerprint,
  findCriticalCompanyProfileDrift,
  type CriticalCompanyField,
} from '../services/invoice/companySnapshotDriftService';
import { loadInvoiceDraftRecordByLocator } from '../services/invoice/invoiceDraftDurabilityService';
import {
  resumeInvoiceDraftFinalization,
  startInvoiceDraftFinalization,
  type InvoiceFinalizationRecovery,
} from '../services/invoice/invoiceFinalizationCoordinator';
import { mapFinalizationFailureToUx, taxDecisionBlocker } from '../services/invoice/invoiceApprovalUx';
import {
  hasManualInvoiceCustomer,
  isManualInvoiceStep,
  MANUAL_INVOICE_STEP_PARAM,
  MANUAL_INVOICE_STEPS,
  resolveManualInvoicePostFinalizePath,
  resolveReachableManualStep,
  resolveResumableManualStep,
  type ManualInvoiceStep,
} from '../services/invoice/manualInvoiceFlow';
import { findInvoiceLocatorById } from '../services/invoice/invoiceRegistryService';
import {
  clearReverseChargeConfirmation,
  hasValidReverseChargeConfirmation,
  writeReverseChargeConfirmation,
  type ReverseChargeConfirmationContext,
} from '../services/invoice/reverseChargeConfirmationService';
import {
  useInvoiceDraftDurabilitySession,
  type InvoiceDraftSessionStatus,
} from '../services/invoice/useInvoiceDraftDurabilitySession';
import {
  buildManualInvoiceDraft,
  calculateInvoiceTotals,
  updateInvoiceDraftMetadata,
  updateInvoiceDraftTaxStatus,
  validateInvoiceDraftForApproval,
} from '../services/invoiceService';
import { buildInvoicePrintModel, formatInvoiceCurrency } from '../services/invoicePrintModel';
import { buildOpenInvoicesPath } from '../services/invoiceNavigation';
import { buildPersistedStateSnapshot } from '../services/persistenceService';
import { buildDocumentBlobScopeKey } from '../services/storage/documentBlobScopeService';
import { getActiveStorageScope } from '../services/storage/storageScopeService';
import { resolveCloudWorkspaceId } from '../services/workspace/workspaceSyncPayloadService';
import type { InvoiceDraftLocator, InvoiceDraftRecord } from '../types/invoiceDraftDurability';
import type { CompanyProfile, CustomerBilling, TaxStatus } from '../types/models';
import type { TranslationKey } from '../i18n';

const TAX_OPTIONS: TaxStatus[] = [
  'standard_19',
  'standard_7',
  'kleinunternehmer_19',
  'reverse_charge_13b',
  'tax_free',
  'unclear',
];

/* Beide Werte müssen exakt so entstehen wie im Preflight des Coordinators. */
function resolveActiveScopeKey(): string {
  const scope = getActiveStorageScope();
  return scope ? buildDocumentBlobScopeKey(scope) : '';
}
function resolveActiveWorkspaceId(): string {
  return resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
}

function isHydrationSettled(status: InvoiceDraftSessionStatus): boolean {
  return status !== 'idle' && status !== 'loading' && status !== 'creating';
}

/** Der Entwurf beginnt ohne Empfänger — leer, nicht erfunden. Schritt 1 füllt ihn. */
function emptyBilling(): CustomerBilling {
  return { name: '', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' };
}

export function ManualInvoicePage() {
  const { setup, translate, showToast } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  /* ---------------- dauerhafte Sitzung ---------------- */

  const locator = useMemo<InvoiceDraftLocator | null>(() => {
    const sourceScopeKey = resolveActiveScopeKey();
    const workspaceId = resolveActiveWorkspaceId();
    if (!sourceScopeKey || !workspaceId) return null;
    return { sourceScopeKey, workspaceId, vorgangId: null, invoiceType: 'rechnung' };
  }, []);

  const setupRef = useRef(setup);
  setupRef.current = setup;
  const createDraft = useCallback(
    () => buildManualInvoiceDraft({ billing: emptyBilling() }, setupRef.current),
    [],
  );

  const session = useInvoiceDraftDurabilitySession({ locator, createDraft });
  const { draft, mutateDraft, status: sessionStatus } = session;
  const finalizationLocked =
    sessionStatus === 'finalization_pending' || sessionStatus === 'already_finalized';
  const editable = !session.readOnly && !session.blocked && !finalizationLocked;

  /* ---------------- §13b — dieselbe Bindung wie im Auftragsweg ---------------- */

  const [reverseCharge13bConfirmed, setReverseCharge13bConfirmed] = useState(false);
  const [confirmedDraftSha256, setConfirmedDraftSha256] = useState<string | null>(null);
  const draftRecord = session.record;
  const reverseChargeContext = useMemo<ReverseChargeConfirmationContext | null>(() => {
    if (!draftRecord) return null;
    return {
      sourceScopeKey: draftRecord.sourceScopeKey,
      workspaceId: draftRecord.workspaceId,
      vorgangId: draftRecord.vorgangId,
      invoiceType: draftRecord.invoiceType,
      draftId: draftRecord.draftId,
      draftSha256: draftRecord.draftSha256,
    };
  }, [draftRecord]);
  const draftPersisted = sessionStatus !== 'saving';
  useEffect(() => {
    if (!reverseCharge13bConfirmed || !draftPersisted || !reverseChargeContext) return;
    if (confirmedDraftSha256 === null) {
      setConfirmedDraftSha256(reverseChargeContext.draftSha256);
      writeReverseChargeConfirmation(reverseChargeContext);
      return;
    }
    if (confirmedDraftSha256 === reverseChargeContext.draftSha256) return;
    // Der Inhalt hat sich geändert — die Bestätigung gilt nicht mehr.
    setReverseCharge13bConfirmed(false);
    setConfirmedDraftSha256(null);
    clearReverseChargeConfirmation(reverseChargeContext);
  }, [reverseCharge13bConfirmed, draftPersisted, reverseChargeContext, confirmedDraftSha256]);

  const taxDecisionBlockKey = draft ? taxDecisionBlocker(draft.taxStatus, reverseCharge13bConfirmed) : null;
  const taxDecisionSettled = taxDecisionBlockKey === null;

  /* ---------------- Schritt + Wiederaufnahme ---------------- */

  const requestedStep = isManualInvoiceStep(searchParams.get(MANUAL_INVOICE_STEP_PARAM))
    ? (searchParams.get(MANUAL_INVOICE_STEP_PARAM) as ManualInvoiceStep)
    : null;
  const [step, setStep] = useState<ManualInvoiceStep>('customer');
  const [resumeApplied, setResumeApplied] = useState(false);
  const hydrationSettled = isHydrationSettled(sessionStatus);

  useEffect(() => {
    if (resumeApplied || !hydrationSettled) return;
    const restoredConfirmation =
      draft?.taxStatus === 'reverse_charge_13b' &&
      reverseChargeContext !== null &&
      hasValidReverseChargeConfirmation(reverseChargeContext);
    if (restoredConfirmation) {
      setReverseCharge13bConfirmed(true);
      setConfirmedDraftSha256(reverseChargeContext!.draftSha256);
    }
    setResumeApplied(true);
    setStep(
      resolveResumableManualStep({
        requested: requestedStep,
        draft,
        taxDecisionSettled: draft
          ? taxDecisionBlocker(draft.taxStatus, reverseCharge13bConfirmed || restoredConfirmation) === null
          : false,
        finalizationLocked,
      }),
    );
  }, [resumeApplied, hydrationSettled, draft, requestedStep, reverseChargeContext, reverseCharge13bConfirmed, finalizationLocked]);

  /*
   * Erste Normalisierung der Adresse nach der Wiederaufnahme: Fehlt `?step=`
   * oder wurde der Wunsch zurückgewiesen, wird der geprüfte Schritt
   * **ersetzt** eingetragen — kein Verlaufseintrag ohne Schritt. Danach
   * schreibt nur noch eine Nutzeraktion (`writeStep`) die Adresse.
   */
  useEffect(() => {
    if (!resumeApplied) return;
    if (searchParams.get(MANUAL_INVOICE_STEP_PARAM) === step) return;
    const next = new URLSearchParams(searchParams);
    next.set(MANUAL_INVOICE_STEP_PARAM, step);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeApplied]);

  const reachable = resolveReachableManualStep({ draft, taxDecisionSettled });

  /*
   * Die Adresse ist die einzige Quelle des Schritts: Eine Nutzeraktion schreibt
   * sie als Verlaufseintrag, Zurück/Vor liest sie (popstate). Ein Schritt, den
   * die Daten nicht tragen, wird nicht übernommen. Bewusst **kein** zweiter
   * Effekt, der die Adresse aus dem Schritt „korrigiert" — zwei Effekte, die
   * einander widersprechen, erzeugten einen Kreis aus Push und Zurücksetzen.
   */
  useEffect(() => {
    if (!resumeApplied || !requestedStep || requestedStep === step) return;
    if (MANUAL_INVOICE_STEPS.indexOf(requestedStep) <= MANUAL_INVOICE_STEPS.indexOf(reachable)) {
      setStep(requestedStep);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedStep, resumeApplied]);

  /** Nutzeraktion: Schritt setzen **und** als Verlaufseintrag in die Adresse schreiben. */
  const writeStep = (target: ManualInvoiceStep) => {
    setStep(target);
    const next = new URLSearchParams(searchParams);
    next.set(MANUAL_INVOICE_STEP_PARAM, target);
    setSearchParams(next);
    window.scrollTo({ top: 0 });
  };
  const goTo = (target: ManualInvoiceStep) => {
    if (MANUAL_INVOICE_STEPS.indexOf(target) > MANUAL_INVOICE_STEPS.indexOf(reachable)) return;
    writeStep(target);
  };
  const stepIndex = MANUAL_INVOICE_STEPS.indexOf(step);
  const goBack = () => {
    if (stepIndex === 0) navigate(buildOpenInvoicesPath());
    else goTo(MANUAL_INVOICE_STEPS[stepIndex - 1]!);
  };

  /* ---------------- Schritt 1: Kunde ---------------- */

  const [customerMode, setCustomerMode] = useState<CustomerDecisionMode | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerExtra, setNewCustomerExtra] = useState<CustomerExtraFields>(createEmptyCustomerExtraFields);
  const [customerError, setCustomerError] = useState<TranslationKey | null>(null);
  const customers = useMemo(() => loadSelectableCustomers(), [step]);

  const adoptCustomer = (customerId: string) => {
    const customer = getCustomerById(customerId);
    if (!customer) {
      setCustomerError('manualInvoice.customer.missing');
      return false;
    }
    const billing = billingFromCustomer(customer);
    mutateDraft((prev) => ({ ...prev, customerId: customer.id, customer: billing.name, customerBilling: billing }));
    setCustomerError(null);
    return true;
  };

  const customerHint = resolveNewCustomerHintKey(customerMode, newCustomerName);
  const customerIncomplete = isCustomerDecisionIncomplete(customerMode, newCustomerName, selectedCustomerId);

  /*
   * Nach `adoptCustomer` ist der Kunde im Entwurf — die Erreichbarkeit aus dem
   * laufenden Render weiss das noch nicht. Der Schritt wird deshalb hier direkt
   * gesetzt, nicht über `goTo`, das gegen den alten Stand prüfen würde.
   */
  const advanceToPositions = () => {
    setCustomerMode(null);
    writeStep('positions');
  };
  const handleCustomerContinue = () => {
    if (!draft || !editable) return;
    if (customerMode === 'existing' && selectedCustomerId) {
      if (adoptCustomer(selectedCustomerId)) advanceToPositions();
      return;
    }
    if (customerMode === 'new') {
      const created = createCustomer(buildCustomerInputFromUi(newCustomerName, newCustomerExtra));
      if (!created.success) {
        setCustomerError(created.errorKey as TranslationKey);
        return;
      }
      if (adoptCustomer(created.customer.id)) advanceToPositions();
      return;
    }
    // Bereits gewählter Kunde aus einer früheren Sitzung: weiter ohne Neuwahl.
    if (hasManualInvoiceCustomer(draft)) advanceToPositions();
  };

  /* ---------------- Schritt 3: Steuer ---------------- */

  const handleTaxChange = (taxStatus: TaxStatus) => {
    if (taxStatus !== 'reverse_charge_13b') {
      setReverseCharge13bConfirmed(false);
      setConfirmedDraftSha256(null);
      if (reverseChargeContext) clearReverseChargeConfirmation(reverseChargeContext);
    }
    mutateDraft((prev) => updateInvoiceDraftTaxStatus(prev, taxStatus));
  };
  const handleReverseCharge13bConfirm = (confirmed: boolean) => {
    setReverseCharge13bConfirmed(confirmed);
    if (confirmed) return;
    setConfirmedDraftSha256(null);
    if (reverseChargeContext) clearReverseChargeConfirmation(reverseChargeContext);
  };

  /* ---------------- Schritt 4: Freigabe ---------------- */

  const [approving, setApproving] = useState(false);
  const approveLockRef = useRef(false);
  const [validationErrors, setValidationErrors] = useState<TranslationKey[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<TranslationKey[]>([]);
  const [failure, setFailure] = useState<{ messageKey: TranslationKey; reloadRequired: boolean } | null>(null);
  const [showCompanyDriftConfirm, setShowCompanyDriftConfirm] = useState(false);
  const [companyDriftFields, setCompanyDriftFields] = useState<CriticalCompanyField[]>([]);
  const [companyDriftProfile, setCompanyDriftProfile] = useState<CompanyProfile | null>(null);
  const [acknowledgedCompanyFingerprint, setAcknowledgedCompanyFingerprint] = useState<string | null>(null);

  const runApproval = async () => {
    if (!draft || approveLockRef.current || approving) return;
    if (session.readOnly || session.blocked || !session.record) return;
    approveLockRef.current = true;
    setApproving(true);
    setFailure(null);
    let finalizationStarted = false;
    try {
      const validation = validateInvoiceDraftForApproval(draft, draft.companySnapshot, undefined, {
        reverseCharge13bConfirmed,
      });
      setValidationWarnings(validation.warnings.map((w) => w.messageKey));
      if (validation.blockingErrors.length > 0) {
        setValidationErrors(validation.blockingErrors.map((e) => e.messageKey));
        showToast(translate('invoice.approve.blocked'));
        approveLockRef.current = false;
        setApproving(false);
        return;
      }
      setValidationErrors([]);

      // Der Coordinator arbeitet nur auf dem gespeicherten Datensatz.
      const flushed = await session.flush();
      if (!flushed.ok) {
        showToast(translate(flushed.outcome === 'conflict' ? 'invoice.approve.conflict' : 'invoice.approve.localPersistPending'));
        approveLockRef.current = false;
        setApproving(false);
        return;
      }
      const reloaded = locator ? await loadInvoiceDraftRecordByLocator(locator) : null;
      const record = reloaded?.ok ? reloaded.record : null;
      if (!record) {
        showToast(translate('invoice.approve.failed'));
        approveLockRef.current = false;
        setApproving(false);
        return;
      }

      finalizationStarted = true;
      const result = await startInvoiceDraftFinalization({
        identity: {
          sourceScopeKey: record.sourceScopeKey,
          workspaceId: record.workspaceId,
          vorgangId: record.vorgangId,
          invoiceType: record.invoiceType,
          draftId: record.draftId,
        },
        expectedRevision: record.revision,
        approvalOptions: { reverseCharge13bConfirmed },
        overbillingAcknowledged: false,
      });

      if (!result.ok) {
        const ux = mapFinalizationFailureToUx(result);
        setFailure({ messageKey: ux.messageKey, reloadRequired: ux.reloadRequired });
        showToast(translate(ux.messageKey));
        if (ux.unlock) {
          approveLockRef.current = false;
          setApproving(false);
        }
        return;
      }

      showToast(translate(result.archiveWarning ? 'invoice.approve.archiveWarning' : 'invoice.approved'));
      // 01B2 — auf die globale Detailseite, aber nur mit lokal belegter Rechnung.
      navigate(
        resolveManualInvoicePostFinalizePath(
          result.invoice.id,
          findInvoiceLocatorById(result.invoice.id),
        ),
      );
    } catch (error) {
      console.warn('[OfficePilot] Freigabe unerwartet fehlgeschlagen:', error);
      setApproving(false);
      if (finalizationStarted) {
        showToast(translate('invoice.approve.unexpectedReload'));
      } else {
        approveLockRef.current = false;
        showToast(translate('invoice.approve.failed'));
      }
    }
  };

  /** Firmen-Drift zuerst — dieselbe Regel wie im Auftragsweg, im Augenblick des Klicks. */
  const handleApprove = () => {
    const profile = getCompanyProfile();
    const fingerprint = buildCriticalCompanyFingerprint(profile);
    if (draft && acknowledgedCompanyFingerprint !== fingerprint) {
      const drift = findCriticalCompanyProfileDrift(draft.companySnapshot, profile);
      if (drift.length > 0) {
        setCompanyDriftFields(drift);
        setCompanyDriftProfile(profile);
        setShowCompanyDriftConfirm(true);
        return;
      }
      setAcknowledgedCompanyFingerprint(fingerprint);
    }
    void runApproval();
  };
  const handleApplyCompanyDrift = () => {
    const current = companyDriftProfile ?? getCompanyProfile();
    mutateDraft((prev) => ({ ...prev, companySnapshot: applyCriticalCompanyProfileFields(prev.companySnapshot, current) }));
    setAcknowledgedCompanyFingerprint(buildCriticalCompanyFingerprint(current));
    setShowCompanyDriftConfirm(false);
    showToast(translate('invoice.companyDrift.applied'));
    void runApproval();
  };
  const handleKeepCompanySnapshot = () => {
    setAcknowledgedCompanyFingerprint(buildCriticalCompanyFingerprint(getCompanyProfile()));
    setShowCompanyDriftConfirm(false);
    void runApproval();
  };

  /* ---------------- Wiederaufnahme einer begonnenen Finalisierung ---------------- */

  const [resumeRecovery, setResumeRecovery] = useState<InvoiceFinalizationRecovery | null>(null);
  const resumedKeyRef = useRef<string | null>(null);
  const retryLockRef = useRef(false);
  const runResume = useCallback(
    async (record: InvoiceDraftRecord) => {
      if (retryLockRef.current) return;
      retryLockRef.current = true;
      try {
        const result = await resumeInvoiceDraftFinalization({
          identity: {
            sourceScopeKey: record.sourceScopeKey,
            workspaceId: record.workspaceId,
            vorgangId: record.vorgangId,
            invoiceType: record.invoiceType,
            draftId: record.draftId,
          },
        });
        if (result.ok) {
          setResumeRecovery(null);
          showToast(translate('invoice.approved'));
          // 01B2 — nur mit belegter Rechnung auf die Detailseite, sonst Übersicht.
          navigate(
            result.invoice
              ? resolveManualInvoicePostFinalizePath(
                  result.invoice.id,
                  findInvoiceLocatorById(result.invoice.id),
                )
              : buildOpenInvoicesPath(),
          );
          return;
        }
        setResumeRecovery(result.recovery);
        showToast(
          translate(
            result.recovery === 'reload_required'
              ? 'invoice.resume.reloadRequired'
              : result.recovery === 'retry_allowed'
                ? 'invoice.resume.retry'
                : 'invoice.resume.blocked',
          ),
        );
      } finally {
        retryLockRef.current = false;
      }
    },
    [navigate, showToast, translate],
  );
  useEffect(() => {
    if (sessionStatus !== 'finalization_pending' || !session.record) return;
    const key = `${session.record.recordKey}#${session.record.revision}`;
    if (resumedKeyRef.current === key) return;
    resumedKeyRef.current = key;
    void runResume(session.record);
  }, [sessionStatus, session.record, runResume]);

  /* ---------------- Ableitungen ---------------- */

  const totals = draft ? calculateInvoiceTotals(draft, setup) : null;
  const printModel = useMemo(() => (draft ? buildInvoicePrintModel(draft, setup) : null), [draft, setup]);
  const needsServicePeriodConfirmation =
    Boolean(draft?.servicePeriodFrom.trim() && draft?.servicePeriodTo.trim()) &&
    draft?.servicePeriodConfirmed !== true;

  /* ---------------- Sperrzustände ---------------- */

  if (!locator) {
    return (
      <div className="page" data-testid="manual-invoice-page">
        <EmptyStateBlock
          title={translate('invoice.session.noWorkspaceTitle')}
          description={translate('invoice.session.noWorkspace')}
        />
      </div>
    );
  }
  if (!draft || !hydrationSettled) {
    return (
      <div className="page" data-testid="manual-invoice-page">
        <PageHeader title={translate('manualInvoice.title')} subtitle={translate('common.loading')} />
        {session.blocked && (
          <p className="form-error" data-testid="manual-invoice-session-blocked">
            {translate(sessionStatus === 'blocked_conflict' ? 'invoice.session.conflict' : 'invoice.session.storage')}
          </p>
        )}
      </div>
    );
  }

  const primary = (() => {
    switch (step) {
      case 'customer':
        return {
          label: translate('manualInvoice.next.positions'),
          onClick: handleCustomerContinue,
          disabled: !editable || (customerMode !== null ? customerIncomplete : !hasManualInvoiceCustomer(draft)),
        };
      case 'positions':
        return { label: translate('manualInvoice.next.details'), onClick: () => goTo('details'), disabled: reachable === 'positions' };
      case 'details':
        return { label: translate('manualInvoice.next.review'), onClick: () => goTo('review'), disabled: reachable !== 'review' };
      default:
        return {
          label: approving ? translate('invoice.approve.working') : translate('invoice.approve'),
          onClick: handleApprove,
          disabled: !editable || approving || needsServicePeriodConfirmation || showCompanyDriftConfirm,
        };
    }
  })();

  return (
    <div className="page manual-invoice" data-testid="manual-invoice-page">
      <PageHeader
        title={translate('manualInvoice.title')}
        subtitle={translate(`manualInvoice.subtitle.${step}` as TranslationKey)}
        backLabel={translate('common.back')}
        onBack={goBack}
      />
      <ManualInvoiceStepper current={step} reachable={reachable} onSelect={goTo} translate={translate} />

      {/* ---------------- 1 Kunde ---------------- */}
      {step === 'customer' && (
        <section className="manual-invoice__step" data-testid="manual-invoice-step-customer">
          {hasManualInvoiceCustomer(draft) && customerMode === null && (
            <Card className="manual-invoice__chosen" data-testid="manual-invoice-customer-chosen">
              <p className="manual-invoice__chosen-name">{draft.customerBilling.name}</p>
              <p className="hint-text">
                {[draft.customerBilling.street, [draft.customerBilling.zip, draft.customerBilling.city].filter(Boolean).join(' ')]
                  .filter(Boolean)
                  .join(', ')}
              </p>
              <Button type="button" variant="outline" size="sm" disabled={!editable} onClick={() => setCustomerMode('existing')} data-testid="manual-invoice-customer-change">
                {translate('manualInvoice.customer.change')}
              </Button>
            </Card>
          )}
          {(!hasManualInvoiceCustomer(draft) || customerMode !== null) && (
            <>
              <CustomerDecisionChoice
                mode={customerMode}
                onModeChange={(mode) => {
                  setCustomerMode(mode);
                  setCustomerError(null);
                }}
                customers={customers}
                selectedCustomerId={selectedCustomerId}
                onSelectCustomer={(id) => {
                  setSelectedCustomerId(id);
                  setCustomerError(null);
                }}
                hint={customerError ? translate(customerError) : customerHint ? translate(customerHint) : null}
                extraFields={newCustomerExtra}
                onExtraFieldChange={(field, value) => setNewCustomerExtra((prev) => ({ ...prev, [field]: value }))}
                allowNone={false}
              />
              {customerMode === 'new' && (
                <label className="invoice-edit__field">
                  <span className="invoice-edit__label">{translate('manualInvoice.customer.name')}</span>
                  <input
                    type="text"
                    className="input"
                    value={newCustomerName}
                    onChange={(event) => setNewCustomerName(event.target.value)}
                    data-testid="manual-invoice-customer-name"
                  />
                </label>
              )}
            </>
          )}
        </section>
      )}

      {/* ---------------- 2 Positionen ---------------- */}
      {step === 'positions' && (
        <section className="manual-invoice__step" data-testid="manual-invoice-step-positions">
          <ManualInvoicePositionsEditor
            positions={draft.positions}
            onChange={(positions) => mutateDraft((prev) => ({ ...prev, positions }))}
            disabled={!editable}
            translate={translate}
          />
          {totals && draft.positions.length > 0 && (
            <Card className="manual-invoice__totals" data-testid="manual-invoice-positions-total">
              <DataRow label={translate('invoice.subtotal')} value={formatInvoiceCurrency(totals.subtotal)} />
            </Card>
          )}
        </section>
      )}

      {/* ---------------- 3 Rechnungsdetails ---------------- */}
      {step === 'details' && (
        <section className="manual-invoice__step" data-testid="manual-invoice-step-details">
          <Card className="invoice-tax-decision" data-testid="invoice-tax-decision">
            <fieldset className="invoice-edit__section">
              <legend>{translate('invoice.taxStatus')}</legend>
              <div className="chip-group">
                {TAX_OPTIONS.map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`chip ${draft.taxStatus === status ? 'chip--active' : ''}`}
                    data-testid={`invoice-tax-${status}`}
                    disabled={!editable}
                    onClick={() => handleTaxChange(status)}
                  >
                    {translate(`tax.${status}` as TranslationKey)}
                  </button>
                ))}
              </div>
            </fieldset>
            {draft.taxStatus === 'reverse_charge_13b' && (
              <div className="invoice-13b-confirm" data-testid="invoice-13b-confirm">
                <label className="invoice-13b-confirm__label">
                  <input
                    type="checkbox"
                    checked={reverseCharge13bConfirmed}
                    onChange={(event) => handleReverseCharge13bConfirm(event.target.checked)}
                    data-testid="invoice-13b-confirm-checkbox"
                  />
                  <span>{translate('invoice.reverseCharge.confirmLabel')}</span>
                </label>
                <p className="hint-text">{translate('invoice.reverseCharge.confirmHelp')}</p>
              </div>
            )}
            {taxDecisionBlockKey && (
              <p className="hint-text" data-testid="invoice-tax-decision-blocked">
                {translate(taxDecisionBlockKey)}
              </p>
            )}
          </Card>
          <InvoiceDraftEditForm
            draft={draft}
            onChange={(changes) => mutateDraft((prev) => updateInvoiceDraftMetadata(prev, changes))}
          />
        </section>
      )}

      {/* ---------------- 4 Prüfen und Freigeben ---------------- */}
      {step === 'review' && printModel && totals && (
        <section className="manual-invoice__step" data-testid="manual-invoice-step-review">
          <InvoiceDocumentView model={printModel} />
          <Card className="manual-invoice__totals" data-testid="manual-invoice-review-totals">
            <DataRow label={translate('invoice.subtotal')} value={formatInvoiceCurrency(totals.subtotal)} />
            <DataRow label={translate('invoice.tax')} value={formatInvoiceCurrency(totals.tax)} />
            <DataRow label={translate('invoice.total')} value={formatInvoiceCurrency(totals.total)} />
          </Card>
          <p className="hint-text" data-testid="invoice-preview-hint">{translate('invoice.previewHint')}</p>

          {needsServicePeriodConfirmation && (
            <Card className="invoice-confirm" data-testid="invoice-service-period-confirm">
              <p>{translate('manualInvoice.servicePeriod.confirmText')}</p>
              <div className="invoice-confirm__actions">
                <Button type="button" variant="outline" onClick={() => goTo('details')}>
                  {translate('manualInvoice.step.details')}
                </Button>
                <Button
                  type="button"
                  disabled={!editable}
                  onClick={() => mutateDraft((prev) => updateInvoiceDraftMetadata(prev, { servicePeriodConfirmed: true }))}
                  data-testid="invoice-confirm-service-period"
                >
                  {translate('invoice.confirmServicePeriod')}
                </Button>
              </div>
            </Card>
          )}

          {validationErrors.length > 0 && (
            <Card className="invoice-validation invoice-validation--errors" data-testid="invoice-validation-errors">
              <strong>{translate('invoice.validation.blockingTitle')}</strong>
              <ul>{validationErrors.map((key) => <li key={key}>{translate(key)}</li>)}</ul>
            </Card>
          )}
          {validationWarnings.length > 0 && (
            <Card className="invoice-validation invoice-validation--warnings" data-testid="invoice-validation-warnings">
              <strong>{translate('invoice.validation.warningTitle')}</strong>
              <ul>{validationWarnings.map((key) => <li key={key}>{translate(key)}</li>)}</ul>
            </Card>
          )}

          {showCompanyDriftConfirm && (
            <Card className="invoice-confirm" data-testid="invoice-company-drift-confirm">
              <strong>{translate('invoice.companyDrift.title')}</strong>
              <p>{translate('invoice.companyDrift.message')}</p>
              <ul className="invoice-drift-list" data-testid="invoice-company-drift-fields">
                {companyDriftFields.map((field) => (
                  <li key={field}>{translate(`invoice.companyDrift.field.${field}` as TranslationKey)}</li>
                ))}
              </ul>
              <div className="invoice-confirm__actions">
                <Button type="button" variant="outline" onClick={handleKeepCompanySnapshot} data-testid="invoice-company-drift-keep">
                  {translate('invoice.companyDrift.keep')}
                </Button>
                <Button type="button" onClick={handleApplyCompanyDrift} data-testid="invoice-company-drift-apply">
                  {translate('invoice.companyDrift.apply')}
                </Button>
              </div>
            </Card>
          )}

          {failure && (
            <Card className="invoice-validation invoice-validation--errors" data-testid="manual-invoice-failure">
              <p>{translate(failure.messageKey)}</p>
              {failure.reloadRequired ? (
                <Button type="button" variant="outline" onClick={() => window.location.reload()} data-testid="invoice-resume-reload">
                  {translate('invoice.resume.reloadAction')}
                </Button>
              ) : null}
            </Card>
          )}

          {finalizationLocked && (
            <Card className="invoice-validation" data-testid="invoice-session-locked">
              <p>
                {translate(
                  sessionStatus === 'already_finalized'
                    ? 'invoice.session.alreadyFinalized'
                    : 'invoice.session.finalizationPending',
                )}
              </p>
              <div className="invoice-confirm__actions">
                {sessionStatus === 'already_finalized' && (
                  <Button
                    type="button"
                    onClick={() => {
                      // 01B2 — die bereits finalisierte Rechnung direkt öffnen, wenn sie lokal belegt ist.
                      const finalizedId = session.record?.finalization?.finalizedInvoiceId?.trim() ?? '';
                      navigate(
                        finalizedId
                          ? resolveManualInvoicePostFinalizePath(finalizedId, findInvoiceLocatorById(finalizedId))
                          : buildOpenInvoicesPath(),
                      );
                    }}
                    data-testid="invoice-open-finalized"
                  >
                    {translate('overview.title')}
                  </Button>
                )}
                {resumeRecovery === 'retry_allowed' && (
                  <Button type="button" onClick={() => session.record && void runResume(session.record)} data-testid="invoice-resume-retry">
                    {translate('invoice.resume.retryAction')}
                  </Button>
                )}
                {resumeRecovery === 'reload_required' && (
                  <Button type="button" variant="outline" onClick={() => window.location.reload()} data-testid="invoice-resume-reload">
                    {translate('invoice.resume.reloadAction')}
                  </Button>
                )}
              </div>
            </Card>
          )}
        </section>
      )}

      {/* ---------------- Aktionen ---------------- */}
      {!finalizationLocked && (
        <div className="manual-invoice__actions" data-testid="manual-invoice-actions">
          <Button type="button" variant="outline" onClick={goBack} data-testid="manual-invoice-back">
            {translate('common.back')}
          </Button>
          <Button
            type="button"
            onClick={primary.onClick}
            disabled={primary.disabled}
            data-testid={step === 'review' ? 'invoice-approve' : 'manual-invoice-next'}
          >
            {primary.label}
          </Button>
        </div>
      )}
    </div>
  );
}
