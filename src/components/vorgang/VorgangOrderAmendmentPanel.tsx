import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Badge, Card, CardTitle, DataRow } from '../ui/Card';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
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
import { confirmOrderAmendmentWithCloud } from '../../services/orderAmendment/orderAmendmentCloudConfirmOrchestrator';
import {
  getOrderAmendmentConfirmIntent,
  isOrderAmendmentDraftLockedByIntent,
} from '../../services/orderAmendment/orderAmendmentConfirmIntentService';
import { hasFinalSchlussrechnung } from '../../services/orderBillingRules';
import { sortConfirmedOrderAmendments } from '../../services/orderPlanCompositionService';
import { formatOrderUnitDisplay } from '../../services/orderUnitMapper';
import type {
  OrderAmendment,
  OrderAmendmentDraftPosition,
  OrderPositionCategory,
  OrderUnit,
  Vorgang,
} from '../../types/models';
import { ConfirmedOrderAmendmentList } from './ConfirmedOrderAmendmentList';
import {
  OrderAmendmentStatusBanner,
  intentStateToStatusKind,
} from './OrderAmendmentStatusBanner';
import {
  formatAmendmentChangeTypeLabel,
  formatAmendmentMoney,
  positionLineTotal,
  resolveParentPositionDescription,
} from './orderAmendmentUiHelpers';

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

function isValidLookingPosition(position: OrderAmendmentDraftPosition): boolean {
  if (!position.description.trim()) return false;
  if (!Number.isFinite(position.quantity) || position.quantity <= 0) return false;
  if (!Number.isFinite(position.unitPrice) || position.unitPrice < 0) return false;
  if (position.changeType === 'quantity_increase' && !position.parentPositionId) return false;
  if (position.changeType === 'add' && position.parentPositionId) return false;
  return true;
}

