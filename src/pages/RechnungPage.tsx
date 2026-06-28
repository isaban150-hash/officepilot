import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
} from '../services/invoiceService';
import { getNextInvoiceNumberPreview } from '../services/invoiceNumberService';
import { getVorgangById } from '../services/vorgangService';
import type { InvoiceDraft } from '../types/models';
import type { TranslationKey } from '../i18n';

type InvoiceType = 'abschlag' | 'schluss';

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
  }, [id, invoiceType, setup]);

  const vorgang = id ? getVorgangById(id) : undefined;
  const totals = draft ? calculateInvoiceTotals(draft, setup) : null;
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

  if (!draft) {
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

  return (
    <div className="page">
      <button type="button" className="back-link" onClick={() => navigate(`/vorgaenge/${id}`)}>
        ← {translate('common.back')}
      </button>

      <PageHeader title={pageTitle} subtitle={translate('invoice.subtitle')} />

      <Card>
        <DataRow label={translate('invoice.number')} value={draft.invoiceNumberPreview} />
        <DataRow
          label={translate('invoice.nextNumberPreview')}
          value={getNextInvoiceNumberPreview()}
        />
        <DataRow label={translate('analysis.customer')} value={draft.customerBilling.name} />
        <DataRow label={translate('analysis.vorgang')} value={draft.vorgangTitle} />
        <DataRow label={translate('invoice.issueDate')} value={draft.issueDate} />
        <DataRow
          label={translate('invoice.servicePeriod')}
          value={`${draft.servicePeriodFrom} – ${draft.servicePeriodTo}`}
        />
        <DataRow label={translate('invoice.paymentDueDate')} value={draft.paymentDueDate} />
        <DataRow label={translate('invoice.paymentTerms')} value={draft.paymentTermsText} />
        {draft.skontoText && (
          <DataRow label={translate('invoice.skonto')} value={draft.skontoText} />
        )}
        <DataRow label={translate('invoice.taxStatus')} value={translate(taxKey)} />
        {materialKey && (
          <DataRow label={translate('vorgang.materialSource')} value={translate(materialKey)} />
        )}
      </Card>

      {draft.previousAbschlagDeductions.length > 0 && (
        <Card>
          <h3 className="section__title">{translate('invoice.previousAbschlag')}</h3>
          {draft.previousAbschlagDeductions.map((item) => (
            <DataRow
              key={item.invoiceId}
              label={item.invoiceNumber}
              value={`${item.amount.toLocaleString('de-DE')} €`}
            />
          ))}
        </Card>
      )}

      {showMaterialHint && (
        <p className="invoice-hint invoice-hint--warning">{translate('invoice.materialAuftraggeberHint')}</p>
      )}

      {showMissingPriceWarning && (
        <p className="invoice-hint invoice-hint--warning">{translate('invoice.missingPriceWarning')}</p>
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
                {translate('invoice.unitPrice')}: {pos.unitPrice.toLocaleString('de-DE')} € / {pos.unit}
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
        </Card>
      )}

      <p className="hint-text">{translate('invoice.previewHint')}</p>

      {showOverbillingConfirm && (
        <Card className="invoice-confirm">
          <p>{translate('invoice.overbillingConfirm')}</p>
          <div className="invoice-confirm__actions">
            <Button variant="outline" onClick={() => setShowOverbillingConfirm(false)}>
              {translate('inbox.edit.cancel')}
            </Button>
            <Button onClick={handleConfirmOverbilling}>{translate('invoice.saveAnyway')}</Button>
          </div>
        </Card>
      )}

      <div className="action-stack">
        <Button fullWidth onClick={handleSave}>
          {translate('invoice.savePreview')}
        </Button>
        <Button variant="outline" fullWidth onClick={() => navigate(`/vorgaenge/${id}`)}>
          {translate('common.back')}
        </Button>
      </div>
    </div>
  );
}
