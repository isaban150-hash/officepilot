import { useMemo, useState } from 'react';
import { Button } from '../../ui/Button';
import { Card, CardMeta, CardTitle } from '../../ui/Card';
import type { ContractOrderProposal, EnhancedDetectedOrderPosition } from '../../../types/documentIntelligence';
import type { InboxItem } from '../../../types/models';
import type { TranslationKey } from '../../../i18n';
import {
  buildContractPositionKey,
  buildDefaultContractPositionSelections,
  hasPositionMathConflict,
  isImportableLvPosition,
  type ContractPositionSelectionMap,
  type ContractPositionSelectionState,
} from '../../../services/contractPositionImportService';
import { isContractPlanLocked } from '../../../services/orderPlanIntegrityService';
import { getVorgangById } from '../../../services/vorgangService';
import { ContractWorkspaceSummary } from './ContractWorkspaceSummary';

/** Keep first paint light — remaining rows load on demand. */
export const CONTRACT_PROPOSAL_INITIAL_VISIBLE_ROWS = 30;

interface ContractOrderProposalPanelProps {
  proposal: ContractOrderProposal;
  translate: (key: TranslationKey) => string;
  item?: InboxItem;
  onConfirmImport: (selectedPositions: EnhancedDetectedOrderPosition[]) => void;
  onDiscard?: () => void;
  isCreating?: boolean;
}