export function VorgangOrderAmendmentPanel({
  vorgang,
  translate,
  onUpdated,
  onToast,
}: VorgangOrderAmendmentPanelProps) {
  const amendments = vorgang.orderAmendments ?? [];
  const primaryAmendment: OrderAmendment | undefined = amendments[0];
  const extraDraftCount = Math.max(0, amendments.length - 1);
  const confirmedAmendments = sortConfirmedOrderAmendments(vorgang.confirmedOrderAmendments);
  const schlussExists = hasFinalSchlussrechnung(vorgang);
  const confirmedParents = vorgang.contractConfirmation?.positions ?? [];

  const [editor, setEditor] = useState<EditorMode>({ type: 'closed' });
  const [draft, setDraft] = useState<OrderAmendmentDraftPositionInput>(emptyAddDraft);
  const [titleDraft, setTitleDraft] = useState(primaryAmendment?.title ?? '');
  const [reasonDraft, setReasonDraft] = useState(primaryAmendment?.reason ?? '');
  const [confirming, setConfirming] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const discardReturnFocusRef = useRef<HTMLElement | null>(null);

  const draftLocked = primaryAmendment
    ? isOrderAmendmentDraftLockedByIntent(vorgang.id, primaryAmendment.id)
    : false;
  const confirmIntent = primaryAmendment
    ? getOrderAmendmentConfirmIntent(vorgang.id, primaryAmendment.id)
    : null;
  const inputsDisabled = confirming || draftLocked;
  const lockedStatusKind = intentStateToStatusKind(confirmIntent?.state);

  const draftTotals = useMemo(() => {
    if (!primaryAmendment || primaryAmendment.positions.length === 0) return null;
    const lines = primaryAmendment.positions.map((position) => ({
      id: position.id,
      total: positionLineTotal(position.quantity, position.unitPrice),
    }));
    const grandTotal = Math.round(lines.reduce((sum, line) => sum + line.total, 0) * 100) / 100;
    return { lines, grandTotal };
  }, [primaryAmendment]);

  const canConfirm =
    Boolean(primaryAmendment) &&
    !schlussExists &&
    !confirming &&
    !draftLocked &&
    (primaryAmendment?.positions.some(isValidLookingPosition) ?? false);

  const validationMessage = useMemo(() => {
    if (!primaryAmendment) return null;
    if (primaryAmendment.positions.length === 0) {
      return translate('orderAmendment.validation.empty');
    }
    if (!primaryAmendment.positions.some(isValidLookingPosition)) {
      return translate('orderAmendment.validation.invalid');
    }
    if (schlussExists) {
      return translate('orderAmendment.schlussWarning');
    }
    return translate('orderAmendment.validation.ready');
  }, [primaryAmendment, schlussExists, translate]);

  useEffect(() => {
    if (!primaryAmendment) {
      setTitleDraft('');
      setReasonDraft('');
      setEditor({ type: 'closed' });
      setEditingMeta(false);
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
    return (
      <section className="section order-amendment-section" data-testid="vorgang-order-amendment-panel">
        <h2 ref={sectionHeadingRef} tabIndex={-1} className="section__title">
          {translate('orderAmendment.title')}
        </h2>
        <p className="order-amendment-section__intro">{translate('orderAmendment.sectionIntro')}</p>
        <Card>
          <p className="empty-state" data-testid="order-amendment-unavailable">
            {translate('orderAmendment.requiresConfirmation')}
          </p>
        </Card>
      </section>
    );
  }

  const openEditor = (mode: EditorMode, nextDraft: OrderAmendmentDraftPositionInput) => {
    if (inputsDisabled) return;
    setEditor(mode);
    setDraft(nextDraft);
  };

  const handlePrepare = () => {
    const result = createOrderAmendmentDraft(vorgang.id);
    if (!result.success) {
      toastError(translate, onToast, result.errorKey);
      return;
    }
    setEditingMeta(true);
    onUpdated();
    onToast(translate('orderAmendment.created'));
  };

  const handleSaveMeta = () => {
    if (!primaryAmendment || inputsDisabled) return;
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
    if (!primaryAmendment || inputsDisabled) return;
    discardReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDiscardOpen(true);
  };

  const confirmDeleteDraft = async (): Promise<boolean> => {
    if (!primaryAmendment || inputsDisabled) return false;
    try {
      const result = await Promise.resolve(
        deleteOrderAmendmentDraft(vorgang.id, primaryAmendment.id),
      );
      if (!result.success) {
        toastError(translate, onToast, result.errorKey);
        return false;
      }
      setEditor({ type: 'closed' });
      setEditingMeta(false);
      setDiscardOpen(false);
      onUpdated();
      onToast(translate('orderAmendment.deleted'));
      return true;
    } catch {
      return false;
    }
  };

  const startAdd = (changeType: 'add' | 'quantity_increase') => {
    if (!primaryAmendment || inputsDisabled) return;
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
    if (inputsDisabled) return;
    openEditor({ type: 'edit', positionId: position.id }, draftFromPosition(position));
  };

  const handleParentChange = (parentPositionId: string) => {
    if (inputsDisabled) return;
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
    if (!primaryAmendment || inputsDisabled) return;
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
    if (!primaryAmendment || inputsDisabled) return;
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

  const runConfirm = async (options?: { skipDialog?: boolean }) => {
    if (!primaryAmendment || confirming) return;
    if (schlussExists) return;
    if (!options?.skipDialog && !window.confirm(translate('orderAmendment.confirmDialog'))) {
      return;
    }
    setConfirming(true);
    try {
      const result = await confirmOrderAmendmentWithCloud(vorgang.id, primaryAmendment.id);
      if (result.ok) {
        onToast(translate('orderAmendment.confirmedSuccess'));
        onUpdated();
        return;
      }
      onToast(translate(result.errorKey as TranslationKey));
      if (result.draftLocked || result.intentRetained) {
        const retryKey =
          result.reason === 'local_persist_failed' ||
          result.reason === 'local_confirmation_conflict'
            ? 'orderAmendment.localApplyPending'
            : 'orderAmendment.outcomeUnknown';
        onToast(translate(retryKey));
      }
      onUpdated();
    } finally {
      setConfirming(false);
    }
  };

  const renderParentValue = (parentPositionId: string | undefined) => {
    if (!parentPositionId) return null;
    const parent = resolveParentPositionDescription(parentPositionId, confirmedParents);
    return parent.found
      ? translate('orderAmendment.parentReference').replace('{description}', parent.description)
      : translate('orderAmendment.parentUnresolved');
  };

  const hasAnyContent = Boolean(primaryAmendment) || confirmedAmendments.length > 0;

  return (
    <section className="section order-amendment-section" data-testid="vorgang-order-amendment-panel">
      <h2 ref={sectionHeadingRef} tabIndex={-1} className="section__title">
        {translate('orderAmendment.title')}
      </h2>
      <p className="order-amendment-section__intro">{translate('orderAmendment.sectionIntro')}</p>

      <div className="order-amendment-section__summary" data-testid="order-amendment-summary">
        <DataRow
          label={translate('orderAmendment.summary.confirmedCount')}
          value={String(confirmedAmendments.length)}
        />
        <DataRow
          label={translate('orderAmendment.summary.openDraft')}
          value={
            primaryAmendment
              ? translate('vorgang.orderSummary.openDraftYes')
              : translate('vorgang.orderSummary.openDraftNo')
          }
        />
      </div>

      {extraDraftCount > 0 ? (
        <p className="order-amendment-section__extra-drafts" data-testid="order-amendment-extra-drafts">
          {translate('orderAmendment.extraDraftsHint').replace('{count}', String(extraDraftCount))}
        </p>
      ) : null}

      {!hasAnyContent ? (
        <Card className="order-amendment-empty" data-testid="order-amendment-empty">
          <h3 className="order-amendment-empty__title">{translate('orderAmendment.emptyTitle')}</h3>
          <p className="empty-state">{translate('orderAmendment.emptyBody')}</p>
          <Button fullWidth onClick={handlePrepare} data-testid="order-amendment-prepare">
            {translate('orderAmendment.prepare')}
          </Button>
        </Card>
      ) : null}

      {primaryAmendment ? (
        <Card className="order-amendment-draft" data-testid="order-amendment-draft-card">
          <div className="order-amendment-draft__header">
            <CardTitle>{primaryAmendment.title}</CardTitle>
            <span data-testid="order-amendment-draft-badge">
              <Badge tone="warning">{translate('orderAmendment.draftBadge')}</Badge>
            </span>
          </div>

          <p className="invoice-hint" data-testid="order-amendment-unbinding-hint">
            {translate('orderAmendment.unbindingHint')}
          </p>
          <p className="order-amendment-section__muted" data-testid="order-amendment-local-hint">
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

          {confirming ? (
            <OrderAmendmentStatusBanner kind="confirming" translate={translate} confirming />
          ) : null}

          {!confirming && draftLocked && lockedStatusKind ? (
            <div data-testid="order-amendment-locked">
              <OrderAmendmentStatusBanner
                kind={lockedStatusKind}
                translate={translate}
                confirming={confirming}
                onRetry={() => void runConfirm({ skipDialog: true })}
              />
            </div>
          ) : null}

          <div className="order-amendment-draft__facts">
            {primaryAmendment.reason ? (
              <DataRow
                label={translate('orderAmendment.field.reason')}
                value={primaryAmendment.reason}
              />
            ) : null}
            <DataRow
              label={translate('orderAmendment.positions')}
              value={translate('orderAmendment.positionCount').replace(
                '{count}',
                String(primaryAmendment.positions.length),
              )}
            />
            {draftTotals ? (
              <div data-testid="order-amendment-totals">
                <DataRow
                  label={translate('orderAmendment.total')}
                  value={formatAmendmentMoney(draftTotals.grandTotal)}
                />
              </div>
            ) : null}
            {validationMessage ? (
              <p
                className="order-amendment-draft__validation"
                data-testid="order-amendment-validation"
              >
                {validationMessage}
              </p>
            ) : null}
          </div>

          {editingMeta ? (
            <>
              <label className="form-group">
                <span>{translate('orderAmendment.field.title')}</span>
                <input
                  className="input"
                  data-testid="order-amendment-title"
                  value={titleDraft}
                  disabled={inputsDisabled}
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
                  disabled={inputsDisabled}
                  onChange={(event) => setReasonDraft(event.target.value)}
                  onBlur={handleSaveMeta}
                  rows={2}
                />
              </label>
            </>
          ) : null}

          <h3 className="section__subtitle">{translate('orderAmendment.positions')}</h3>
          {primaryAmendment.positions.length === 0 ? (
            <p className="empty-state" data-testid="order-amendment-empty-positions">
              {translate('orderAmendment.emptyPositions')}
            </p>
          ) : (
            primaryAmendment.positions.map((position) => (
              <div
                key={position.id}
                className="order-amendment-position-row"
                data-testid={`order-amendment-position-${position.id}`}
              >
                <div className="order-amendment-position-row__header">
                  <Badge tone="info">
                    {formatAmendmentChangeTypeLabel(position.changeType, translate)}
                  </Badge>
                  <span className="order-amendment-position-row__description">
                    {position.description}
                  </span>
                </div>
                <DataRow
                  label={translate('orderAmendment.field.quantity')}
                  value={`${position.quantity} ${formatOrderUnitDisplay(position.unit, position.unitLabel)}`}
                />
                <DataRow
                  label={translate('orderAmendment.field.unitPrice')}
                  value={formatAmendmentMoney(position.unitPrice)}
                />
                <DataRow
                  label={translate('orderAmendment.lineTotal')}
                  value={formatAmendmentMoney(positionLineTotal(position.quantity, position.unitPrice))}
                />
                {position.parentPositionId ? (
                  <DataRow
                    label={translate('orderAmendment.parentPosition')}
                    value={renderParentValue(position.parentPositionId)}
                  />
                ) : null}
                {editingMeta ? (
                  <div className="order-amendment-actions order-amendment-actions--secondary">
                    <Button
                      variant="outline"
                      disabled={inputsDisabled}
                      onClick={() => startEdit(position)}
                      data-testid={`order-amendment-edit-${position.id}`}
                    >
                      {translate('orderAmendment.editPosition')}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={inputsDisabled}
                      onClick={() => handleRemovePosition(position.id)}
                      data-testid={`order-amendment-remove-${position.id}`}
                    >
                      {translate('orderAmendment.deletePosition')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))
          )}

          {editor.type !== 'closed' ? (
            <div className="order-amendment-position-editor" data-testid="order-amendment-position-editor">
              <CardTitle>
                {formatAmendmentChangeTypeLabel(draft.changeType, translate)}
              </CardTitle>
              {draft.changeType === 'quantity_increase' ? (
                <label className="form-group">
                  <span>{translate('orderAmendment.parentPosition')}</span>
                  <select
                    className="input"
                    data-testid="order-amendment-parent-select"
                    value={draft.parentPositionId ?? ''}
                    disabled={inputsDisabled}
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
                  disabled={inputsDisabled}
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
                  disabled={inputsDisabled}
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
                  disabled={inputsDisabled}
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
                  disabled={inputsDisabled}
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
                  disabled={inputsDisabled}
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
                  disabled={inputsDisabled}
                  onChange={(event) => setDraft({ ...draft, billable: event.target.checked })}
                />
                <span>{translate('orderAmendment.field.billable')}</span>
              </label>
              <div className="order-amendment-actions">
                <Button
                  disabled={inputsDisabled}
                  onClick={handleSavePosition}
                  data-testid="order-amendment-save-position"
                >
                  {translate('orderAmendment.savePosition')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={inputsDisabled}
                  onClick={() => setEditor({ type: 'closed' })}
                  data-testid="order-amendment-cancel-edit"
                >
                  {translate('orderAmendment.cancelEdit')}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="order-amendment-actions order-amendment-actions--primary">
            {canConfirm ? (
              <>
                <p className="invoice-hint" data-testid="order-amendment-confirm-hint">
                  {translate('orderAmendment.confirmHint')}
                </p>
                <Button
                  onClick={() => void runConfirm()}
                  data-testid="order-amendment-confirm"
                >
                  {translate('orderAmendment.confirm')}
                </Button>
              </>
            ) : null}
          </div>

          <div className="order-amendment-actions order-amendment-actions--secondary">
            {!editingMeta ? (
              <Button
                variant="outline"
                disabled={inputsDisabled}
                onClick={() => setEditingMeta(true)}
                data-testid="order-amendment-edit-draft"
              >
                {translate('orderAmendment.editDraft')}
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={inputsDisabled}
                onClick={() => {
                  setEditingMeta(false);
                  setEditor({ type: 'closed' });
                }}
                data-testid="order-amendment-done-edit-draft"
              >
                {translate('orderAmendment.doneEditDraft')}
              </Button>
            )}
            {editor.type === 'closed' ? (
              <>
                <Button
                  variant="outline"
                  disabled={inputsDisabled}
                  onClick={() => startAdd('add')}
                  data-testid="order-amendment-add-position"
                >
                  {translate('orderAmendment.addPosition')}
                </Button>
                <Button
                  variant="outline"
                  disabled={inputsDisabled}
                  onClick={() => startAdd('quantity_increase')}
                  data-testid="order-amendment-add-quantity-increase"
                >
                  {translate('orderAmendment.addQuantityIncrease')}
                </Button>
              </>
            ) : null}
          </div>

          <div className="order-amendment-actions order-amendment-actions--danger">
            <Button
              variant="danger"
              disabled={inputsDisabled}
              onClick={handleDeleteDraft}
              data-testid="order-amendment-delete-draft"
            >
              {translate('orderAmendment.deleteDraft')}
            </Button>
          </div>
        </Card>
      ) : null}

      {confirmedAmendments.length > 0 ? (
        <ConfirmedOrderAmendmentList
          amendments={confirmedAmendments}
          confirmedParents={confirmedParents}
          translate={translate}
        />
      ) : null}

      {hasAnyContent && !primaryAmendment ? (
        <div className="order-amendment-actions order-amendment-actions--secondary">
          <Button onClick={handlePrepare} data-testid="order-amendment-prepare">
            {translate('orderAmendment.prepare')}
          </Button>
        </div>
      ) : null}

      <SimpleConfirmDialog
        open={discardOpen}
        title={translate('orderAmendment.discardDialogTitle')}
        message={translate('orderAmendment.discardDialogBody')}
        confirmLabel={translate('orderAmendment.deleteDraft')}
        cancelLabel={translate('orderAmendment.cancelEdit')}
        confirmVariant="danger"
        failureMessage={translate('orderAmendment.discardFailed')}
        returnFocusRef={discardReturnFocusRef}
        fallbackFocusRef={sectionHeadingRef}
        dialogTestId="order-amendment-discard-dialog"
        confirmTestId="order-amendment-discard-confirm"
        cancelTestId="order-amendment-discard-cancel"
        onCancel={() => setDiscardOpen(false)}
        onConfirm={confirmDeleteDraft}
      />
    </section>
  );
}
