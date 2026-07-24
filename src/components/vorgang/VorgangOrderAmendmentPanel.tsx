import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle, DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import {
  addOrderAmendmentDraftPosition,
  buildQuantityIncreaseDefaults,
  createOrderAmendmentDraft,
  deleteOrderAmendmentDraft,
  removeOrderAmendmentDraftPosition,
  updateOrderAmendmentDraft,
  updateOrderAmendmentDraftPosition,
  type OrderAmendmentDraftPositionInput,
  type OrderAmendmentErrorKey,
} from '../../services/orderAmendmentService';
import { hasFinalSchlussrechnung } from '../../services/orderBillingRules';
import { formatOrderUnitDisplay } from '../../services/orderUnitMapper';
import type {
  OrderAmendment,
  OrderAmendmentDraftPosition,
  OrderPositionCategory,
  OrderUnit,
  Vorgang,
} from '../../types/models';

const ORDER_UNITS: OrderUnit[] = ['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];
const CATEGORIES: OrderPositionCategory[] = ['arbeit', 'material', 'sonstiges'];

interface VorgangOrderAmendmentPanelProps {
  vorgang: Vorgang;
  translate: (key: TranslationKey) => string;
  onUpdated: () => void;
  onToast: (message: string) => void;
}

type EditorMode =
  | { type: 'closed' }
  | { type: 'add'; changeType: 'add' | 'quantity_increase' }
  | { type: 'edit'; positionId: string };

function emptyAddDraft(): OrderAmendmentDraftPositionInput {
  return {
    changeType: 'add',
    description: '',
    quantity: 1,
    unit: 'Stück',
    unitPrice: 0,
    category: 'arbeit',
    billable: true,
  };
}

function draftFromPosition(position: OrderAmendmentDraftPosition): OrderAmendmentDraftPositionInput {
  return {
    changeType: position.changeType,
    description: position.description,
    quantity: position.quantity,
    unit: position.unit,
    unitLabel: position.unitLabel,
    unitPrice: position.unitPrice,
    category: position.category,
    billable: position.billable,
    parentPositionId: position.parentPositionId,
  };
}

function toastError(
  translate: (key: TranslationKey) => string,
  onToast: (message: string) => void,
  errorKey: OrderAmendmentErrorKey,
): void {
  onToast(translate(errorKey as TranslationKey));
}

export function VorgangOrderAmendmentPanel({
  vorgang,
  translate,
  onUpdated,
  onToast,
}: VorgangOrderAmendmentPanelProps) {
  const amendments = vorgang.orderAmendments ?? [];
  const primaryAmendment: OrderAmendment | undefined = amendments[0];
  const schlussExists = hasFinalSchlussrechnung(vorgang);
  const confirmedParents = vorgang.contractConfirmation?.positions ?? [];

  const [editor, setEditor] = useState<EditorMode>({ type: 'closed' });
  const [draft, setDraft] = useState<OrderAmendmentDraftPositionInput>(emptyAddDraft);
  const [titleDraft, setTitleDraft] = useState(primaryAmendment?.title ?? '');
  const [reasonDraft, setReasonDraft] = useState(primaryAmendment?.reason ?? '');

  useEffect(() => {
    if (!primaryAmendment) {
      setTitleDraft('');
      setReasonDraft('');
      setEditor({ type: 'closed' });
      return;
    }
    setTitleDraft(primaryAmendment.title);
    setReasonDraft(primaryAmendment.reason ?? '');
  }, [primaryAmendment?.id, primaryAmendment?.title, primaryAmendment?.reason]);

  const parentOptions = useMemo(
    () =>
      confirmedParents.map((position) => ({
        id: position.id,
        label: `${position.description} (${position.plannedQuantity} ${formatOrderUnitDisplay(position.unit, position.unitLabel)})`,
      })),
    [confirmedParents],
  );

  if (!vorgang.contractConfirmation) {
    return null;
  }

  const openEditor = (mode: EditorMode, nextDraft: OrderAmendmentDraftPositionInput) => {
    setEditor(mode);
    setDraft(nextDraft);
  };

  const handlePrepare = () => {
    const result = createOrderAmendmentDraft(vorgang.id);
    if (!result.success) {
      toastError(translate, onToast, result.errorKey);
      return;
    }
    onUpdated();
    onToast(translate('orderAmendment.created'));
  };

  const handleSaveMeta = () => {
    if (!primaryAmendment) return;
    const result = updateOrderAmendmentDraft(vorgang.id, primaryAmendment.id, {
      title: titleDraft,
      reason: reasonDraft,
    });
    if (!result.success) {
      toastError(translate, onToast, result.errorKey);
      return;
    }
    onUpdated();
    onToast(translate('orderAmendment.updated'));
  };

  const handleDeleteDraft = () => {
    if (!primaryAmendment) return;
    if (!window.confirm(translate('orderAmendment.deleteConfirm'))) return;
    const result = deleteOrderAmendmentDraft(vorgang.id, primaryAmendment.id);
    if (!result.success) {
      toastError(translate, onToast, result.errorKey);
      return;
    }
    setEditor({ type: 'closed' });
    onUpdated();
    onToast(translate('orderAmendment.deleted'));
  };

  const startAdd = (changeType: 'add' | 'quantity_increase') => {
    if (!primaryAmendment) return;
    if (changeType === 'add') {
      openEditor({ type: 'add', changeType: 'add' }, emptyAddDraft());
      return;
    }
    const firstParent = confirmedParents[0];
    if (!firstParent) {
      onToast(translate('order_amendment_parent_position_not_found'));
      return;
    }
    const defaults = buildQuantityIncreaseDefaults(vorgang.id, firstParent.id);
    if (!defaults.success) {
      toastError(translate, onToast, defaults.errorKey);
      return;
    }
    openEditor({ type: 'add', changeType: 'quantity_increase' }, defaults.defaults);
  };

  const startEdit = (position: OrderAmendmentDraftPosition) => {
    openEditor({ type: 'edit', positionId: position.id }, draftFromPosition(position));
  };

  const handleParentChange = (parentPositionId: string) => {
    const defaults = buildQuantityIncreaseDefaults(vorgang.id, parentPositionId);
    if (!defaults.success) {
      toastError(translate, onToast, defaults.errorKey);
      return;
    }
    setDraft({
      ...defaults.defaults,
      quantity: draft.quantity > 0 ? draft.quantity : defaults.defaults.quantity,
      unitPrice: Number.isFinite(draft.unitPrice) ? draft.unitPrice : defaults.defaults.unitPrice,
    });
  };

  const handleSavePosition = () => {
    if (!primaryAmendment) return;
    if (editor.type === 'add') {
      const result = addOrderAmendmentDraftPosition(vorgang.id, primaryAmendment.id, {
        ...draft,
        changeType: editor.changeType,
        parentPositionId:
          editor.changeType === 'quantity_increase' ? draft.parentPositionId : undefined,
      });
      if (!result.success) {
        toastError(translate, onToast, result.errorKey);
        return;
      }
      setEditor({ type: 'closed' });
      onUpdated();
      onToast(translate('orderAmendment.positionAdded'));
      return;
    }
    if (editor.type === 'edit') {
      const result = updateOrderAmendmentDraftPosition(
        vorgang.id,
        primaryAmendment.id,
        editor.positionId,
        draft,
      );
      if (!result.success) {
        toastError(translate, onToast, result.errorKey);
        return;
      }
      setEditor({ type: 'closed' });
      onUpdated();
      onToast(translate('orderAmendment.positionUpdated'));
    }
  };

  const handleRemovePosition = (positionId: string) => {
    if (!primaryAmendment) return;
    const result = removeOrderAmendmentDraftPosition(vorgang.id, primaryAmendment.id, positionId);
    if (!result.success) {
      toastError(translate, onToast, result.errorKey);
      return;
    }
    if (editor.type === 'edit' && editor.positionId === positionId) {
      setEditor({ type: 'closed' });
    }
    onUpdated();
    onToast(translate('orderAmendment.positionRemoved'));
  };

  return (
    <section className="section" data-testid="vorgang-order-amendment-panel">
      <h2 className="section__title">{translate('orderAmendment.title')}</h2>

      {!primaryAmendment ? (
        <Card>
          <p className="invoice-hint invoice-hint--warning" data-testid="order-amendment-plan-hint">
            {translate('orderPlan.confirmedHint')}
          </p>
          <Button fullWidth onClick={handlePrepare} data-testid="order-amendment-prepare">
            {translate('orderAmendment.prepare')}
          </Button>
        </Card>
      ) : (
        <Card data-testid="order-amendment-draft-card">
          <CardTitle>
            {primaryAmendment.title}{' '}
            <span className="badge badge--warning" data-testid="order-amendment-draft-badge">
              {translate('orderAmendment.draftBadge')}
            </span>
          </CardTitle>
          <p
            className="invoice-hint"
            data-testid="order-amendment-unbinding-hint"
          >
            {translate('orderAmendment.unbindingHint')}
          </p>
          <p className="muted" data-testid="order-amendment-local-hint">
            {translate('orderAmendment.localOnlyHint')}
          </p>
          {schlussExists ? (
            <p
              className="invoice-hint invoice-hint--warning"
              data-testid="order-amendment-schluss-warning"
            >
              {translate('orderAmendment.schlussWarning')}
            </p>
          ) : null}

          <label className="form-group">
            <span>{translate('orderAmendment.field.title')}</span>
            <input
              className="input"
              data-testid="order-amendment-title"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={handleSaveMeta}
            />
          </label>
          <label className="form-group">
            <span>{translate('orderAmendment.field.reason')}</span>
            <textarea
              className="input"
              data-testid="order-amendment-reason"
              value={reasonDraft}
              onChange={(event) => setReasonDraft(event.target.value)}
              onBlur={handleSaveMeta}
              rows={2}
            />
          </label>

          <h3 className="section__subtitle">{translate('orderAmendment.positions')}</h3>
          {primaryAmendment.positions.length === 0 ? (
            <p className="empty-state" data-testid="order-amendment-empty-positions">
              {translate('orderAmendment.emptyPositions')}
            </p>
          ) : (
            primaryAmendment.positions.map((position) => (
              <Card key={position.id} data-testid={`order-amendment-position-${position.id}`}>
                <DataRow
                  label={translate(
                    `orderAmendment.changeType.${position.changeType}` as TranslationKey,
                  )}
                  value={position.description}
                />
                <DataRow
                  label={translate('orderAmendment.field.quantity')}
                  value={`${position.quantity} ${formatOrderUnitDisplay(position.unit, position.unitLabel)}`}
                />
                <DataRow
                  label={translate('orderAmendment.field.unitPrice')}
                  value={String(position.unitPrice)}
                />
                {position.parentPositionId ? (
                  <DataRow
                    label={translate('orderAmendment.parentPosition')}
                    value={
                      confirmedParents.find((p) => p.id === position.parentPositionId)
                        ?.description ?? position.parentPositionId
                    }
                  />
                ) : null}
                <div className="button-row">
                  <Button
                    variant="outline"
                    onClick={() => startEdit(position)}
                    data-testid={`order-amendment-edit-${position.id}`}
                  >
                    {translate('orderAmendment.editPosition')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleRemovePosition(position.id)}
                    data-testid={`order-amendment-remove-${position.id}`}
                  >
                    {translate('orderAmendment.deletePosition')}
                  </Button>
                </div>
              </Card>
            ))
          )}

          {editor.type !== 'closed' ? (
            <Card data-testid="order-amendment-position-editor">
              <CardTitle>
                {translate(`orderAmendment.changeType.${draft.changeType}` as TranslationKey)}
              </CardTitle>
              {draft.changeType === 'quantity_increase' ? (
                <label className="form-group">
                  <span>{translate('orderAmendment.parentPosition')}</span>
                  <select
                    className="input"
                    data-testid="order-amendment-parent-select"
                    value={draft.parentPositionId ?? ''}
                    onChange={(event) => handleParentChange(event.target.value)}
                  >
                    {parentOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="form-group">
                <span>{translate('orderAmendment.field.description')}</span>
                <input
                  className="input"
                  data-testid="order-amendment-description"
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <label className="form-group">
                <span>{translate('orderAmendment.field.quantity')}</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step="any"
                  data-testid="order-amendment-quantity"
                  value={draft.quantity}
                  onChange={(event) =>
                    setDraft({ ...draft, quantity: Number(event.target.value) })
                  }
                />
              </label>
              <label className="form-group">
                <span>{translate('orderAmendment.field.unit')}</span>
                <select
                  className="input"
                  data-testid="order-amendment-unit"
                  value={draft.unit}
                  onChange={(event) =>
                    setDraft({ ...draft, unit: event.target.value as OrderUnit })
                  }
                >
                  {ORDER_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-group">
                <span>{translate('orderAmendment.field.unitPrice')}</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step="any"
                  data-testid="order-amendment-unit-price"
                  value={draft.unitPrice}
                  onChange={(event) =>
                    setDraft({ ...draft, unitPrice: Number(event.target.value) })
                  }
                />
              </label>
              <label className="form-group">
                <span>{translate('orderAmendment.field.category')}</span>
                <select
                  className="input"
                  data-testid="order-amendment-category"
                  value={draft.category ?? 'arbeit'}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      category: event.target.value as OrderPositionCategory,
                    })
                  }
                >
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {translate(`position.category.${category}` as TranslationKey)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-group form-group--checkbox">
                <input
                  type="checkbox"
                  data-testid="order-amendment-billable"
                  checked={draft.billable !== false}
                  onChange={(event) => setDraft({ ...draft, billable: event.target.checked })}
                />
                <span>{translate('orderAmendment.field.billable')}</span>
              </label>
              <Button
                fullWidth
                onClick={handleSavePosition}
                data-testid="order-amendment-save-position"
              >
                {translate('orderAmendment.savePosition')}
              </Button>
              <Button
                variant="ghost"
                fullWidth
                onClick={() => setEditor({ type: 'closed' })}
                data-testid="order-amendment-cancel-edit"
              >
                {translate('orderAmendment.cancelEdit')}
              </Button>
            </Card>
          ) : (
            <div className="button-row">
              <Button
                variant="outline"
                fullWidth
                onClick={() => startAdd('add')}
                data-testid="order-amendment-add-position"
              >
                {translate('orderAmendment.addPosition')}
              </Button>
              <Button
                variant="outline"
                fullWidth
                onClick={() => startAdd('quantity_increase')}
                data-testid="order-amendment-add-quantity-increase"
              >
                {translate('orderAmendment.addQuantityIncrease')}
              </Button>
            </div>
          )}

          <Button
            variant="ghost"
            fullWidth
            onClick={handleDeleteDraft}
            data-testid="order-amendment-delete-draft"
          >
            {translate('orderAmendment.deleteDraft')}
          </Button>
        </Card>
      )}
    </section>
  );
}