function formatMoney(value: number | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return '–';
  }
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`;
}

function selectionLabelKey(state: ContractPositionSelectionState): TranslationKey {
  switch (state) {
    case 'selected':
      return 'documentIntelligence.selection.selected';
    case 'needs_review':
      return 'documentIntelligence.selection.needsReview';
    case 'rejected':
      return 'documentIntelligence.selection.rejected';
    default:
      return 'documentIntelligence.selection.deselected';
  }
}

export function ContractOrderProposalPanel({
  proposal,
  translate,
  item,
  onConfirmImport,
  onDiscard,
  isCreating = false,
}: ContractOrderProposalPanelProps) {
  const labelKey = proposal.intelligence.documentLabelKey as TranslationKey;
  const positions = proposal.positions;
  const linkedVorgangId = item?.vorgangId ?? null;
  const vorgang = linkedVorgangId ? getVorgangById(linkedVorgangId) ?? null : null;
  const planLocked = Boolean(vorgang && isContractPlanLocked(vorgang));

  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(CONTRACT_PROPOSAL_INITIAL_VISIBLE_ROWS, positions.length),
  );
  const [drafts, setDrafts] = useState<Record<string, EnhancedDetectedOrderPosition>>({});
  const [selections, setSelections] = useState<ContractPositionSelectionMap>(() =>
    buildDefaultContractPositionSelections(positions),
  );

  const resolvePosition = (original: EnhancedDetectedOrderPosition): EnhancedDetectedOrderPosition => {
    const key = buildContractPositionKey(original);
    return drafts[key] ?? original;
  };

  const selectedCount = useMemo(
    () =>
      positions.filter((original) => {
        const key = buildContractPositionKey(original);
        const position = drafts[key] ?? original;
        return selections[key] === 'selected' && isImportableLvPosition(position);
      }).length,
    [positions, drafts, selections],
  );

  const setSelection = (key: string, state: ContractPositionSelectionState) => {
    setSelections((current) => ({ ...current, [key]: state }));
  };

  const updateDraft = (
    original: EnhancedDetectedOrderPosition,
    patch: Partial<Pick<EnhancedDetectedOrderPosition, 'description' | 'quantity' | 'unit' | 'unitPrice'>>,
  ) => {
    const key = buildContractPositionKey(original);
    setDrafts((current) => {
      const base = current[key] ?? { ...original };
      const next = { ...base, ...patch };
      if (patch.quantity != null || patch.unitPrice != null) {
        const quantity = patch.quantity ?? next.quantity;
        const unitPrice = patch.unitPrice ?? next.unitPrice;
        if (quantity > 0 && unitPrice > 0) {
          next.lineTotal = Math.round(quantity * unitPrice * 100) / 100;
        }
      }
      return { ...current, [key]: next };
    });
  };

  const handleConfirm = () => {
    if (planLocked) return;
    const selected = positions
      .filter((original) => selections[buildContractPositionKey(original)] === 'selected')
      .map((original) => resolvePosition(original))
      .filter((position) => isImportableLvPosition(position));
    onConfirmImport(selected);
  };

  const handleSelectAllSafe = () => {
    setSelections((current) => {
      const next = { ...current };
      for (const original of positions) {
        const key = buildContractPositionKey(original);
        const position = drafts[key] ?? original;
        if (!isImportableLvPosition(position)) {
          next[key] = 'rejected';
          continue;
        }
        if (position.reviewStatus === 'review_required' || hasPositionMathConflict(position)) {
          if (next[key] !== 'selected' && next[key] !== 'rejected') {
            next[key] = 'needs_review';
          }
          continue;
        }
        if (next[key] !== 'rejected') {
          next[key] = 'selected';
        }
      }
      return next;
    });
  };

  const visiblePositions = positions.slice(0, visibleCount);
  const hasMore = visibleCount < positions.length;

  return (
    <Card className="contract-order-proposal" data-testid="contract-order-proposal">
      <CardTitle>{translate(labelKey)}</CardTitle>
      <CardMeta data-testid="contract-order-proposal-meta">
        {translate('documentIntelligence.section.contractCore')}:{' '}
        {proposal.intelligence.segmentation.contractCorePages.join(', ') || '–'}
        {' · '}
        {translate('documentIntelligence.section.billOfQuantities')}:{' '}
        {proposal.intelligence.segmentation.billOfQuantitiesPages.join(', ') || '–'}
        {' · '}
        {translate('documentIntelligence.section.technicalAttachments')}:{' '}
        {proposal.intelligence.technicalAttachmentCount}
      </CardMeta>

      <div className="contract-order-proposal__intro" data-testid="contract-order-proposal-intro">
        <h4>{translate('documentIntelligence.proposal.detectedTitle')}</h4>
        <p>{translate('documentIntelligence.proposal.instruction')}</p>
      </div>

      {proposal.progressBillingHint && (
        <p className="contract-order-proposal__hint" data-testid="contract-progress-billing-hint">
          {translate(proposal.progressBillingHint as TranslationKey)}
        </p>
      )}

      {proposal.technicalAttachmentsLabel && (
        <p className="contract-order-proposal__hint" data-testid="contract-technical-attachments-hint">
          {translate(proposal.technicalAttachmentsLabel as TranslationKey)}
        </p>
      )}

      <ContractWorkspaceSummary
        proposal={proposal}
        translate={translate}
        item={item}
        vorgang={vorgang}
      />

      <div className="contract-order-proposal__positions" data-testid="contract-order-positions">
        <h4>{translate('documentIntelligence.positionsTitle')}</h4>
        <table className="contract-order-proposal__table">
          <thead>
            <tr>
              <th>{translate('documentIntelligence.table.select')}</th>
              <th>{translate('documentIntelligence.table.pos')}</th>
              <th>{translate('documentIntelligence.table.quantity')}</th>
              <th>{translate('documentIntelligence.table.unit')}</th>
              <th>{translate('documentIntelligence.table.description')}</th>
              <th>{translate('documentIntelligence.table.unitPrice')}</th>
              <th>{translate('documentIntelligence.table.total')}</th>
              <th>{translate('documentIntelligence.table.status')}</th>
            </tr>
          </thead>
          <tbody>
            {visiblePositions.map((original) => {
              const key = buildContractPositionKey(original);
              const position = drafts[key] ?? original;
              const state = selections[key] ?? 'deselected';
              const checked = state === 'selected';
              const mathConflict = hasPositionMathConflict(position);
              const importable = isImportableLvPosition(position);
              const disabled = state === 'rejected' || !importable;

              return (
                <tr
                  key={key}
                  data-testid={`contract-position-row-${position.positionNumber ?? 'x'}`}
                  data-selection={state}
                  className={
                    state === 'rejected'
                      ? 'contract-order-proposal__row--rejected'
                      : state === 'needs_review'
                        ? 'contract-order-proposal__row--review'
                        : undefined
                  }
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      aria-label={translate('documentIntelligence.table.select')}
                      data-testid={`contract-position-select-${position.positionNumber ?? 'x'}`}
                      onChange={(event) => {
                        if (event.target.checked) {
                          setSelection(key, 'selected');
                        } else if (position.reviewStatus === 'review_required' || mathConflict) {
                          setSelection(key, 'needs_review');
                        } else {
                          setSelection(key, 'deselected');
                        }
                      }}
                    />
                  </td>
                  <td>{position.positionNumber || '–'}</td>
                  <td>
                    <input
                      className="contract-order-proposal__edit"
                      type="number"
                      min={0}
                      step="any"
                      value={position.quantity || ''}
                      disabled={state === 'rejected'}
                      aria-label={translate('documentIntelligence.table.quantity')}
                      onChange={(event) => {
                        const quantity = Number(event.target.value);
                        updateDraft(original, {
                          quantity: Number.isFinite(quantity) ? quantity : 0,
                        });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="contract-order-proposal__edit contract-order-proposal__edit--unit"
                      type="text"
                      value={position.unit || ''}
                      disabled={state === 'rejected'}
                      aria-label={translate('documentIntelligence.table.unit')}
                      onChange={(event) => updateDraft(original, { unit: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="contract-order-proposal__edit contract-order-proposal__edit--desc"
                      type="text"
                      value={position.description}
                      disabled={state === 'rejected'}
                      aria-label={translate('documentIntelligence.table.description')}
                      onChange={(event) => updateDraft(original, { description: event.target.value })}
                    />
                    {position.sourcePage != null && (
                      <span className="contract-order-proposal__meta">
                        {translate('documentIntelligence.table.sourcePage').replace(
                          '{page}',
                          String(position.sourcePage),
                        )}
                      </span>
                    )}
                  </td>
                  <td>
                    <input
                      className="contract-order-proposal__edit"
                      type="number"
                      min={0}
                      step="any"
                      value={position.unitPrice || ''}
                      disabled={state === 'rejected'}
                      aria-label={translate('documentIntelligence.table.unitPrice')}
                      onChange={(event) => {
                        const unitPrice = Number(event.target.value);
                        updateDraft(original, {
                          unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
                        });
                      }}
                    />
                  </td>
                  <td>{formatMoney(position.lineTotal)}</td>
                  <td>
                    <span className={`contract-order-proposal__badge contract-order-proposal__badge--${state}`}>
                      {translate(selectionLabelKey(state))}
                    </span>
                    {position.reviewStatus === 'review_required' && (
                      <span className="contract-order-proposal__meta">
                        {translate('documentIntelligence.status.reviewRequired')}
                      </span>
                    )}
                    {mathConflict && (
                      <span
                        className="contract-order-proposal__meta contract-order-proposal__meta--warn"
                        data-testid={`contract-position-math-conflict-${position.positionNumber ?? 'x'}`}
                      >
                        {translate('documentIntelligence.status.mathConflict')}
                      </span>
                    )}
                    {position.confidence && (
                      <span className="contract-order-proposal__meta">
                        {translate('documentIntelligence.table.confidence').replace(
                          '{level}',
                          position.confidence,
                        )}
                      </span>
                    )}
                    {state !== 'rejected' && (
                      <button
                        type="button"
                        className="contract-order-proposal__reject"
                        data-testid={`contract-position-reject-${position.positionNumber ?? 'x'}`}
                        onClick={() => setSelection(key, 'rejected')}
                      >
                        {translate('documentIntelligence.action.rejectPosition')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {hasMore ? (
          <Button
            variant="outline"
            fullWidth
            data-testid="contract-proposal-show-more"
            onClick={() => setVisibleCount(positions.length)}
          >
            {translate('common.showMore')} ({positions.length - visibleCount})
          </Button>
        ) : null}
      </div>

      <div className="contract-order-proposal__actions">
        {planLocked ? (
          <p
            className="invoice-hint invoice-hint--warning"
            data-testid="contract-import-plan-locked"
          >
            {translate('orderPlan.confirmedHint')}
          </p>
        ) : null}
        <Button
          fullWidth
          loading={isCreating}
          disabled={planLocked || selectedCount === 0}
          onClick={handleConfirm}
          data-testid="contract-create-order-button"
        >
          {translate('documentIntelligence.action.confirmSelectedPositions').replace(
            '{count}',
            String(selectedCount),
          )}
        </Button>
        <Button
          variant="outline"
          fullWidth
          disabled={isCreating}
          onClick={handleSelectAllSafe}
          data-testid="contract-select-safe-button"
        >
          {translate('documentIntelligence.action.selectAllSafe')}
        </Button>
        {onDiscard && (
          <Button
            variant="ghost"
            fullWidth
            disabled={isCreating}
            onClick={onDiscard}
            data-testid="contract-discard-button"
          >
            {translate('documentIntelligence.action.discardProposal')}
          </Button>
        )}
      </div>
    </Card>
  );
}
