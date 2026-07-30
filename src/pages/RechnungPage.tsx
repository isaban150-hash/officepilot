import { useEffect, useMemo, useRef, useState } from 'react';
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
import { finalizeInvoiceDraftWithCloud } from '../services/invoice/invoiceCloudFinalizeOrchestrator';
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
import { getVorgangById } from '../services/vorgangService';
import type {
  InvoiceCalculationMode,
  InvoiceDraft,
  InvoiceDraftMetadataChanges,
  InvoiceDocumentType,
  TaxStatus,
} from '../types/models';
import type { TranslationKey } from '../i18n';

type RechnungStep = 'positions' | 'preview' | 'edit';

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

  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [step, setStep] = useState<RechnungStep>('positions');
  const [showOverbillingConfirm, setShowOverbillingConfirm] = useState(false);
  const [applyContractSkonto, setApplyContractSkonto] = useState(false);
  const [reverseCharge13bConfirmed, setReverseCharge13bConfirmed] = useState(false);
  const [approving, setApproving] = useState(false);
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

  useEffect(() => {
    if (!id) {
      setDraft(null);
      return;
    }
    const next = buildInvoiceDraftForType(id, setup, invoiceType);
    setDraft(next);
    setStep('positions');
    setApplyContractSkonto(false);
    setReverseCharge13bConfirmed(false);
    setValidationErrors([]);
    setValidationWarnings([]);
    approveLockRef.current = false;
    setApproving(false);
  }, [id, invoiceType, setup]);

  useEffect(() => {
    if (!draft) return;
    const skontoText =
      applyContractSkonto && contractSkontoOffer ? contractSkontoOffer.text : '';
    setDraft((prev) =>
      prev && prev.skontoText !== skontoText
        ? updateInvoiceDraftMetadata(prev, { skontoText })
        : prev,
    );
  }, [applyContractSkonto, contractSkontoOffer, draft?.id]);

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

  if (!draft || !printModel) {
    return (
      <div className="page">
        <p className="empty-state">{translate('common.loading')}</p>
      </div>
    );
  }

  const pageTitle = draft
    ? getInvoiceDocumentTitle(draft.type, draft.abschlagNumber)
    : translate('invoice.title');

  const handleApplyAllPositions = () => {
    setDraft((prev) => (prev ? applyAllOpenPositionsToDraft(prev) : prev));
  };

  const handleTypeChange = (type: InvoiceDocumentType) => {
    navigate(`/vorgaenge/${id}/rechnung?type=${type}`);
  };

  const handleTaxChange = (taxStatus: TaxStatus) => {
    if (taxStatus !== 'reverse_charge_13b') {
      setReverseCharge13bConfirmed(false);
    }
    setDraft((prev) => (prev ? updateInvoiceDraftTaxStatus(prev, taxStatus) : prev));
  };

  const handleQuantityChange = (positionId: string, value: string) => {
    const qty = parseFloat(value) || 0;
    setDraft((prev) => (prev ? updateDraftPositionQuantity(prev, positionId, qty) : prev));
  };

  const handleMetadataChange = (changes: InvoiceDraftMetadataChanges) => {
    setDraft((prev) => (prev ? updateInvoiceDraftMetadata(prev, changes) : prev));
  };

  const handleAbschlagModeChange = (mode: InvoiceCalculationMode) => {
    setDraft((prev) => (prev ? setAbschlagDraftCalculationMode(prev, mode, setup) : prev));
    setValidationErrors([]);
  };

  const handleFixedAmountChange = (value: string) => {
    const parsed = Number(String(value).replace(',', '.'));
    setDraft((prev) =>
      prev ? updateInvoiceDraftFixedAmountNet(prev, Number.isFinite(parsed) ? parsed : 0) : prev,
    );
  };

  const runApproval = async () => {
    if (!id || !draft || approveLockRef.current || approving) return;
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
    const result = await finalizeInvoiceDraftWithCloud(id, draft, setup, {
      reverseCharge13bConfirmed,
    });
    if (!result.ok) {
      if (result.reason === 'validation_failed' && result.validation) {
        setValidationErrors(result.validation.blockingErrors.map((e) => e.messageKey));
        showToast(translate('invoice.approve.blocked'));
      } else if (result.reason === 'offline_or_unconfigured') {
        showToast(translate('invoice.approve.offline'));
      } else if (result.reason === 'auth_missing') {
        showToast(translate('invoice.approve.auth'));
      } else if (result.reason === 'workspace_missing') {
        showToast(translate('invoice.approve.workspace'));
      } else if (
        result.reason === 'idempotency_conflict' ||
        result.reason === 'local_conflict'
      ) {
        showToast(translate('invoice.approve.conflict'));
      } else {
        showToast(translate('invoice.approve.failed'));
      }
      approveLockRef.current = false;
      setApproving(false);
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

          <div className="action-stack">
            <Button fullWidth onClick={() => setStep('edit')} data-testid="invoice-edit">
              {translate('invoice.edit')}
            </Button>
            <Button
              fullWidth
              onClick={handleApprove}
              disabled={approving}
              data-testid="invoice-approve"
            >
              {approving ? translate('invoice.approve.working') : translate('invoice.approve')}
            </Button>
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
            <InvoiceDraftEditForm draft={draft} onChange={handleMetadataChange} />
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
