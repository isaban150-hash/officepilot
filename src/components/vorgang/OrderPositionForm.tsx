import { useState } from 'react';
import { Button } from '../ui/Button';
import { NumericInput } from '../ui/NumericInput';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
import { useApp } from '../../context/AppContext';
import {
  canDeleteOrderPosition,
  canEditOrderPositionField,
  getPositionBillingStatus,
  hasFinalSchlussrechnung,
} from '../../services/invoiceService';
import { isContractPlanLocked } from '../../services/orderPlanIntegrityService';
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
  /* FINANZ-CORE-01A (RE-10) — ein halber Zwischenstand („1,") wird nicht gespeichert. */
  const [incomplete, setIncomplete] = useState<{ plannedQuantity?: boolean; unitPrice?: boolean }>({});
  const hasIncomplete = Boolean(incomplete.plannedQuantity || incomplete.unitPrice);

  const positionId = position?.id;
  const billing =
    mode === 'edit' && positionId ? getPositionBillingStatus(vorgang, positionId) : null;
  const planLocked = isContractPlanLocked(vorgang);
  const schlussLocked = hasFinalSchlussrechnung(vorgang);
  const formLocked = planLocked || schlussLocked;
  const canDelete =
    mode === 'edit' &&
    positionId &&
    !planLocked &&
    canDeleteOrderPosition(vorgang, positionId);

  const isFieldEditable = (field: Parameters<typeof canEditOrderPositionField>[2]) => {
    if (planLocked) return false;
    if (mode === 'add') return !schlussLocked;
    if (!positionId) return false;
    return canEditOrderPositionField(vorgang, positionId, field);
  };

  const handleSave = () => {
    setErrorKey(null);
    if (planLocked) {
      setErrorKey('order_plan_amendment_required');
      return;
    }
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

    /*
     * ORDER-POSITION-EDIT-DELETE-PERSISTENCE-01B — die dauerhafte Speicherung
     * ist jetzt fuer **beide** Modi Bestandteil des Erfolgs: `addOrderPosition`
     * und `updateOrderPosition` rollen bei fehlgeschlagener Persistenz zurueck
     * und melden `success: false`.
     *
     * Ein Fehler landet deshalb oben im `!result.success`-Zweig: Das Modal
     * bleibt offen, die Eingaben bleiben stehen, und der Nutzer sieht, woran es
     * lag. Die frühere Nachpruefung mit `getLastPersistSuccess()` entfaellt —
     * sie war ein zweiter, widerspruechlicher Persistenzanzeiger, der erst nach
     * dem Schliessen des Modals griff.
     */
    onSaved(result.vorgang);
    onClose();
    showToast(translate('position.saved'));
  };

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const handleDelete = () => {
    if (!positionId || !canDelete) return;
    setConfirmDeleteOpen(true);
  };
  /* UIUX-FOUNDATION-01G — Löschen erst nach Bestätigung im kanonischen Dialog. */
  const performDelete = () => {
    if (!positionId || !canDelete) return;

    const result = removeOrderPosition(vorgang.id, positionId);
    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }

    // Ebenso beim Loeschen: Erfolg heisst dauerhaft entfernt.
    onSaved(result.vorgang);
    onClose();
    showToast(translate('position.deleted'));
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

        {planLocked && (
          <p className="invoice-hint invoice-hint--warning">{translate('orderPlan.confirmedHint')}</p>
        )}
        {!planLocked && schlussLocked && (
          <p className="invoice-hint invoice-hint--warning">{translate('position.schlussLocked')}</p>
        )}

        {billing?.hasBilling && !formLocked && (
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
          {/*
            * FINANZ-CORE-01A (RE-10/A4) — deutsche Zahlen wie in den Editoren: `type="number"`
            * mit `parseFloat` las „1.200" als 1,2 und ließ beliebig viele Nachkommastellen zu.
            */}
          <NumericInput
            id="order-position-form-quantity"
            className="input"
            mode="decimal"
            strict
            min={billing?.billedQuantity ?? 0}
            value={draft.plannedQuantity}
            disabled={!isFieldEditable('plannedQuantity')}
            onChange={(value) => setDraft((prev) => ({ ...prev, plannedQuantity: value }))}
            onEditingValidityChange={(complete) =>
              setIncomplete((prev) => ({ ...prev, plannedQuantity: !complete }))
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
          <NumericInput
            id="order-position-form-unit-price"
            className="input"
            mode="decimal"
            strict
            min={0}
            maxFractionDigits={2}
            value={draft.unitPrice}
            disabled={!isFieldEditable('unitPrice')}
            onChange={(value) => setDraft((prev) => ({ ...prev, unitPrice: value }))}
            onEditingValidityChange={(complete) =>
              setIncomplete((prev) => ({ ...prev, unitPrice: !complete }))
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
          <Button
            fullWidth
            onClick={handleSave}
            disabled={planLocked || (schlussLocked && mode === 'edit') || hasIncomplete}
          >
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
      <SimpleConfirmDialog
        open={confirmDeleteOpen}
        title={translate('position.delete')}
        message={translate('position.deleteConfirm')}
        confirmLabel={translate('position.delete')}
        cancelLabel={translate('common.cancel')}
        dialogTestId="position-delete-dialog"
        confirmTestId="position-delete-confirm"
        cancelTestId="position-delete-cancel"
        onConfirm={() => {
          setConfirmDeleteOpen(false);
          performDelete();
          return true;
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
