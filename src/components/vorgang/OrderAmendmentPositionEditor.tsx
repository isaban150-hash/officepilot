import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { Button } from '../ui/Button';
import { DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import {
  addOrderAmendmentDraftPosition,
  buildQuantityIncreaseDefaults,
  updateOrderAmendmentDraftPosition,
  type OrderAmendmentDraftPositionInput,
} from '../../services/orderAmendmentService';
import { formatOrderUnitDisplay } from '../../services/orderUnitMapper';
import type {
  OrderAmendmentChangeType,
  OrderAmendmentDraftPosition,
  OrderPositionCategory,
  OrderUnit,
  Vorgang,
} from '../../types/models';
import {
  formatAmendmentDecimalInput,
  formatAmendmentMoney,
  parseAmendmentDecimalInput,
  positionLineTotal,
  resolveParentPositionDescription,
  tryFocusAmendmentTarget,
} from './orderAmendmentUiHelpers';

const ORDER_UNITS: OrderUnit[] = ['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];
const CATEGORIES: OrderPositionCategory[] = ['arbeit', 'material', 'sonstiges'];

export type OrderAmendmentPositionEditorMode =
  | { type: 'add'; changeType: OrderAmendmentChangeType }
  | { type: 'edit'; position: OrderAmendmentDraftPosition };

export function orderAmendmentPositionEditorKey(
  mode: OrderAmendmentPositionEditorMode,
): string {
  if (mode.type === 'add') return `create:${mode.changeType}`;
  return `edit:${mode.position.id}`;
}

interface OrderAmendmentPositionEditorProps {
  mode: OrderAmendmentPositionEditorMode;
  vorgang: Vorgang;
  amendmentId: string;
  translate: (key: TranslationKey) => string;
  onSaved: () => void;
  onClose: () => void;
  onToast: (message: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Reports in-flight save so the panel can block mode switches / segment close. */
  onBusyChange?: (busy: boolean) => void;
}

type FieldKey =
  | 'parent'
  | 'description'
  | 'quantity'
  | 'unit'
  | 'unitPrice';

function emptyAddInput(): OrderAmendmentDraftPositionInput {
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

function emptyIncreaseInput(): OrderAmendmentDraftPositionInput {
  return {
    changeType: 'quantity_increase',
    description: '',
    quantity: 1,
    unit: 'Stück',
    unitPrice: 0,
    category: 'arbeit',
    billable: true,
    parentPositionId: undefined,
  };
}

function inputFromPosition(position: OrderAmendmentDraftPosition): OrderAmendmentDraftPositionInput {
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

export function OrderAmendmentPositionEditor({
  mode,
  vorgang,
  amendmentId,
  translate,
  onSaved,
  onClose,
  onToast,
  returnFocusRef,
  fallbackFocusRef,
  onBusyChange,
}: OrderAmendmentPositionEditorProps) {
  const titleId = useId();
  const summaryId = useId();
  const parentId = useId();
  const descriptionId = useId();
  const quantityId = useId();
  const unitId = useId();
  const unitPriceId = useId();
  const totalId = useId();
  const categoryId = useId();
  const billableId = useId();
  const moreDetailsId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(true);
  const saveGenerationRef = useRef(0);
  const savingRef = useRef(false);

  const changeType: OrderAmendmentChangeType =
    mode.type === 'add' ? mode.changeType : mode.position.changeType;

  const [input, setInput] = useState<OrderAmendmentDraftPositionInput>(() => {
    if (mode.type === 'edit') return inputFromPosition(mode.position);
    return mode.changeType === 'add' ? emptyAddInput() : emptyIncreaseInput();
  });
  const [quantityText, setQuantityText] = useState(() =>
    formatAmendmentDecimalInput(
      mode.type === 'edit' ? mode.position.quantity : 1,
    ),
  );
  const [unitPriceText, setUnitPriceText] = useState(() =>
    formatAmendmentDecimalInput(
      mode.type === 'edit' ? mode.position.unitPrice : 0,
    ),
  );
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const confirmedParents = vorgang.contractConfirmation?.positions ?? [];

  const parentOptions = useMemo(
    () =>
      confirmedParents.map((position) => ({
        id: position.id,
        label: `${position.description} · ${position.plannedQuantity} ${formatOrderUnitDisplay(position.unit, position.unitLabel)} · ${formatAmendmentMoney(position.unitPrice)}`,
        position,
      })),
    [confirmedParents],
  );

  const selectedParent = confirmedParents.find((p) => p.id === input.parentPositionId);
  const parentResolved =
    changeType !== 'quantity_increase'
      ? true
      : Boolean(input.parentPositionId) &&
        resolveParentPositionDescription(input.parentPositionId, confirmedParents).found &&
        Boolean(vorgang.orderPositions.find((p) => p.id === input.parentPositionId));

  const restoreFocusSafely = () => {
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (tryFocusAmendmentTarget(previous)) return;
      tryFocusAmendmentTarget(fallbackFocusRef?.current ?? null);
    });
  };

  const requestClose = () => {
    if (savingRef.current || saving) return;
    onClose();
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onBusyChange?.(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    previousFocusRef.current =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const raf = window.requestAnimationFrame(() => {
      const first =
        changeType === 'quantity_increase'
          ? dialogRef.current?.querySelector<HTMLElement>(`#${parentId}`)
          : dialogRef.current?.querySelector<HTMLElement>(`#${descriptionId}`);
      first?.focus();
    });
    return () => {
      window.cancelAnimationFrame(raf);
      restoreFocusSafely();
    };
    // Focus capture/restore runs once per mounted editor instance (key remounts).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount lifecycle
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (savingRef.current || saving) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  const quantityParsed = parseAmendmentDecimalInput(quantityText);
  const unitPriceParsed = parseAmendmentDecimalInput(unitPriceText);
  const lineTotal =
    quantityParsed !== null &&
    unitPriceParsed !== null &&
    quantityParsed > 0 &&
    unitPriceParsed >= 0
      ? positionLineTotal(quantityParsed, unitPriceParsed)
      : null;

  const validate = (): Partial<Record<FieldKey, string>> => {
    const next: Partial<Record<FieldKey, string>> = {};
    if (changeType === 'quantity_increase') {
      if (!input.parentPositionId) {
        next.parent = translate('orderAmendment.parentSelectRequired');
      } else if (!parentResolved) {
        next.parent = translate('orderAmendment.parentUnresolved');
      }
    }
    if (!input.description.trim()) {
      next.description = translate('orderAmendment.validation.descriptionRequired');
    }
    if (quantityText.trim() === '' || quantityParsed === null) {
      next.quantity = translate('orderAmendment.validation.quantityRequired');
    } else if (quantityParsed <= 0) {
      next.quantity = translate('orderAmendment.validation.quantityPositive');
    }
    if (!input.unit) {
      next.unit = translate('orderAmendment.validation.unitRequired');
    }
    if (unitPriceText.trim() === '' || unitPriceParsed === null) {
      next.unitPrice = translate('orderAmendment.validation.unitPriceRequired');
    } else if (unitPriceParsed < 0) {
      next.unitPrice = translate('orderAmendment.validation.unitPriceNonNegative');
    }
    return next;
  };

  const focusFirstError = (nextErrors: Partial<Record<FieldKey, string>>) => {
    const order: FieldKey[] = ['parent', 'description', 'quantity', 'unit', 'unitPrice'];
    const first = order.find((key) => nextErrors[key]);
    const idMap: Record<FieldKey, string> = {
      parent: parentId,
      description: descriptionId,
      quantity: quantityId,
      unit: unitId,
      unitPrice: unitPriceId,
    };
    if (first) {
      queueMicrotask(() => document.getElementById(idMap[first])?.focus());
    }
  };

  const handleParentChange = (parentPositionId: string) => {
    if (!parentPositionId) {
      setInput((current) => ({ ...current, parentPositionId: undefined }));
      return;
    }
    const defaults = buildQuantityIncreaseDefaults(vorgang.id, parentPositionId);
    if (!defaults.success) {
      setInput((current) => ({ ...current, parentPositionId }));
      setErrors((current) => ({
        ...current,
        parent: translate('orderAmendment.parentUnresolved'),
      }));
      return;
    }
    setInput(defaults.defaults);
    setQuantityText(formatAmendmentDecimalInput(defaults.defaults.quantity));
    setUnitPriceText(formatAmendmentDecimalInput(defaults.defaults.unitPrice));
    setErrors((current) => {
      const { parent: _removed, ...rest } = current;
      return rest;
    });
  };

  const finishBusy = () => {
    savingRef.current = false;
    if (mountedRef.current) {
      setSaving(false);
    }
    onBusyChange?.(false);
  };

  const handleSave = async () => {
    if (savingRef.current || saving) return;
    setAttempted(true);
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setFormError(
        Object.keys(nextErrors).length > 1
          ? translate('orderAmendment.editor.summaryTitle')
          : null,
      );
      focusFirstError(nextErrors);
      return;
    }
    if (quantityParsed === null || unitPriceParsed === null) return;

    const payload: OrderAmendmentDraftPositionInput = {
      changeType,
      description: input.description,
      quantity: quantityParsed,
      unit: input.unit,
      unitLabel: input.unitLabel,
      unitPrice: unitPriceParsed,
      category: input.category,
      billable: input.billable,
      parentPositionId:
        changeType === 'quantity_increase' ? input.parentPositionId : undefined,
    };

    const generation = ++saveGenerationRef.current;
    savingRef.current = true;
    setSaving(true);
    setFormError(null);
    onBusyChange?.(true);

    try {
      const result =
        mode.type === 'add'
          ? await Promise.resolve(
              addOrderAmendmentDraftPosition(vorgang.id, amendmentId, payload),
            )
          : await Promise.resolve(
              updateOrderAmendmentDraftPosition(
                vorgang.id,
                amendmentId,
                mode.position.id,
                payload,
              ),
            );

      if (generation !== saveGenerationRef.current) return;

      if (!result.success) {
        if (mountedRef.current) {
          setFormError(translate('orderAmendment.editor.saveFailed'));
        }
        finishBusy();
        return;
      }

      onToast(
        translate(
          mode.type === 'add'
            ? 'orderAmendment.positionAdded'
            : 'orderAmendment.positionUpdated',
        ),
      );
      onSaved();
      // Clear busy before close so panel segment-effect can run if needed.
      finishBusy();
      if (mountedRef.current) {
        onClose();
      }
    } catch {
      if (generation !== saveGenerationRef.current) return;
      if (mountedRef.current) {
        setFormError(translate('orderAmendment.editor.saveFailed'));
      }
      finishBusy();
    }
  };

  const title =
    mode.type === 'edit'
      ? translate('orderAmendment.editor.editTitle')
      : changeType === 'add'
        ? translate('orderAmendment.editor.addTitle')
        : translate('orderAmendment.editor.increaseTitle');

  const errorCount = Object.keys(errors).length;
  const showSummary = attempted && errorCount > 1;
  const describedBy =
    showSummary || formError
      ? [showSummary ? summaryId : null, formError ? `${summaryId}-form` : null]
          .filter(Boolean)
          .join(' ')
      : undefined;

  return (
    <div
      className="vorgang-dialog-backdrop"
      role="presentation"
      data-testid="order-amendment-position-editor-backdrop"
      onClick={() => {
        requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="vorgang-dialog order-amendment-position-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        data-testid="order-amendment-position-editor"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} className="vorgang-dialog__title">
          {title}
        </h3>

        {showSummary ? (
          <p
            id={summaryId}
            className="invoice-hint invoice-hint--warning"
            role="alert"
            data-testid="order-amendment-editor-summary"
          >
            {translate('orderAmendment.editor.summaryTitle')}
          </p>
        ) : null}
        {formError ? (
          <p
            id={`${summaryId}-form`}
            className="invoice-hint invoice-hint--warning"
            role="alert"
            data-testid="order-amendment-editor-error"
          >
            {formError}
          </p>
        ) : null}

        {changeType === 'quantity_increase' ? (
          <>
            <label className="form-group" htmlFor={parentId}>
              <span>{translate('orderAmendment.parentPosition')}</span>
              <select
                id={parentId}
                className="input"
                data-testid="order-amendment-parent-select"
                value={input.parentPositionId ?? ''}
                disabled={saving}
                aria-invalid={errors.parent ? true : undefined}
                aria-describedby={errors.parent ? `${parentId}-error` : undefined}
                onChange={(event) => handleParentChange(event.target.value)}
              >
                <option value="">{translate('orderAmendment.parentSelectRequired')}</option>
                {parentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {errors.parent ? (
              <p id={`${parentId}-error`} className="field-error" role="alert">
                {errors.parent}
              </p>
            ) : null}
            {selectedParent && parentResolved ? (
              <div
                className="order-amendment-parent-summary"
                data-testid="order-amendment-parent-summary"
              >
                <DataRow
                  label={translate('orderAmendment.parentPosition')}
                  value={selectedParent.description}
                />
                <DataRow
                  label={translate('orderAmendment.originalQuantity')}
                  value={`${selectedParent.plannedQuantity} ${formatOrderUnitDisplay(selectedParent.unit, selectedParent.unitLabel)}`}
                />
                <DataRow
                  label={translate('orderAmendment.field.unitPrice')}
                  value={formatAmendmentMoney(selectedParent.unitPrice)}
                />
              </div>
            ) : null}
          </>
        ) : null}

        <label className="form-group" htmlFor={descriptionId}>
          <span>{translate('orderAmendment.field.description')}</span>
          <input
            id={descriptionId}
            className="input"
            data-testid="order-amendment-description"
            value={input.description}
            disabled={saving}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={errors.description ? `${descriptionId}-error` : undefined}
            onChange={(event) =>
              setInput((current) => ({ ...current, description: event.target.value }))
            }
          />
        </label>
        {errors.description ? (
          <p id={`${descriptionId}-error`} className="field-error" role="alert">
            {errors.description}
          </p>
        ) : null}

        <div className="order-amendment-editor-grid">
          <div>
            <label className="form-group" htmlFor={quantityId}>
              <span>
                {changeType === 'quantity_increase'
                  ? translate('orderAmendment.additionalQuantity')
                  : translate('orderAmendment.field.quantity')}
              </span>
              <input
                id={quantityId}
                className="input"
                inputMode="decimal"
                data-testid="order-amendment-quantity"
                value={quantityText}
                disabled={saving}
                aria-invalid={errors.quantity ? true : undefined}
                aria-describedby={errors.quantity ? `${quantityId}-error` : undefined}
                onChange={(event) => setQuantityText(event.target.value)}
              />
            </label>
            {errors.quantity ? (
              <p id={`${quantityId}-error`} className="field-error" role="alert">
                {errors.quantity}
              </p>
            ) : null}
          </div>
          <div>
            <label className="form-group" htmlFor={unitId}>
              <span>{translate('orderAmendment.field.unit')}</span>
              <select
                id={unitId}
                className="input"
                data-testid="order-amendment-unit"
                value={input.unit}
                disabled={saving}
                aria-invalid={errors.unit ? true : undefined}
                aria-describedby={errors.unit ? `${unitId}-error` : undefined}
                onChange={(event) =>
                  setInput((current) => ({
                    ...current,
                    unit: event.target.value as OrderUnit,
                  }))
                }
              >
                {ORDER_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </label>
            {errors.unit ? (
              <p id={`${unitId}-error`} className="field-error" role="alert">
                {errors.unit}
              </p>
            ) : null}
          </div>
        </div>

        <div className="order-amendment-editor-grid">
          <div>
            <label className="form-group" htmlFor={unitPriceId}>
              <span>{translate('orderAmendment.field.unitPrice')}</span>
              <input
                id={unitPriceId}
                className="input"
                inputMode="decimal"
                data-testid="order-amendment-unit-price"
                value={unitPriceText}
                disabled={saving}
                aria-invalid={errors.unitPrice ? true : undefined}
                aria-describedby={errors.unitPrice ? `${unitPriceId}-error` : undefined}
                onChange={(event) => setUnitPriceText(event.target.value)}
              />
            </label>
            {errors.unitPrice ? (
              <p id={`${unitPriceId}-error`} className="field-error" role="alert">
                {errors.unitPrice}
              </p>
            ) : null}
          </div>
          <div>
            <p className="form-group">
              <span id={totalId}>{translate('orderAmendment.editor.total')}</span>
              <strong
                className="order-amendment-editor-total"
                data-testid="order-amendment-line-total"
                aria-labelledby={totalId}
              >
                {lineTotal === null
                  ? translate('orderAmendment.editor.totalEmpty')
                  : formatAmendmentMoney(lineTotal)}
              </strong>
            </p>
          </div>
        </div>

        <div className="order-amendment-more-details">
          <Button
            type="button"
            variant="ghost"
            aria-expanded={moreOpen}
            aria-controls={moreDetailsId}
            disabled={saving}
            onClick={() => setMoreOpen((open) => !open)}
            data-testid="order-amendment-more-details-toggle"
          >
            {translate('orderAmendment.editor.moreDetails')}
          </Button>
          {moreOpen ? (
            <div id={moreDetailsId} data-testid="order-amendment-more-details">
              <label className="form-group" htmlFor={categoryId}>
                <span>{translate('orderAmendment.field.category')}</span>
                <select
                  id={categoryId}
                  className="input"
                  data-testid="order-amendment-category"
                  value={input.category ?? 'arbeit'}
                  disabled={saving}
                  onChange={(event) =>
                    setInput((current) => ({
                      ...current,
                      category: event.target.value as OrderPositionCategory,
                    }))
                  }
                >
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {translate(`position.category.${category}` as TranslationKey)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-group form-group--checkbox" htmlFor={billableId}>
                <input
                  id={billableId}
                  type="checkbox"
                  data-testid="order-amendment-billable"
                  checked={input.billable !== false}
                  disabled={saving}
                  aria-describedby={`${billableId}-hint`}
                  onChange={(event) =>
                    setInput((current) => ({
                      ...current,
                      billable: event.target.checked,
                    }))
                  }
                />
                <span>{translate('orderAmendment.field.billable')}</span>
              </label>
              <p id={`${billableId}-hint`} className="order-amendment-section__muted">
                {translate('orderAmendment.field.billableHint')}
              </p>
            </div>
          ) : null}
        </div>

        <div className="vorgang-dialog__actions">
          <Button
            fullWidth
            disabled={saving}
            loading={saving}
            onClick={() => void handleSave()}
            data-testid="order-amendment-save-position"
          >
            {translate('orderAmendment.savePosition')}
          </Button>
          <Button
            variant="ghost"
            fullWidth
            disabled={saving}
            onClick={requestClose}
            data-testid="order-amendment-cancel-edit"
          >
            {translate('orderAmendment.cancelEdit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
