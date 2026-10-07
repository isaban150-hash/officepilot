import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Badge, Card, DataRow } from '../ui/Card';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
import type { TranslationKey } from '../../i18n';
import {
  acceptOrderAmendmentDraftCloudEnd,
  continueOrderAmendmentDraftAsNew,
  createOrderAmendmentDraft,
  deleteOrderAmendmentDraft,
  discardOrderAmendmentDraftAgain,
  isOrderAmendmentDraftCloudSyncAllowed,
  keepLocalOrderAmendmentDraftVersion,
  keepOrderAmendmentDraftAfterRejectedDiscard,
  removeOrderAmendmentDraftPosition,
  takeCloudOrderAmendmentDraftVersion,
  type OrderAmendmentDraftCloudDecisionResult,
  type OrderAmendmentErrorKey,
} from '../../services/orderAmendmentService';
import { getVorgangById } from '../../services/vorgangService';
import { useDraftCloudTick } from '../../services/order/useDraftCloudTick';
import { formatDisplayDateTime } from '../../utils/displayFormat';
import { DraftCloudConflictNotice, type DraftCloudConflictAction } from '../order/DraftCloudConflictNotice';
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
import { OrderAmendmentConfirmDialog } from './OrderAmendmentConfirmDialog';
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
  /*
   * CLOUD-SYNC S6 — mehrere echte Entwürfe sind möglich (zwei Geräte, zwei
   * Entwürfe); jeder bleibt erreichbar und auswählbar. Gelesen wird nach jedem
   * Speichern und jedem Sync-Lauf frisch aus dem Bestand, damit ein Abzug
   * sofort sichtbar wird — Entwürfe, bestätigte Nachträge und Schlussrechnung
   * aus demselben Stand: Wird ein Entwurf anderswo bestätigt, verschwindet er
   * nicht, ohne dass sein Nachtrag erscheint.
   */
  useDraftCloudTick();
  const currentVorgang = getVorgangById(vorgang.id) ?? vorgang;
  const amendments = currentVorgang.orderAmendments ?? [];
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const primaryAmendment: OrderAmendment | undefined =
    amendments.find((item) => item.id === selectedDraftId) ?? amendments[0];
  const draftCloudConflict = primaryAmendment?.conflict ?? null;
  const [decisionBusy, setDecisionBusy] = useState(false);
  const confirmedAmendments = sortConfirmedOrderAmendments(currentVorgang.confirmedOrderAmendments);
  const schlussExists = hasFinalSchlussrechnung(currentVorgang);
  const confirmedParents = currentVorgang.contractConfirmation?.positions ?? [];

  const [positionEditor, setPositionEditor] = useState<PositionEditorState>({ type: 'closed' });
  const [positionEditorBusy, setPositionEditorBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [removePositionId, setRemovePositionId] = useState<string | null>(null);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const confirmReturnFocusRef = useRef<HTMLElement | null>(null);
  const confirmingRef = useRef(false);
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
  const inputsDisabled = confirming || draftLocked || Boolean(draftCloudConflict);
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
    !draftCloudConflict &&
    !schlussExists &&
    !confirming &&
    !draftLocked &&
    (primaryAmendment?.positions.some(isValidLookingPosition) ?? false);
  const positionEditorOpen = positionEditor.type === 'open';
  const confirmTriggerDisabled =
    positionEditorOpen || positionEditorBusy || confirmDialogOpen;

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
    if (!confirmingRef.current) {
      setConfirmDialogOpen(false);
    }
  }, [isSectionActive, positionEditorBusy]);

  if (!currentVorgang.contractConfirmation) {
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
    // CLOUD-SYNC S6 — der neue Entwurf ist der bearbeitete; die übrigen bleiben in der Liste erreichbar.
    setSelectedDraftId(result.amendment.id);
    onUpdated();
    onToast(translate('orderAmendment.created'));
  };

  /** CLOUD-SYNC S6 — Entscheidung über einen Konflikt des ausgewählten Entwurfs. */
  const entscheide = async (action: DraftCloudConflictAction): Promise<boolean> => {
    if (!primaryAmendment) return false;
    setDecisionBusy(true);
    try {
      let result: OrderAmendmentDraftCloudDecisionResult;
      switch (action) {
        case 'takeCloud':
          result = takeCloudOrderAmendmentDraftVersion(vorgang.id, primaryAmendment.id);
          break;
        case 'keepMine':
          result = keepLocalOrderAmendmentDraftVersion(vorgang.id, primaryAmendment.id);
          break;
        case 'acceptEnd':
          result = acceptOrderAmendmentDraftCloudEnd(vorgang.id, primaryAmendment.id);
          break;
        case 'continueAsNew':
          result = continueOrderAmendmentDraftAsNew(vorgang.id, primaryAmendment.id);
          break;
        case 'keepDraft':
          result = keepOrderAmendmentDraftAfterRejectedDiscard(vorgang.id, primaryAmendment.id);
          break;
        default:
          result = discardOrderAmendmentDraftAgain(vorgang.id, primaryAmendment.id);
      }
      if (!result.ok) return false;
      setSelectedDraftId(
        result.draftId ?? (action === 'acceptEnd' || action === 'discardAgain' ? null : primaryAmendment.id),
      );
      onUpdated();
      return true;
    } finally {
      setDecisionBusy(false);
    }
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
      setSelectedDraftId(null);
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

  const openConfirmDialog = () => {
    if (!primaryAmendment || !canConfirm || confirmTriggerDisabled) return;
    if (confirmingRef.current || confirming) return;
    confirmReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmDialogOpen(true);
  };

  const runConfirm = async (options?: { skipDialog?: boolean }) => {
    if (!primaryAmendment) return;
    if (schlussExists) return;

    if (!options?.skipDialog) {
      openConfirmDialog();
      return;
    }

    // Sync guard before first await — blocks double-click / Enter re-entry.
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirmDialogOpen(false);
    setConfirming(true);
    try {
      const result = await confirmOrderAmendmentWithCloud(vorgang.id, primaryAmendment.id);
      if (result.ok) {
        onToast(translate('orderAmendment.confirmedSuccess'));
        onUpdated();
        return;
      }
      // Retained intent: durable status banner + retry own the UX — no toast.
      if (!result.intentRetained) {
        onToast(translate(result.errorKey as TranslationKey));
      }
      onUpdated();
    } finally {
      confirmingRef.current = false;
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

      {amendments.length > 1 ? (
        <div className="order-amendment-section__extra-drafts" data-testid="order-amendment-extra-drafts">
          <h3 className="section__subtitle">{translate('orderAmendmentCloud.drafts.title')}</h3>
          <ul className="order-amendment-draft-list">
            {amendments.map((draft) => {
              const aktiv = draft.id === primaryAmendment?.id;
              return (
                <li
                  key={draft.id}
                  className="order-amendment-draft-list__item"
                  data-testid={`order-amendment-draft-option-${draft.id}`}
                >
                  <span className="order-amendment-draft-list__title">
                    {draft.title?.trim() || translate('orderAmendment.draftBadge')}
                  </span>
                  <span className="order-amendment-section__muted">
                    {translate('orderAmendmentCloud.drafts.updated').replace('{date}', formatDisplayDateTime(draft.updatedAt))}
                  </span>
                  {draft.conflict ? <Badge tone="warning">{translate('orderDraftCloud.badge.conflict')}</Badge> : null}
                  {aktiv ? (
                    <Badge tone="info">{translate('orderAmendmentCloud.drafts.active')}</Badge>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={confirming || positionEditorBusy || positionEditor.type === 'open'}
                      onClick={() => setSelectedDraftId(draft.id)}
                      data-testid={`order-amendment-draft-select-${draft.id}`}
                    >
                      {translate('orderAmendmentCloud.drafts.select')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
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
          {draftCloudConflict ? (
            <DraftCloudConflictNotice
              kind={draftCloudConflict.kind}
              textPrefix="orderAmendmentCloud"
              translate={translate}
              busy={decisionBusy}
              onDecide={entscheide}
              testIdPrefix="order-amendment-cloud"
            />
          ) : null}
          {/* CLOUD-SYNC S6 — „nur auf diesem Gerät" nur, wenn der Entwurfs-Sync abgeschaltet ist (Notausschalter). */}
          {isOrderAmendmentDraftCloudSyncAllowed() ? null : (
            <p className="order-amendment-section__muted" data-testid="order-amendment-local-hint">
              {translate('orderAmendment.localOnlyHint')}
            </p>
          )}

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

          {/* CLOUD-SYNC S6 — je Entwurf ein eigenes Formular: ein Wechsel nimmt keine offenen Eingaben mit. */}
          <OrderAmendmentHeaderForm
            key={primaryAmendment.id}
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
                  disabled={confirmTriggerDisabled}
                  onClick={openConfirmDialog}
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

      {primaryAmendment ? (
        <div className="order-amendment-actions order-amendment-actions--secondary">
          <Button
            variant="outline"
            disabled={confirming || positionEditorBusy || positionEditor.type === 'open'}
            onClick={handlePrepare}
            data-testid="order-amendment-prepare-another"
          >
            {translate('orderAmendmentCloud.drafts.newAnother')}
          </Button>
        </div>
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

      <OrderAmendmentConfirmDialog
        open={confirmDialogOpen && Boolean(primaryAmendment)}
        title={translate('orderAmendment.confirmDialogTitle')}
        titleLabel={translate('orderAmendment.confirmSummaryTitle')}
        amendmentTitle={primaryAmendment?.title?.trim() || translate('orderAmendment.draftBadge')}
        positionsLabel={translate('orderAmendment.confirmSummaryPositions')}
        positionsValue={translate('orderAmendment.positionCount').replace(
          '{count}',
          String(primaryAmendment?.positions.length ?? 0),
        )}
        totalLabel={translate('orderAmendment.confirmSummaryTotal')}
        formattedTotal={formatAmendmentMoney(draftTotals?.grandTotal ?? 0)}
        impactText={translate('orderAmendment.confirmImpact')}
        noInvoiceText={translate('orderAmendment.confirmNoInvoice')}
        confirmLabel={translate('orderAmendment.confirm')}
        cancelLabel={translate('orderAmendment.cancelEdit')}
        confirming={confirming}
        returnFocusRef={confirmReturnFocusRef}
        fallbackFocusRef={sectionHeadingRef}
        onCancel={() => setConfirmDialogOpen(false)}
        onConfirm={() => void runConfirm({ skipDialog: true })}
      />

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
