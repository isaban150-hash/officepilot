import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocumentView } from '../components/invoice/InvoiceDocumentView';
import { InvoiceDraftEditForm } from '../components/invoice/InvoiceDraftEditForm';
import { Button } from '../components/ui/Button';
import { Card, DataRow, PageHeader } from '../components/ui/Card';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import {
  applyAllOpenPositionsToDraft,
  buildInvoiceDraftForType,
  calculateInvoiceTotals,
  getOverbillingWarnings,
  isFixedAmountAbschlag,
  resolveInvoiceCalculationMode,
  setAbschlagDraftCalculationMode,
  updateDraftPositionQuantity,
  updateInvoiceDraftFixedAmountNet,
  updateInvoiceDraftMetadata,
  updateInvoiceDraftTaxStatus,
  validateInvoiceDraftForApproval,
} from '../services/invoiceService';
import { useInvoiceDraftDurabilitySession } from '../services/invoice/useInvoiceDraftDurabilitySession';
import {
  resumeInvoiceDraftFinalization,
  startInvoiceDraftFinalization,
} from '../services/invoice/invoiceFinalizationCoordinator';
import { buildDocumentBlobScopeKey } from '../services/storage/documentBlobScopeService';
import { getActiveStorageScope } from '../services/storage/storageScopeService';
import { buildPersistedStateSnapshot } from '../services/persistenceService';
import { resolveCloudWorkspaceId } from '../services/workspace/workspaceSyncPayloadService';
import { buildInvoicePrintModel } from '../services/invoicePrintModel';
import {
  CONTRACT_ORDER_INVOICE_TYPES,
  getInvoiceDocumentTitle,
  parseInvoiceDocumentType,
} from '../services/invoiceTypeService';
import {
  analyzeContractIntelligenceFromInbox,
  getContractSkontoOfferForVorgang,
} from '../services/contractIntelligenceService';
import { getInboxItemById } from '../services/inboxService';
import { billingFromCustomer } from '../services/customerService';
import { getCustomerById } from '../services/customerStoreService';
import { getVorgangById } from '../services/vorgangService';
import type {
  InvoiceCalculationMode,
  InvoiceDraftMetadataChanges,
  InvoiceDocumentType,
  TaxStatus,
} from '../types/models';
import type {
  InvoiceDraftLocator,
  InvoiceDraftRecord,
} from '../types/invoiceDraftDurability';
import type { InvoiceFinalizationRecovery } from '../services/invoice/invoiceFinalizationCoordinator';
import type { TranslationKey } from '../i18n';

type RechnungStep = 'positions' | 'preview' | 'edit';

/*
 * Beide Werte müssen exakt so entstehen wie im Preflight des Coordinators —
 * eine abweichende Ableitung führte dort zu `scope_mismatch`.
 */
function resolveActiveScopeKey(): string {
  try {
    return buildDocumentBlobScopeKey(getActiveStorageScope());
  } catch {
    return '';
  }
}

function resolveActiveWorkspaceId(): string {
  try {
    return resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  } catch {
    return '';
  }
}

const TAX_OPTIONS: TaxStatus[] = [
  'standard_19',
  'standard_7',
  'kleinunternehmer_19',
  'reverse_charge_13b',
  'tax_free',
];

