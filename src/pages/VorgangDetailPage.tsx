import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { OrderPositionForm } from '../components/vorgang/OrderPositionForm';
import { Badge, Card, CardMeta, CardTitle, DataRow, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { formatPaperFilingInstruction } from '../services/analysisService';
import {
  canAddOrderPosition,
  canDeleteOrderPosition,
  getBilledQuantity,
  getOpenQuantity,
  getPositionBillingStatus,
  hasFinalSchlussrechnung,
  hasSchlussrechnung,
} from '../services/invoiceService';
import { hasMissingOrderPrice } from '../services/orderPositionFactory';
import { getVorgangById, removeOrderPosition } from '../services/vorgangService';
import type { OrderPosition, Vorgang, VorgangInvoice } from '../types/models';
import type { TranslationKey } from '../i18n';

function invoiceLabel(inv: VorgangInvoice, translate: (key: TranslationKey) => string): string {
  if (inv.type === 'schluss') {
    return translate('invoice.schlussLabel');
  }
  return `${translate('invoice.abschlagLabel')} ${inv.abschlagNumber ?? '?'}`;
}

type FormMode = { type: 'add' } | { type: 'edit'; position: OrderPosition } | null;

export function VorgangDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate } = useApp();
  const navigate = useNavigate();
  const [vorgang, setVorgang] = useState<Vorgang | undefined>(() =>
    id ? getVorgangById(id) : undefined,
  );
  const [formMode, setFormMode] = useState<FormMode>(null);

  const refreshVorgang = useCallback(() => {
    if (id) {
      setVorgang(getVorgangById(id));
    }
  }, [id]);

  useEffect(() => {
    refreshVorgang();
  }, [refreshVorgang]);

  if (!vorgang) {
    return (
      <div className="page">
        <p className="empty-state">Vorgang nicht gefunden.</p>
        <Button variant="outline" onClick={() => navigate('/vorgaenge')}>
          {translate('common.back')}
        </Button>
      </div>
    );
  }

  const statusKey = `status.${vorgang.status}` as TranslationKey;
  const materialKey = `material.${vorgang.materialSource}` as TranslationKey;
  const hasOrderPositions = vorgang.orderPositions.length > 0;
  const schlussExists = hasSchlussrechnung(vorgang);
  const positionsLocked = hasFinalSchlussrechnung(vorgang);
  const canAdd = canAddOrderPosition(vorgang);
  const missingPrice = hasMissingOrderPrice(vorgang.orderPositions);

  const abschlagInvoices = vorgang.invoices.filter((inv) => inv.type === 'abschlag');
  const schlussInvoices = vorgang.invoices.filter((inv) => inv.type === 'schluss');

  const handleSaved = (updated: Vorgang) => {
    setVorgang(updated);
  };

  return (
    <div className="page">
      <button type="button" className="back-link" onClick={() => navigate('/vorgaenge')}>
        ← {translate('common.back')}
      </button>

      <PageHeader title={vorgang.title} subtitle={vorgang.customer} />

      <Card>
        <DataRow label={translate('analysis.baustelle')} value={vorgang.baustelle} />
        <DataRow label="Status" value={<Badge tone="warning">{translate(statusKey)}</Badge>} />
        <DataRow label={translate('vorgang.materialSource')} value={translate(materialKey)} />
      </Card>

      <section className="section">
        <h2 className="section__title">{translate('vorgang.documents')}</h2>
        {vorgang.documents.length === 0 ? (
          <p className="empty-state">Keine Dokumente</p>
        ) : (
          vorgang.documents.map((doc) => {
            const typeKey = `docType.${doc.type}` as TranslationKey;
            return (
              <Card key={doc.id}>
                <CardTitle>{doc.name}</CardTitle>
                <CardMeta>{translate(typeKey)} · {doc.date}</CardMeta>
                {doc.paperFiling && (
                  <p className="filing-hint">{formatPaperFilingInstruction(doc.paperFiling)}</p>
                )}
              </Card>
            );
          })
        )}
      </section>

      <section className="section">
        <div className="section__header-row">
          <h2 className="section__title">{translate('vorgang.orderPositions')}</h2>
          {canAdd && (
            <Button variant="outline" onClick={() => setFormMode({ type: 'add' })}>
              {translate('position.add')}
            </Button>
          )}
        </div>

        {positionsLocked && (
          <p className="invoice-hint invoice-hint--warning">{translate('position.schlussLocked')}</p>
        )}

        {!hasOrderPositions ? (
          <>
            <p className="invoice-hint invoice-hint--warning">{translate('vorgang.noOrderPositions')}</p>
            {canAdd && (
              <Button fullWidth onClick={() => setFormMode({ type: 'add' })}>
                {translate('position.addFirst')}
              </Button>
            )}
          </>
        ) : (
          <>
            {missingPrice && (
              <p className="invoice-hint invoice-hint--warning">{translate('vorgang.missingPriceHint')}</p>
            )}
            {vorgang.orderPositions.map((pos) => {
              const billing = getPositionBillingStatus(vorgang, pos.id);
              const billed = billing?.billedQuantity ?? getBilledQuantity(vorgang, pos.id);
              const open = billing?.openQuantity ?? getOpenQuantity(vorgang, pos.id);
              const deletable = canDeleteOrderPosition(vorgang, pos.id);

              return (
                <Card key={pos.id} className="order-position-card">
                  <CardTitle>{pos.description}</CardTitle>
                  <DataRow
                    label={translate('invoice.planned')}
                    value={`${pos.plannedQuantity} ${pos.unit}`}
                  />
                  <DataRow
                    label={translate('invoice.unitPrice')}
                    value={`${pos.unitPrice.toLocaleString('de-DE')} €`}
                  />
                  <DataRow
                    label={translate('invoice.alreadyBilled')}
                    value={`${billed} ${pos.unit}`}
                  />
                  <DataRow
                    label={translate('invoice.stillOpen')}
                    value={`${open} ${pos.unit}`}
                  />
                  {pos.unitPrice === 0 && (
                    <p className="invoice-pos-hint">{translate('vorgang.missingPriceHint')}</p>
                  )}
                  {billing?.hasBilling && !positionsLocked && (
                    <p className="invoice-pos-hint">{translate('position.billedLockHint')}</p>
                  )}
                  <div className="order-position-card__actions">
                    {!positionsLocked && (
                      <Button variant="outline" onClick={() => setFormMode({ type: 'edit', position: pos })}>
                        {translate('position.edit')}
                      </Button>
                    )}
                    {deletable && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (window.confirm(translate('position.deleteConfirm'))) {
                            const result = removeOrderPosition(vorgang.id, pos.id);
                            if (result.success) setVorgang(result.vorgang);
                          }
                        }}
                      >
                        {translate('position.delete')}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">{translate('vorgang.tasks')}</h2>
        {vorgang.tasks.map((task) => (
          <Card key={task.id} className={task.done ? 'card--done' : ''}>
            <CardTitle>{task.title}</CardTitle>
            {task.dueDate && <CardMeta>Frist: {task.dueDate}</CardMeta>}
          </Card>
        ))}
      </section>

      <section className="section">
        <h2 className="section__title">{translate('vorgang.photos')}</h2>
        {vorgang.photos.length === 0 ? (
          <p className="empty-state">Keine Fotos</p>
        ) : (
          vorgang.photos.map((photo) => (
            <Card key={photo.id}>
              <CardTitle>📷 {photo.caption}</CardTitle>
              <CardMeta>{photo.date}</CardMeta>
            </Card>
          ))
        )}
      </section>

      <section className="section">
        <h2 className="section__title">{translate('vorgang.invoices')}</h2>
        {vorgang.invoices.length === 0 ? (
          <p className="empty-state">{translate('vorgang.noInvoices')}</p>
        ) : (
          <>
            {abschlagInvoices.map((inv) => (
              <Card key={inv.id}>
                <CardTitle>{invoiceLabel(inv, translate)}</CardTitle>
                <CardMeta>
                  {inv.number} · {inv.subtotal.toLocaleString('de-DE')} € netto · {inv.status}
                </CardMeta>
              </Card>
            ))}
            {schlussInvoices.map((inv) => (
              <Card key={inv.id}>
                <CardTitle>{invoiceLabel(inv, translate)}</CardTitle>
                <CardMeta>
                  {inv.number} · {inv.subtotal.toLocaleString('de-DE')} € netto · {inv.status}
                </CardMeta>
              </Card>
            ))}
          </>
        )}
      </section>

      <div className="action-stack">
        {hasOrderPositions && (
          <>
            <Link to={`/vorgaenge/${vorgang.id}/rechnung?type=abschlag`}>
              <Button fullWidth>{translate('vorgang.prepareAbschlag')}</Button>
            </Link>
            {!schlussExists && (
              <Link to={`/vorgaenge/${vorgang.id}/rechnung?type=schluss`}>
                <Button variant="outline" fullWidth>
                  {translate('vorgang.prepareSchluss')}
                </Button>
              </Link>
            )}
          </>
        )}
        <Link to="/papierarchiv">
          <Button variant="outline" fullWidth>{translate('vorgang.paperArchive')}</Button>
        </Link>
      </div>

      {formMode && (
        <OrderPositionForm
          mode={formMode.type}
          vorgang={vorgang}
          position={formMode.type === 'edit' ? formMode.position : undefined}
          onSaved={handleSaved}
          onClose={() => setFormMode(null)}
        />
      )}
    </div>
  );
}
