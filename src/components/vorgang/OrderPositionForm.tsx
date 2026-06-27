import { useState } from 'react';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import {
  canDeleteOrderPosition,
  canEditOrderPositionField,
  getPositionBillingStatus,
  hasFinalSchlussrechnung,
} from '../../services/invoiceService';
import {
  addOrderPosition,
  removeOrderPosition,
  updateOrderPosition,
} from '../../services/vorgangService';
import type {
  OrderPosition,
  OrderPositionCategory,
  OrderUnit,
  Vorgang,
} from '../../types/models';
import type { TranslationKey } from '../../i18n';

const ORDER_UNITS: OrderUnit[] = ['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];

const CATEGORIES: OrderPositionCategory[] = ['arbeit', 'material', 'sonstiges'];

export interface OrderPositionFormDraft {
  description: string;
  plannedQuantity: number;
  unit: OrderUnit;
  unitPrice: number;
  category: OrderPositionCategory;
  billable: boolean;
}

function createEmptyDraft(): OrderPositionFormDraft {
  return {
    description: '',
    plannedQuantity: 1,
    unit: 'Pauschal',
    unitPrice: 0,
    category: 'arbeit',
    billable: true,
  };
}

function draftFromPosition(position: OrderPosition): OrderPositionFormDraft {
  return {
    description: position.description,
    plannedQuantity: position.plannedQuantity,
    unit: position.unit,
    unitPrice: position.unitPrice,
    category: position.category ?? 'arbeit',
    billable: position.billable ?? true,
  };
}

interface OrderPositionFormProps {
  mode: 'add' | 'edit';
  vorgang: Vorgang;
  position?: OrderPosition;
  onSaved: (vorgang: Vorgang) => void;
  onClose: () => void;
}

export function OrderPositionForm({
  mode,
  vorgang,
  position,
  onSaved,
  onClose,
}: OrderPositionFormProps) {
  const { translate, showToast } = useApp();
  const [draft, setDraft] = useState<OrderPositionFormDraft>(() =>
    mode === 'edit' && position ? draftFromPosition(position) : createEmptyDraft(),
  );
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const positionId = position?.id;
  const billing =
    mode === 'edit' && positionId ? getPositionBillingStatus(vorgang, positionId) : null;
  const schlussLocked = hasFinalSchlussrechnung(vorgang);
  const canDelete =
    mode === 'edit' && positionId ? canDeleteOrderPosition(vorgang, positionId) : false;

  const isFieldEditable = (field: Parameters<typeof canEditOrderPositionField>[2]) => {
    if (mode === 'add') return !schlussLocked;
    if (!positionId) return false;
    return canEditOrderPositionField(vorgang, positionId, field);
  };

  const handleSave = () => {
    setErrorKey(null);
    const payload = {
      description: draft.description,
      plannedQuantity: draft.plannedQuantity,
      unit: draft.unit,
      unitPrice: draft.unitPrice,
      category: draft.category,
      billable: draft.billable,
    };

    const result =
      mode === 'add'
        ? addOrderPosition(vorgang.id, payload)
        : positionId
          ? updateOrderPosition(vorgang.id, positionId, payload)
          : { success: false as const, errorKey: 'position.notFound' };

    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }

    showToast(translate('position.saved'));
    onSaved(result.vorgang);
    onClose();
  };

  const handleDelete = () => {
    if (!positionId || !canDelete) return;
    if (!window.confirm(translate('position.deleteConfirm'))) return;

    const result = removeOrderPosition(vorgang.id, positionId);
    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }

    showToast(translate('position.deleted'));
    onSaved(result.vorgang);
    onClose();
  };

  const titleKey =
    mode === 'add' ? 'position.addTitle' : ('position.editTitle' as TranslationKey);

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="vorgang-dialog order-position-form"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="vorgang-dialog__title">{translate(titleKey)}</h3>

        {schlussLocked && (
          <p className="invoice-hint invoice-hint--warning">{translate('position.schlussLocked')}</p>
        )}

        {billing?.hasBilling && !schlussLocked && (
          <p className="invoice-hint invoice-hint--warning">
            {translate('position.billedLockHint')}
          </p>
        )}

        {errorKey && (
          <p className="invoice-hint invoice-hint--warning">{translate(errorKey)}</p>
        )}

        {billing && (
          <div className="order-position-form__billing">
            <span>
              {translate('invoice.alreadyBilled')}: {billing.billedQuantity} ·{' '}
              {translate('invoice.stillOpen')}: {billing.openQuantity}
            </span>
          </div>
        )}

        <label className="edit-field">
          <span className="edit-field__label">{translate('position.description')}</span>
          <input
            type="text"
            className="input"
            value={draft.description}
            disabled={!isFieldEditable('description')}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>

        <label className="edit-field">
          <span className="edit-field__label">{translate('invoice.planned')}</span>
          <input
            type="number"
            className="input"
            min={billing?.billedQuantity ?? 0}
            step="0.5"
            value={draft.plannedQuantity}
            disabled={!isFieldEditable('plannedQuantity')}
            onChange={(e) =>
              setDraft({ ...draft, plannedQuantity: parseFloat(e.target.value) || 0 })
            }
          />
        </label>

        <label className="edit-field">
          <span className="edit-field__label">{translate('invoice.unit')}</span>
          <select
            className="input"
            value={draft.unit}
            disabled={!isFieldEditable('unit')}
            onChange={(e) => setDraft({ ...draft, unit: e.target.value as OrderUnit })}
          >
            {ORDER_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
        </label>

        <label className="edit-field">
          <span className="edit-field__label">{translate('invoice.unitPrice')}</span>
          <input
            type="number"
            className="input"
            min="0"
            step="0.01"
            value={draft.unitPrice}
            disabled={!isFieldEditable('unitPrice')}
            onChange={(e) =>
              setDraft({ ...draft, unitPrice: parseFloat(e.target.value) || 0 })
            }
          />
        </label>

        <fieldset className="edit-field">
          <span className="edit-field__label">{translate('position.category')}</span>
          <div className="chip-group">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`chip ${draft.category === cat ? 'chip--active' : ''}`}
                disabled={!isFieldEditable('category')}
                onClick={() => setDraft({ ...draft, category: cat })}
              >
                {translate(`position.category.${cat}` as TranslationKey)}
              </button>
            ))}
          </div>
        </fieldset>

        {draft.category === 'material' && (
          <label className="edit-field edit-field--checkbox">
            <input
              type="checkbox"
              checked={draft.billable}
              disabled={!isFieldEditable('billable')}
              onChange={(e) => setDraft({ ...draft, billable: e.target.checked })}
            />
            <span>{translate('position.billable')}</span>
          </label>
        )}

        <div className="vorgang-dialog__actions">
          <Button fullWidth onClick={handleSave} disabled={schlussLocked && mode === 'edit'}>
            {translate('common.save')}
          </Button>
          {mode === 'edit' && canDelete && (
            <Button variant="outline" fullWidth onClick={handleDelete}>
              {translate('position.delete')}
            </Button>
          )}
          <Button variant="ghost" fullWidth onClick={onClose}>
            {translate('inbox.edit.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
