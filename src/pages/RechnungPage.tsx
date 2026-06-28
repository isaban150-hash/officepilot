import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocumentView } from '../components/invoice/InvoiceDocumentView';
import { InvoiceDraftEditForm } from '../components/invoice/InvoiceDraftEditForm';
import { Button } from '../components/ui/Button';
import { Card, DataRow, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  buildAbschlagDraft,
  buildSchlussrechnungDraft,
  calculateInvoiceTotals,
  finalizeInvoiceDraft,
  getOverbillingWarnings,
  updateDraftPositionQuantity,
  updateInvoiceDraftMetadata,
} from '../services/invoiceService';
import { buildInvoicePrintModel } from '../services/invoicePrintModel';
import { getVorgangById } from '../services/vorgangService';
import type { InvoiceDraft, InvoiceDraftMetadataChanges } from '../types/models';
import type { TranslationKey } from '../i18n';

type InvoiceType = 'abschlag' | 'schluss';
type RechnungStep = 'positions' | 'preview' | 'edit';

function resolveInvoiceType(searchParams: URLSearchParams): InvoiceType {
  const type = searchParams.get('type');
  return type === 'schluss' ? 'schluss' : 'abschlag';
}

export function RechnungPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { translate, showToast, setup } = useApp();
  const navigate = useNavigate();
  const invoiceType = resolveInvoiceType(searchParams);

  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [step, setStep] = useState<RechnungStep>('positions');
  const [showOverbillingConfirm, setShowOverbillingConfirm] = useState(false);

  useEffect(() => {
    if (!id) {
      setDraft(null);
      return;
    }
    const next =
      invoiceType === 'schluss'
        ? buildSchlussrechnungDraft(id, setup)
        : buildAbschlagDraft(id, setup);
    setDraft(next);
    setStep('positions');
  }, [id, invoiceType, setup]);

  const vorgang = id ? getVorgangById(id) : undefined;
  const totals = draft ? calculateInvoiceTotals(draft, setup) : null;
  const printModel = useMemo(
    () => (draft ? buildInvoicePrintModel(draft, setup) : null),
    [draft, setup],
  );
  const overbillingWarnings = draft ? getOverbillingWarnings(draft) : [];
  const taxKey = `tax.${setup.taxStatus}` as TranslationKey;
  const materialKey = draft ? (`material.${draft.materialSource}` as TranslationKey) : null;

  if (!id || !vorgang) {
    return (
      <div className="page">
        <p className="empty-state">Vorgang nicht gefunden.</p>
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

  const pageTitle =
    draft.type === 'schluss'
      ? translate('invoice.schlussTitle')
      : `${translate('invoice.abschlagTitle')} ${draft.abschlagNumber ?? 1}`;

  const handleQuantityChange = (positionId: string, value: string) => {
    const qty = parseFloat(value) || 0;
    setDraft((prev) => (prev ? updateDraftPositionQuantity(prev, positionId, qty) : prev));
  };

  const handleMetadataChange = (changes: InvoiceDraftMetadataChanges) => {
    setDraft((prev) => (prev ? updateInvoiceDraftMetadata(prev, changes) : prev));
  };

  const saveDraft = () => {
    const result = finalizeInvoiceDraft(id, draft, setup);
    if (!result) {
      showToast(translate('invoice.saveFailed'));
      return;
    }
    showToast(translate('invoice.saved'));
    navigate(`/vorgaenge/${id}`);
  };

  const handleSave = () => {
    if (overbillingWarnings.length > 0) {
      setShowOverbillingConfirm(true);
      return;
    }
    saveDraft();
  };

  const handleConfirmOverbilling = () => {
    setShowOverbillingConfirm(false);
    saveDraft();
  };

  const showMaterialHint =
    draft.materialSource === 'auftraggeber' &&
    draft.positions.some((p) => p.category === 'material' && !p.billable);

  const showMissingPriceWarning = draft.positions.some((p) => p.unitPrice === 0);

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
    <div className="page">
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

          <section className="section">
            <h2 className="section__title">{translate('invoice.positions')}</h2>
            {draft.positions.map((pos) => (
              <Card key={pos.id} className={!pos.billable ? 'invoice-pos--disabled' : ''}>
                <p className="position-desc">{pos.description}</p>
                <div className="invoice-leistungsstand">
                  <DataRow
                    label={translate('invoice.planned')}
                    value={`${pos.plannedQuantity} ${pos.unit}`}
                  />
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

          {totals && (
            <Card>
              <DataRow
                label={translate('invoice.subtotal')}
                value={`${totals.subtotal.toLocaleString('de-DE')} €`}
              />
              <DataRow label={translate('invoice.taxStatus')} value={translate(taxKey)} />
              {totals.taxRate > 0 && (
                <DataRow
                  label={`${translate('invoice.tax')} (${totals.taxRate} %)`}
                  value={`${totals.tax.toLocaleString('de-DE')} €`}
                />
              )}
              <DataRow
                label={translate('invoice.total')}
                value={<strong>{totals.total.toLocaleString('de-DE')} €</strong>}
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
            <Button fullWidth onClick={() => setStep('preview')}>
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
          <p className="hint-text">{translate('invoice.previewHint')}</p>

          {showOverbillingConfirm && (
            <Card className="invoice-confirm">
              <p>{translate('invoice.overbillingConfirm')}</p>
              <div className="invoice-confirm__actions">
                <Button variant="outline" onClick={() => setShowOverbillingConfirm(false)}>
                  {translate('common.cancel')}
                </Button>
                <Button onClick={handleConfirmOverbilling}>{translate('invoice.saveAnyway')}</Button>
              </div>
            </Card>
          )}

          <div className="action-stack">
            <Button fullWidth onClick={() => setStep('edit')}>
              {translate('invoice.edit')}
            </Button>
            <Button fullWidth onClick={handleSave}>
              {translate('invoice.finalize')}
            </Button>
            <Button variant="outline" fullWidth onClick={() => setStep('positions')}>
              {translate('invoice.backToPositions')}
            </Button>
          </div>
        </>
      )}

      {step === 'edit' && (
        <>
          <Card>
            <InvoiceDraftEditForm draft={draft} onChange={handleMetadataChange} />
          </Card>
          <div className="action-stack">
            <Button fullWidth onClick={() => setStep('preview')}>
              {translate('invoice.backToPreview')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
