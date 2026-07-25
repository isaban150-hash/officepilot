import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Badge, Card, DataRow } from '../ui/Card';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
import type { TranslationKey } from '../../i18n';
import {
  createOrderAmendmentDraft,
  deleteOrderAmendmentDraft,
  removeOrderAmendmentDraftPosition,
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
import type { OrderAmendment, OrderAmendmentDraftPosition, Vorgang } from '../../types/models';
import { ConfirmedOrderAmendmentList } from './ConfirmedOrderAmendmentList';
import { OrderAmendmentHeaderForm } from './OrderAmendmentHeaderForm';
import {
  OrderAmendmentPositionEditor,
  orderAmendmentPositionEditorKey,
  type OrderAmendmentPositionEditorMode,
} from './OrderAmendmentPositionEditor';
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

interface VorgangOrderAmendmentPanelProps {
  vorgang: Vorgang;
  translate: (key: TranslationKey) => string;
  onUpdated: () => void;
  onToast: (message: string) => void;
  /** When false (hidden segment), close modal editors without persisting. */
  isSectionActive?: boolean;
}

type PositionEditorState =
  | { type: 'closed' }
  | { type: 'open'; mode: OrderAmendmentPositionEditorMode };

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
  isSectionActive = true,
}: VorgangOrderAmendmentPanelProps) {
  const amendments = vorgang.orderAmendments ?? [];
  const primaryAmendment: OrderAmendment | undefined = amendments[0];
  const extraDraftCount = Math.max(0, amendments.length - 1);
  const confirmedAmendments = sortConfirmedOrderAmendments(vorgang.confirmedOrderAmendments);
  const schlussExists = hasFinalSchlussrechnung(vorgang);
  const confirmedParents = vorgang.contractConfirmation?.positions ?? [];

  const [positionEditor, setPositionEditor] = useState<PositionEditorState>({ type: 'closed' });
  const [positionEditorBusy, setPositionEditorBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [removePositionId, setRemovePositionId] = useState<string | null>(null);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const discardReturnFocusRef = useRef<HTMLElement | null>(null);
  const removeReturnFocusRef = useRef<HTMLElement | null>(null);
  const addPositionReturnFocusRef = useRef<HTMLElement | null>(null);
  const editPositionReturnFocusRef = useRef<HTMLElement | null>(null);

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
      setPositionEditor({ type: 'closed' });
      setPositionEditorBusy(false);
      setRemovePositionId(null);
    }
  }, [primaryAmendment?.id]);

  useEffect(() => {
    if (isSectionActive) return;
    // Keep the editor mounted while a save is in flight; close only when idle.
    if (positionEditorBusy) return;
    setPositionEditor({ type: 'closed' });
    setRemovePositionId(null);
    setDiscardOpen(false);
  }, [isSectionActive, positionEditorBusy]);

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

  const handlePrepare = () => {
    const result = createOrderAmendmentDraft(vorgang.id);
    if (!result.success) {
      toastError(translate, onToast, result.errorKey);
      return;
    }
    onUpdated();
    onToast(translate('orderAmendment.created'));
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
      setPositionEditor({ type: 'closed' });
      setDiscardOpen(false);
      onUpdated();
      onToast(translate('orderAmendment.deleted'));
      return true;
    } catch {
      return false;
    }
  };

  const startAdd = (changeType: 'add' | 'quantity_increase') => {
    if (!primaryAmendment || inputsDisabled || positionEditorBusy) return;
    addPositionReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPositionEditor({
      type: 'open',
      mode: { type: 'add', changeType },
    });
  };

  const startEdit = (position: OrderAmendmentDraftPosition) => {
    if (inputsDisabled || positionEditorBusy) return;
    editPositionReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPositionEditor({
      type: 'open',
      mode: { type: 'edit', position },
    });
  };

  const requestRemovePosition = (positionId: string) => {
    if (!primaryAmendment || inputsDisabled || positionEditorBusy) return;
    removeReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRemovePositionId(positionId);
  };

  const confirmRemovePosition = async (): Promise<boolean> => {
    if (!primaryAmendment || inputsDisabled || !removePositionId) return false;
    try {
      const result = await Promise.resolve(
        removeOrderAmendmentDraftPosition(
          vorgang.id,
          primaryAmendment.id,
          removePositionId,
        ),
      );
      if (!result.success) {
        return false;
      }
      if (
        positionEditor.type === 'open' &&
        positionEditor.mode.type === 'edit' &&
        positionEditor.mode.position.id === removePositionId
      ) {
        setPositionEditor({ type: 'closed' });
      }
      setRemovePositionId(null);
      onUpdated();
      onToast(translate('orderAmendment.positionRemoved'));
      return true;
    } catch {
      return false;
    }
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
  const positionReturnFocusRef =
    positionEditor.type === 'open' && positionEditor.mode.type === 'edit'
      ? editPositionReturnFocusRef
      : addPositionReturnFocusRef;

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

          <OrderAmendmentHeaderForm
            vorgangId={vorgang.id}
            amendmentId={primaryAmendment.id}
            title={primaryAmendment.title}
            reason={primaryAmendment.reason}
            disabled={inputsDisabled}
            translate={translate}
            onUpdated={onUpdated}
            onToast={onToast}
          />

          <div className="order-amendment-draft__facts">
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
                {position.parentPositionId ? (
                  <DataRow
                    label={translate('orderAmendment.parentPosition')}
                    value={renderParentValue(position.parentPositionId)}
                  />
                ) : null}
                <DataRow
                  label={
                    position.changeType === 'quantity_increase'
                      ? translate('orderAmendment.additionalQuantity')
                      : translate('orderAmendment.field.quantity')
                  }
                  value={`${position.quantity} ${formatOrderUnitDisplay(position.unit, position.unitLabel)}`}
                />
                <DataRow
                  label={translate('orderAmendment.field.unitPrice')}
                  value={formatAmendmentMoney(position.unitPrice)}
                />
                <DataRow
                  label={translate('orderAmendment.lineTotal')}
                  value={formatAmendmentMoney(
                    positionLineTotal(position.quantity, position.unitPrice),
                  )}
                />
                <div className="order-amendment-actions order-amendment-actions--secondary">
                  <Button
                    variant="outline"
                    disabled={inputsDisabled || positionEditorBusy}
                    onClick={() => startEdit(position)}
                    data-testid={`order-amendment-edit-${position.id}`}
                  >
                    {translate('orderAmendment.editPosition')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={inputsDisabled || positionEditorBusy}
                    onClick={() => requestRemovePosition(position.id)}
                    data-testid={`order-amendment-remove-${position.id}`}
                  >
                    {translate('orderAmendment.deletePosition')}
                  </Button>
                </div>
              </div>
            ))
          )}

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
            <Button
              variant="outline"
              disabled={inputsDisabled || positionEditor.type === 'open' || positionEditorBusy}
              onClick={() => startAdd('add')}
              data-testid="order-amendment-add-position"
            >
              {translate('orderAmendment.addPosition')}
            </Button>
            <Button
              variant="outline"
              disabled={inputsDisabled || positionEditor.type === 'open' || positionEditorBusy}
              onClick={() => startAdd('quantity_increase')}
              data-testid="order-amendment-add-quantity-increase"
            >
              {translate('orderAmendment.addQuantityIncrease')}
            </Button>
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

      {positionEditor.type === 'open' && primaryAmendment ? (
        <OrderAmendmentPositionEditor
          key={orderAmendmentPositionEditorKey(positionEditor.mode)}
          mode={positionEditor.mode}
          vorgang={vorgang}
          amendmentId={primaryAmendment.id}
          translate={translate}
          onSaved={onUpdated}
          onClose={() => {
            setPositionEditor({ type: 'closed' });
            setPositionEditorBusy(false);
          }}
          onToast={onToast}
          returnFocusRef={positionReturnFocusRef}
          fallbackFocusRef={sectionHeadingRef}
          onBusyChange={setPositionEditorBusy}
        />
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

      <SimpleConfirmDialog
        open={removePositionId !== null}
        title={translate('orderAmendment.deletePositionTitle')}
        message={translate('orderAmendment.deletePositionBody')}
        confirmLabel={translate('orderAmendment.deletePosition')}
        cancelLabel={translate('orderAmendment.cancelEdit')}
        confirmVariant="danger"
        failureMessage={translate('orderAmendment.deletePositionFailed')}
        returnFocusRef={removeReturnFocusRef}
        fallbackFocusRef={sectionHeadingRef}
        dialogTestId="order-amendment-remove-position-dialog"
        confirmTestId="order-amendment-remove-position-confirm"
        cancelTestId="order-amendment-remove-position-cancel"
        onCancel={() => setRemovePositionId(null)}
        onConfirm={confirmRemovePosition}
      />
    </section>
  );
}