export function RechnungPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { translate, showToast, setup } = useApp();
  const navigate = useNavigate();
  const invoiceType = parseInvoiceDocumentType(searchParams.get('type'));

  const [step, setStep] = useState<RechnungStep>('positions');
  const [showOverbillingConfirm, setShowOverbillingConfirm] = useState(false);
  const [applyContractSkonto, setApplyContractSkonto] = useState(false);
  const [reverseCharge13bConfirmed, setReverseCharge13bConfirmed] = useState(false);
  const [approving, setApproving] = useState(false);
  const [customerMasterConfirm, setCustomerMasterConfirm] = useState(false);
  const [customerMasterError, setCustomerMasterError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<TranslationKey[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<TranslationKey[]>([]);
  const approveLockRef = useRef(false);

  const vorgang = id ? getVorgangById(id) : undefined;
  const contractSkontoOffer = useMemo(
    () => (vorgang ? getContractSkontoOfferForVorgang(vorgang) : null),
    [vorgang],
  );
  const progressBillingAllowed = useMemo(() => {
    if (!vorgang?.createdFromInboxId) return false;
    const item = getInboxItemById(vorgang.createdFromInboxId);
    if (!item) return false;
    const intelligence = analyzeContractIntelligenceFromInbox(item);
    return intelligence?.progressBillingAllowed ?? false;
  }, [vorgang]);

  /*
   * INVOICE-DURABILITY-PRODUCTION-WIRING-01B — der Entwurf lebt nicht mehr im
   * React-Zustand, sondern in der dauerhaften Sitzung. Der Locator entsteht
   * aus aktivem Scope, Workspace, Vorgang und Rechnungsart; fehlt eines davon,
   * meldet die Sitzung `blocked_no_identity` und es wird nichts gespeichert.
   */
  const locator = useMemo<InvoiceDraftLocator | null>(() => {
    if (!id) return null;
    const sourceScopeKey = resolveActiveScopeKey();
    const workspaceId = resolveActiveWorkspaceId();
    if (!sourceScopeKey || !workspaceId) return null;
    return { sourceScopeKey, workspaceId, vorgangId: id, invoiceType };
  }, [id, invoiceType]);

  /*
   * Der Aufbau hängt bewusst **nicht** am Setup: ein Profilwechsel darf einen
   * bereits gespeicherten Entwurf nicht still neu erzeugen. `createDraft` wird
   * nur aufgerufen, wenn noch kein Datensatz existiert.
   */
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const createDraft = useCallback(
    () => (id ? buildInvoiceDraftForType(id, setupRef.current, invoiceType) : null),
    [id, invoiceType],
  );

  const session = useInvoiceDraftDurabilitySession({ locator, createDraft });
  const draft = session.draft;
  const sessionStatus = session.status;
  const mutateDraft = session.mutateDraft;

  useEffect(() => {
    setStep('positions');
    setApplyContractSkonto(false);
    setReverseCharge13bConfirmed(false);
    setValidationErrors([]);
    setValidationWarnings([]);
    approveLockRef.current = false;
    setApproving(false);
    setCustomerMasterConfirm(false);
    setCustomerMasterError(null);
  }, [id, invoiceType]);

  useEffect(() => {
    if (!draft || session.readOnly) return;
    const skontoText =
      applyContractSkonto && contractSkontoOffer ? contractSkontoOffer.text : '';
    if (draft.skontoText === skontoText) return;
    mutateDraft((prev) =>
      prev.skontoText === skontoText ? prev : updateInvoiceDraftMetadata(prev, { skontoText }),
    );
  }, [applyContractSkonto, contractSkontoOffer, draft, mutateDraft, session.readOnly]);

  /*
   * Eine unterbrochene Finalisierung wird genau **einmal** wiederaufgenommen —
   * auch unter StrictMode, weil der Wächter an der Datensatzidentität hängt
   * und nicht am Effektlauf.
   */
  const resumedKeyRef = useRef<string | null>(null);
  const retryLockRef = useRef(false);
  const [resumeRecovery, setResumeRecovery] = useState<InvoiceFinalizationRecovery | null>(null);

  /**
   * Einziger Wiederaufnahmeweg. Er ruft **ausschließlich**
   * `resumeInvoiceDraftFinalization` — niemals `startInvoiceDraftFinalization`,
   * damit nach einer begonnenen Finalisierung keine zweite Rechnung entsteht.
   */
  const runResume = useCallback(
    async (record: InvoiceDraftRecord): Promise<void> => {
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
          // Nur mit belegter Rechnung navigieren — sonst bleibt die Seite stehen.
          if (result.invoice) {
            navigate(`/vorgaenge/${record.vorgangId}/rechnungen/${result.invoice.id}`);
          }
          return;
        }
        /*
         * Der Recovery-Zustand wird verständlich abgebildet und steuert die
         * angebotene Aktion. Es wird nie selbsttätig erneut versucht.
         */
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
    if (sessionStatus !== 'finalization_pending') return;
    const record = session.record;
    if (!record) return;
    const key = `${record.recordKey}#${record.revision}`;
    if (resumedKeyRef.current === key) return;
    resumedKeyRef.current = key;
    void runResume(record);
  }, [sessionStatus, session.record, runResume]);

  /** Ausdrückliche Nutzeraktion — dieselbe Sperre wie der automatische Lauf. */
  const handleResumeRetry = () => {
    const record = session.record;
    if (!record) return;
    void runResume(record);
  };

  const finalizedInvoiceId = session.record?.finalization?.finalizedInvoiceId ?? null;

  const totals = draft ? calculateInvoiceTotals(draft, setup) : null;
  const printModel = useMemo(
    () => (draft ? buildInvoicePrintModel(draft, setup) : null),
    [draft, setup],
  );
  const overbillingWarnings = draft ? getOverbillingWarnings(draft) : [];
  const taxKey = `tax.${draft?.taxStatus ?? setup.taxStatus}` as TranslationKey;
  const materialKey = draft ? (`material.${draft.materialSource}` as TranslationKey) : null;

  if (!id || !vorgang) {
    return (
      <div className="page">
        <EmptyStateBlock
          title={translate('vorgang.notFound')}
          description=""
          testId="rechnung-not-found"
        />
        <Button variant="outline" onClick={() => navigate('/vorgaenge')}>
          {translate('common.back')}
        </Button>
      </div>
    );
  }

  if (vorgang.orderPositions.length === 0) {
    return (
      <div className="page">
        <button type="button" className="back-link" onClick={() => navigate(`/vorgaenge/${id}`)}>
          ← {translate('common.back')}
        </button>
        <p className="empty-state">{translate('vorgang.noOrderPositions')}</p>
      </div>
    );
  }

  /*
   * INVOICE-DURABILITY-PRODUCTION-WIRING-01B1 — Pilotentscheidung: das
   * Rechnungsmodul setzt einen angemeldeten Firmen-Workspace voraus. Ohne
   * gültigen Workspace-Scope entsteht **kein** Locator, also auch kein
   * Entwurf, kein Datenbankzugriff, kein Autosave und keine Freigabe. Das wird
   * ausdrücklich als Sperre angezeigt — nie als dauerhaftes „Laden…".
   */
  if (!locator || sessionStatus === 'blocked_no_identity') {
    return (
      <div className="page" data-testid="rechnung-blocked-no-workspace">
        <button type="button" className="back-link" onClick={() => navigate(`/vorgaenge/${id}`)}>
          ← {translate('common.back')}
        </button>
        <EmptyStateBlock
          title={translate('invoice.session.noWorkspaceTitle')}
          description={translate('invoice.session.noWorkspace')}
          testId="invoice-no-workspace"
        />
      </div>
    );
  }

  if (sessionStatus === 'blocked_conflict' || sessionStatus === 'blocked_storage') {
    const conflict = sessionStatus === 'blocked_conflict';
    return (
      <div className="page" data-testid="rechnung-blocked-session">
        <button type="button" className="back-link" onClick={() => navigate(`/vorgaenge/${id}`)}>
          ← {translate('common.back')}
        </button>
        <EmptyStateBlock
          title={translate('invoice.title')}
          description={translate(
            conflict ? 'invoice.session.conflict' : 'invoice.session.storage',
          )}
          testId={conflict ? 'invoice-session-conflict' : 'invoice-session-storage'}
        />
      </div>
    );
  }

  if (!draft || !printModel) {
    return (
      <div className="page">
        <p className="empty-state">{translate('common.loading')}</p>
      </div>
    );
  }

  /*
   * Eine laufende oder bereits abgeschlossene Finalisierung sperrt Bearbeitung
   * und Freigabe gleichermaßen.
   */
  const finalizationLocked =
    sessionStatus === 'finalization_pending' || sessionStatus === 'already_finalized';

  const pageTitle = draft
    ? getInvoiceDocumentTitle(draft.type, draft.abschlagNumber)
    : translate('invoice.title');

  const handleApplyAllPositions = () => {
    mutateDraft((prev) => applyAllOpenPositionsToDraft(prev));
  };

  const handleTypeChange = (type: InvoiceDocumentType) => {
    navigate(`/vorgaenge/${id}/rechnung?type=${type}`);
  };

  const handleTaxChange = (taxStatus: TaxStatus) => {
    if (taxStatus !== 'reverse_charge_13b') {
      setReverseCharge13bConfirmed(false);
    }
    mutateDraft((prev) => updateInvoiceDraftTaxStatus(prev, taxStatus));
  };

  const handleQuantityChange = (positionId: string, value: string) => {
    const qty = parseFloat(value) || 0;
    mutateDraft((prev) => updateDraftPositionQuantity(prev, positionId, qty));
  };

  const handleMetadataChange = (changes: InvoiceDraftMetadataChanges) => {
    mutateDraft((prev) => updateInvoiceDraftMetadata(prev, changes));
  };

  /**
   * CUSTOMER-FACHOBJEKT-05B — explicit takeover of the current customer master
   * data into this draft only. Strictly id-based: no name lookup, no fallback.
   */
  const customerIdOfVorgang = vorgang?.customerId?.trim() ?? '';
  const masterCustomer = customerIdOfVorgang ? getCustomerById(customerIdOfVorgang) : undefined;
  const masterBilling = masterCustomer ? billingFromCustomer(masterCustomer) : null;
  const masterAddressComplete = Boolean(
    masterCustomer?.street.trim() && masterCustomer.zip.trim() && masterCustomer.city.trim(),
  );
  const masterMatchesDraft = Boolean(
    masterBilling &&
      draft &&
      (Object.keys(masterBilling) as Array<keyof typeof masterBilling>).every(
        (field) => masterBilling[field] === draft.customerBilling[field],
      ),
  );

  const applyMasterBilling = () => {
    if (!vorgang) return;
    // Read the source again — the store may have changed since rendering.
    const current = customerIdOfVorgang ? getCustomerById(customerIdOfVorgang) : undefined;
    if (!current) {
      setCustomerMasterConfirm(false);
      setCustomerMasterError(translate('invoice.customerMaster.missing'));
      return;
    }
    mutateDraft((prev) =>
      updateInvoiceDraftMetadata(prev, { customerBilling: billingFromCustomer(current) }),
    );
    setCustomerMasterConfirm(false);
    setCustomerMasterError(null);
    showToast(translate('invoice.customerMaster.applied'));
  };

  const handleAbschlagModeChange = (mode: InvoiceCalculationMode) => {
    mutateDraft((prev) => setAbschlagDraftCalculationMode(prev, mode, setup));
    setValidationErrors([]);
  };

  const handleFixedAmountChange = (value: string) => {
    const parsed = Number(String(value).replace(',', '.'));
    mutateDraft((prev) =>
      updateInvoiceDraftFixedAmountNet(prev, Number.isFinite(parsed) ? parsed : 0),
    );
  };

  const runApproval = async () => {
    if (!id || !draft || approveLockRef.current || approving) return;
    /*
     * Gesperrte Sitzungszustände — `finalization_pending`, `already_finalized`,
     * Speicherfehler, Konflikt und fehlende Identität — erlauben keine
     * Finalisierung. Der Schreibschutz der Sitzung ist hier maßgeblich.
     */
    if (session.readOnly || session.blocked || !session.record) return;
    approveLockRef.current = true;
    setApproving(true);

    const validation = validateInvoiceDraftForApproval(
      draft,
      draft.companySnapshot,
      vorgang,
      { reverseCharge13bConfirmed },
    );

    const blockers = validation.blockingErrors;

    setValidationWarnings(validation.warnings.map((w) => w.messageKey));
    if (blockers.length > 0) {
      setValidationErrors(blockers.map((e) => e.messageKey));
      approveLockRef.current = false;
      setApproving(false);
      showToast(translate('invoice.approve.blocked'));
      return;
    }

    setValidationErrors([]);

    /*
     * Der zuletzt bearbeitete Stand muss dauerhaft gespeichert sein, bevor die
     * Finalisierung beginnt — der Coordinator arbeitet ausschließlich auf dem
     * gespeicherten Datensatz.
     */
    const flushed = await session.flush();
    if (!flushed.ok) {
      showToast(
        flushed.outcome === 'conflict'
          ? translate('invoice.approve.conflict')
          : translate('invoice.approve.localPersistPending'),
      );
      approveLockRef.current = false;
      setApproving(false);
      return;
    }

    const record = session.record;
    if (!record) {
      approveLockRef.current = false;
      setApproving(false);
      showToast(translate('invoice.approve.failed'));
      return;
    }

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
      overbillingAcknowledged: overbillingWarnings.length > 0,
    });

    if (!result.ok) {
      if (result.reason === 'offline_or_unconfigured') {
        showToast(translate('invoice.approve.offline'));
      } else if (result.reason === 'auth_missing') {
        showToast(translate('invoice.approve.auth'));
      } else if (
        result.reason === 'workspace_missing' ||
        result.reason === 'workspace_changed' ||
        result.reason === 'scope_mismatch'
      ) {
        showToast(translate('invoice.approve.workspace'));
      } else if (
        result.reason === 'conflict' ||
        result.reason === 'idempotency_conflict' ||
        result.reason === 'possible_existing_invoice'
      ) {
        showToast(translate('invoice.approve.conflict'));
      } else if (
        result.reason === 'local_persist_failed' ||
        result.reason === 'persist_failed'
      ) {
        showToast(translate('invoice.approve.localPersistPending'));
      } else {
        showToast(translate('invoice.approve.failed'));
      }
      /*
       * Nur ein ausdrücklich wiederholbarer Ausgang gibt die Freigabe wieder
       * frei. `reload_required` und `blocked` — darunter jeder ungewisse
       * Cloudzustand — bleiben gesperrt; ein zweiter Versuch könnte sonst eine
       * zweite Rechnung erzeugen.
       */
      if (result.recovery === 'retry_allowed') {
        approveLockRef.current = false;
        setApproving(false);
      }
      return;
    }

    showToast(
      result.archiveWarning
        ? translate('invoice.approve.archiveWarning')
        : translate('invoice.approved'),
    );
    navigate(`/vorgaenge/${id}/rechnungen/${result.invoice.id}`);
  };

  const handleApprove = () => {
    if (overbillingWarnings.length > 0) {
      setShowOverbillingConfirm(true);
      return;
    }
    runApproval();
  };

  const handleConfirmOverbilling = () => {
    setShowOverbillingConfirm(false);
    runApproval();
  };

  const showMaterialHint =
    draft.materialSource === 'auftraggeber' &&
    draft.positions.some((p) => p.category === 'material' && !p.billable);

  const showMissingPriceWarning =
    !isFixedAmountAbschlag(draft) && draft.positions.some((p) => p.unitPrice === 0);

  const isFixedAbschlag = isFixedAmountAbschlag(draft);
  const abschlagMode = resolveInvoiceCalculationMode(draft);

  const backTarget =
    step === 'positions'
      ? `/vorgaenge/${id}`
      : step === 'edit'
        ? 'preview'
        : 'positions';

  const handleBack = () => {
    if (backTarget === 'preview') {
      setStep('preview');
      return;
    }
    if (backTarget === 'positions') {
      setStep('positions');
      return;
    }
    navigate(backTarget);
  };

  return (
    <div className="page" data-testid="rechnung-page">
      <button type="button" className="back-link" onClick={handleBack}>
        ← {translate('common.back')}
      </button>

      <PageHeader
        title={pageTitle}
        subtitle={
          step === 'positions'
            ? translate('invoice.subtitle')
            : step === 'preview'
              ? translate('invoice.previewReady')
              : translate('invoice.editSubtitle')
        }
      />

      {step === 'positions' && (
        <>
          <Card className="invoice-type-picker" data-testid="invoice-type-picker">
            <p className="invoice-type-picker__label">{translate('invoice.typeLabel')}</p>
            <div className="chip-group">
              {CONTRACT_ORDER_INVOICE_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`chip ${draft.type === type ? 'chip--active' : ''}`}
                  data-testid={`invoice-type-${type}`}
                  onClick={() => handleTypeChange(type)}
                >
                  {translate(`invoice.type.${type}` as TranslationKey)}
                </button>
              ))}
            </div>
          </Card>

          {draft.type === 'abschlag' && (
            <Card className="invoice-type-picker" data-testid="invoice-abschlag-mode-picker">
              <p className="invoice-type-picker__label">
                {translate('invoice.calculationModeLabel')}
              </p>
              <div className="chip-group">
                <button
                  type="button"
                  className={`chip ${abschlagMode === 'quantity_based' ? 'chip--active' : ''}`}
                  data-testid="invoice-abschlag-mode-quantity"
                  onClick={() => handleAbschlagModeChange('quantity_based')}
                >
                  {translate('invoice.calculationMode.quantity')}
                </button>
                <button
                  type="button"
                  className={`chip ${abschlagMode === 'fixed_amount' ? 'chip--active' : ''}`}
                  data-testid="invoice-abschlag-mode-fixed"
                  onClick={() => handleAbschlagModeChange('fixed_amount')}
                >
                  {translate('invoice.calculationMode.fixed')}
                </button>
              </div>
            </Card>
          )}

          {progressBillingAllowed && (
            <p className="invoice-hint" data-testid="invoice-progress-billing-hint">
              {translate('invoice.progressBillingContractHint')}
            </p>
          )}

          {contractSkontoOffer && (
            <Card className="invoice-skonto-choice" data-testid="invoice-skonto-choice">
              <p className="invoice-type-picker__label">{translate('invoice.skontoFromContractTitle')}</p>
              <div className="chip-group">
                <button
                  type="button"
                  className={`chip ${!applyContractSkonto ? 'chip--active' : ''}`}
                  data-testid="invoice-skonto-no"
                  onClick={() => setApplyContractSkonto(false)}
                >
                  {translate('invoice.skontoFromContractNo')}
                </button>
                <button
                  type="button"
                  className={`chip ${applyContractSkonto ? 'chip--active' : ''}`}
                  data-testid="invoice-skonto-yes"
                  onClick={() => setApplyContractSkonto(true)}
                >
                  {translate('invoice.skontoFromContractYes')
                    .replace('{percent}', String(contractSkontoOffer.percent))
                    .replace('{days}', String(contractSkontoOffer.days))}
                </button>
              </div>
            </Card>
          )}

          {draft.companySnapshot.logoDataUrl && (
            <p className="hint-text invoice-brand-hint" data-testid="invoice-brand-logo-hint">
              {translate('invoice.logoFromProfile')}
            </p>
          )}

          {showMaterialHint && (
            <p className="invoice-hint invoice-hint--warning">
              {translate('invoice.materialAuftraggeberHint')}
            </p>
          )}

          {showMissingPriceWarning && (
            <p className="invoice-hint invoice-hint--warning">
              {translate('invoice.missingPriceWarning')}
            </p>
          )}

          {overbillingWarnings.length > 0 && (
            <div className="invoice-hint invoice-hint--warning">
              <strong>{translate('invoice.overbillingTitle')}</strong>
              <ul className="invoice-warn-list">
                {overbillingWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {isFixedAbschlag ? (
            <section className="section" data-testid="invoice-fixed-amount-section">
              <h2 className="section__title">{translate('invoice.fixedAmountNet')}</h2>
              <Card>
                <label className="invoice-edit__field">
                  <span className="invoice-edit__label">{translate('invoice.fixedAmountNet')}</span>
                  <input
                    type="number"
                    className="input"
                    min={0}
                    step="0.01"
                    value={draft.fixedAmountNet ?? ''}
                    data-testid="invoice-fixed-amount-net"
                    onChange={(event) => handleFixedAmountChange(event.target.value)}
                  />
                </label>
                <DataRow
                  label={translate('invoice.nextNumberPreview')}
                  value={draft.invoiceNumberPreview}
                />
                <DataRow label={translate('invoice.issueDate')} value={draft.issueDate} />
                <DataRow
                  label={translate('invoice.servicePeriod')}
                  value={`${draft.servicePeriodFrom} – ${draft.servicePeriodTo}`}
                />
                <DataRow label={translate('invoice.paymentDueDate')} value={draft.paymentDueDate} />
                {draft.baustelle ? (
                  <DataRow label={translate('confirmation.baustelle')} value={draft.baustelle} />
                ) : null}
              </Card>
            </section>
          ) : (
            <section className="section">
              <div className="section__header-row">
                <h2 className="section__title">{translate('invoice.positions')}</h2>
                <Button
                  variant="outline"
                  onClick={handleApplyAllPositions}
                  data-testid="invoice-apply-all-positions"
                >
                  {translate('invoice.applyAllPositions')}
                </Button>
              </div>
              {draft.positions.map((pos) => (
                <Card key={pos.id} className={!pos.billable ? 'invoice-pos--disabled' : ''}>
                  <p className="position-desc">{pos.description}</p>
                  <div className="invoice-leistungsstand">
                    <DataRow
                      label={translate('invoice.planned')}
                      value={`${pos.plannedQuantity} ${pos.unit}`}
                    />
                    {pos.executedQuantity !== undefined && (
                      <DataRow
                        label={translate('invoice.executed')}
                        value={`${pos.executedQuantity} ${pos.unit}`}
                      />
                    )}
                    <DataRow
                      label={translate('invoice.alreadyBilled')}
                      value={`${pos.billedQuantity} ${pos.unit}`}
                    />
                    <DataRow
                      label={translate('invoice.stillOpen')}
                      value={`${pos.openQuantity} ${pos.unit}`}
                    />
                  </div>
                  <div className="position-row">
                    <label className="position-field">
                      {translate('invoice.quantityThisInvoice')}
                      <input
                        type="number"
                        className="input input--small"
                        min="0"
                        max={pos.openQuantity}
                        step="0.5"
                        value={pos.quantity}
                        disabled={!pos.billable}
                        onChange={(e) => handleQuantityChange(pos.id, e.target.value)}
                      />
                    </label>
                    <span className="position-meta">
                      {translate('invoice.unitPrice')}: {pos.unitPrice.toLocaleString('de-DE')} € /{' '}
                      {pos.unit}
                    </span>
                    <span className="position-price">
                      {(pos.quantity * pos.unitPrice).toLocaleString('de-DE')} €
                    </span>
                  </div>
                  {!pos.billable && pos.category === 'material' && (
                    <p className="invoice-pos-hint">{translate('invoice.materialNotBillable')}</p>
                  )}
                </Card>
              ))}
            </section>
          )}

          {totals && (
            <Card>
              <DataRow
                label={translate('invoice.subtotal')}
                value={`${totals.subtotal.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
              />
              <DataRow label={translate('invoice.taxStatus')} value={translate(taxKey)} />
              {totals.taxRate > 0 && (
                <DataRow
                  label={`${translate('invoice.tax')} (${totals.taxRate} %)`}
                  value={`${totals.tax.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
                />
              )}
              <DataRow
                label={translate('invoice.total')}
                value={
                  <strong>
                    {totals.total.toLocaleString('de-DE', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{' '}
                    €
                  </strong>
                }
              />
              {materialKey && (
                <DataRow
                  label={translate('vorgang.materialSource')}
                  value={translate(materialKey)}
                />
              )}
            </Card>
          )}

          <div className="action-stack">
            <Button fullWidth onClick={() => setStep('preview')} data-testid="invoice-continue-preview">
              {translate('invoice.continueToPreview')}
            </Button>
            <Button variant="outline" fullWidth onClick={() => navigate(`/vorgaenge/${id}`)}>
              {translate('common.cancel')}
            </Button>
          </div>
        </>
      )}

      {step === 'preview' && (
        <>
          <InvoiceDocumentView model={printModel} />
          <p className="hint-text" data-testid="invoice-preview-hint">
            {translate('invoice.previewHint')}
          </p>

          {draft.taxStatus === 'reverse_charge_13b' ? (
            <Card className="invoice-13b-confirm" data-testid="invoice-13b-confirm">
              <label className="invoice-13b-confirm__label">
                <input
                  type="checkbox"
                  checked={reverseCharge13bConfirmed}
                  onChange={(event) => setReverseCharge13bConfirmed(event.target.checked)}
                  data-testid="invoice-13b-confirm-checkbox"
                />
                <span>{translate('invoice.reverseCharge.confirmLabel')}</span>
              </label>
              <p className="hint-text">{translate('invoice.reverseCharge.confirmHelp')}</p>
            </Card>
          ) : null}

          {validationErrors.length > 0 ? (
            <Card className="invoice-validation invoice-validation--errors" data-testid="invoice-validation-errors">
              <strong>{translate('invoice.validation.blockingTitle')}</strong>
              <ul>
                {validationErrors.map((key) => (
                  <li key={key}>{translate(key)}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          {validationWarnings.length > 0 ? (
            <Card className="invoice-validation invoice-validation--warnings" data-testid="invoice-validation-warnings">
              <strong>{translate('invoice.validation.warningTitle')}</strong>
              <ul>
                {validationWarnings.map((key) => (
                  <li key={key}>{translate(key)}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          {showOverbillingConfirm && (
            <Card className="invoice-confirm">
              <p>{translate('invoice.overbillingConfirm')}</p>
              <div className="invoice-confirm__actions">
                <Button variant="outline" onClick={() => setShowOverbillingConfirm(false)}>
                  {translate('common.cancel')}
                </Button>
                <Button onClick={handleConfirmOverbilling} data-testid="invoice-approve-anyway">
                  {translate('invoice.saveAnyway')}
                </Button>
              </div>
            </Card>
          )}

          {finalizationLocked ? (
            <Card className="invoice-validation" data-testid="invoice-session-locked">
              <p>
                {translate(
                  sessionStatus === 'already_finalized'
                    ? 'invoice.session.alreadyFinalized'
                    : 'invoice.session.finalizationPending',
                )}
              </p>
              {sessionStatus === 'already_finalized' && finalizedInvoiceId ? (
                <Button
                  onClick={() =>
                    navigate(`/vorgaenge/${id}/rechnungen/${finalizedInvoiceId}`)
                  }
                  data-testid="invoice-open-finalized"
                >
                  {translate('invoice.session.openFinalized')}
                </Button>
              ) : null}
              {sessionStatus === 'finalization_pending' && resumeRecovery === 'retry_allowed' ? (
                <Button onClick={handleResumeRetry} data-testid="invoice-resume-retry">
                  {translate('invoice.resume.retryAction')}
                </Button>
              ) : null}
              {sessionStatus === 'finalization_pending' && resumeRecovery === 'reload_required' ? (
                <Button
                  variant="outline"
                  onClick={() => window.location.reload()}
                  data-testid="invoice-resume-reload"
                >
                  {translate('invoice.resume.reloadAction')}
                </Button>
              ) : null}
            </Card>
          ) : null}

          <div className="action-stack">
            <Button
              fullWidth
              onClick={() => setStep('edit')}
              disabled={finalizationLocked}
              data-testid="invoice-edit"
            >
              {translate('invoice.edit')}
            </Button>
            {finalizationLocked ? null : (
              <Button
                fullWidth
                onClick={handleApprove}
                disabled={approving}
                data-testid="invoice-approve"
              >
                {approving ? translate('invoice.approve.working') : translate('invoice.approve')}
              </Button>
            )}
            <Button
              variant="outline"
              fullWidth
              onClick={() => setStep('positions')}
              data-testid="invoice-back-positions"
            >
              {translate('invoice.backToPositions')}
            </Button>
          </div>
        </>
      )}

      {step === 'edit' && (
        <>
          <Card>
            <fieldset className="invoice-edit__section">
              <legend>{translate('invoice.taxStatus')}</legend>
              <div className="chip-group">
                {TAX_OPTIONS.map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`chip ${draft.taxStatus === status ? 'chip--active' : ''}`}
                    data-testid={`invoice-tax-${status}`}
                    onClick={() => handleTaxChange(status)}
                  >
                    {translate(`tax.${status}` as TranslationKey)}
                  </button>
                ))}
              </div>
            </fieldset>
            <InvoiceDraftEditForm
              draft={draft}
              onChange={handleMetadataChange}
              customerMaster={
                masterCustomer && masterBilling ? (
                  <div className="invoice-customer-master" data-testid="invoice-customer-master">
                    <p className="hint-text" data-testid="invoice-customer-master-source">
                      {translate('invoice.customerMaster.source')}: {masterCustomer.name},{' '}
                      {`${masterCustomer.street}, ${masterCustomer.zip} ${masterCustomer.city}`.trim()}
                    </p>
                    <p className="hint-text">{translate('invoice.customerMaster.scope')}</p>

                    {customerMasterConfirm ? (
                      <Card data-testid="invoice-customer-master-confirm">
                        <p>{translate('invoice.customerMaster.confirmText')}</p>
                        <p className="hint-text">{translate('invoice.customerMaster.scope')}</p>
                        <div className="form-actions">
                          <Button
                            type="button"
                            data-testid="invoice-customer-master-apply"
                            onClick={applyMasterBilling}
                          >
                            {translate('invoice.customerMaster.confirmAction')}
                          </Button>
                          <Button
                            variant="secondary"
                            type="button"
                            data-testid="invoice-customer-master-cancel"
                            onClick={() => {
                              setCustomerMasterConfirm(false);
                              setCustomerMasterError(null);
                            }}
                          >
                            {translate('common.cancel')}
                          </Button>
                        </div>
                      </Card>
                    ) : (
                      <Button
                        variant="secondary"
                        type="button"
                        data-testid="invoice-customer-master-action"
                        disabled={!masterAddressComplete || masterMatchesDraft}
                        onClick={() => {
                          setCustomerMasterError(null);
                          if (masterMatchesDraft) return;
                          setCustomerMasterConfirm(true);
                        }}
                      >
                        {translate('invoice.customerMaster.action')}
                      </Button>
                    )}

                    {!masterAddressComplete && (
                      <p className="hint-text" data-testid="invoice-customer-master-incomplete">
                        {translate('invoice.customerMaster.incomplete')}
                      </p>
                    )}
                    {masterAddressComplete && masterMatchesDraft && (
                      <p className="hint-text" data-testid="invoice-customer-master-identical">
                        {translate('invoice.customerMaster.identical')}
                      </p>
                    )}
                    {customerMasterError && (
                      <p className="form-error" data-testid="invoice-customer-master-error">
                        {customerMasterError}
                      </p>
                    )}
                  </div>
                ) : customerMasterError ? (
                  // Source gone after the click: neither action nor source, but the
                  // reason stays visible until the draft is rebuilt.
                  <div
                    className="invoice-customer-master"
                    data-testid="invoice-customer-master-failed"
                  >
                    <p className="form-error" data-testid="invoice-customer-master-error">
                      {customerMasterError}
                    </p>
                  </div>
                ) : null
              }
            />
          </Card>
          <div className="action-stack">
            <Button fullWidth onClick={() => setStep('preview')} data-testid="invoice-back-preview">
              {translate('invoice.backToPreview')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
