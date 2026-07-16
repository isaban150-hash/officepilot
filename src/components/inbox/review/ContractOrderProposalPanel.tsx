import { useMemo, useState } from 'react';
import { Button } from '../../ui/Button';
import { Card, CardMeta, CardTitle, DataRow } from '../../ui/Card';
import type { ContractOrderProposal, EnhancedDetectedOrderPosition } from '../../../types/documentIntelligence';
import type { TranslationKey } from '../../../i18n';
import {
  buildDefaultContractPositionSelections,
  hasPositionMathConflict,
  isImportableLvPosition,
  type ContractPositionSelectionMap,
  type ContractPositionSelectionState,
} from '../../../services/contractPositionImportService';

interface ContractOrderProposalPanelProps {
  proposal: ContractOrderProposal;
  translate: (key: TranslationKey) => string;
  onConfirmImport: (selectedPositions: EnhancedDetectedOrderPosition[]) => void;
  onDiscard?: () => void;
  isCreating?: boolean;
}

interface ProposalRow {
  id: string;
  position: EnhancedDetectedOrderPosition;
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

function buildInitialRows(positions: EnhancedDetectedOrderPosition[]): ProposalRow[] {
  return positions.map((position, index) => ({
    id: `row-${index}-${position.positionNumber ?? 'x'}`,
    position: { ...position },
  }));
}

function buildInitialSelections(rows: ProposalRow[]): ContractPositionSelectionMap {
  const byOriginalKey = buildDefaultContractPositionSelections(rows.map((row) => row.position));
  const selections: ContractPositionSelectionMap = {};
  for (const row of rows) {
    const originalKey = `${row.position.positionNumber ?? ''}::${row.position.description.trim().toLowerCase()}`;
    selections[row.id] = byOriginalKey[originalKey] ?? 'deselected';
  }
  return selections;
}

export function ContractOrderProposalPanel({
  proposal,
  translate,
  onConfirmImport,
  onDiscard,
  isCreating = false,
}: ContractOrderProposalPanelProps) {
  const labelKey = proposal.intelligence.documentLabelKey as TranslationKey;
  const [rows, setRows] = useState<ProposalRow[]>(() => buildInitialRows(proposal.positions));
  const [selections, setSelections] = useState<ContractPositionSelectionMap>(() =>
    buildInitialSelections(buildInitialRows(proposal.positions)),
  );

  const selectedCount = useMemo(
    () =>
      rows.filter(
        (row) => selections[row.id] === 'selected' && isImportableLvPosition(row.position),
      ).length,
    [rows, selections],
  );

  const setSelection = (id: string, state: ContractPositionSelectionState) => {
    setSelections((current) => ({ ...current, [id]: state }));
  };

  const updateDraft = (
    id: string,
    patch: Partial<Pick<EnhancedDetectedOrderPosition, 'description' | 'quantity' | 'unit' | 'unitPrice'>>,
  ) => {
    setRows((current) =>
      current.map((row) => {
        if (row.id !== id) return row;
        const next = { ...row.position, ...patch };
        if (patch.quantity != null || patch.unitPrice != null) {
          const quantity = patch.quantity ?? next.quantity;
          const unitPrice = patch.unitPrice ?? next.unitPrice;
          if (quantity > 0 && unitPrice > 0) {
            next.lineTotal = Math.round(quantity * unitPrice * 100) / 100;
          }
        }
        return { ...row, position: next };
      }),
    );
  };

  const handleConfirm = () => {
    const selected = rows
      .filter((row) => selections[row.id] === 'selected')
      .map((row) => row.position)
      .filter((position) => isImportableLvPosition(position));
    onConfirmImport(selected);
  };

  const handleSelectAllSafe = () => {
    setSelections((current) => {
      const next = { ...current };
      for (const row of rows) {
        if (!isImportableLvPosition(row.position)) {
          next[row.id] = 'rejected';
          continue;
        }
        if (row.position.reviewStatus === 'review_required' || hasPositionMathConflict(row.position)) {
          if (next[row.id] !== 'selected' && next[row.id] !== 'rejected') {
            next[row.id] = 'needs_review';
          }
          continue;
        }
        if (next[row.id] !== 'rejected') {
          next[row.id] = 'selected';
        }
      }
      return next;
    });
  };

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
        <p>{translate('documentIntelligence.proposal.reviewHint')}</p>
        <p>{translate('documentIntelligence.proposal.onlySelectedHint')}</p>
        <p>{translate('documentIntelligence.proposal.unsureNotSelectedHint')}</p>
      </div>

      <div className="contract-order-proposal__summary">
        <DataRow label={translate('documentIntelligence.field.customer')} value={proposal.customer} />
        <DataRow label={translate('documentIntelligence.field.contractor')} value={proposal.contractor} />
        <DataRow label={translate('documentIntelligence.field.constructionSite')} value={proposal.constructionSite} />
        <DataRow label={translate('documentIntelligence.field.contractDate')} value={proposal.contractDate} />
        <DataRow
          label={translate('documentIntelligence.field.positions')}
          value={String(proposal.positionCount)}
        />
        <DataRow
          label={translate('documentIntelligence.field.contractTotal')}
          value={proposal.contractTotalNet}
        />
        <DataRow
          label={translate('documentIntelligence.field.paymentTerms')}
          value={proposal.paymentTermsSummary}
        />
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

      {proposal.reviewHints.length > 0 && (
        <ul className="contract-order-proposal__reviews" data-testid="contract-review-hints">
          {proposal.reviewHints.map((hint) => (
            <li key={hint}>{translate(hint as TranslationKey)}</li>
          ))}
        </ul>
      )}

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
            {rows.map((row) => {
              const { position } = row;
              const state = selections[row.id] ?? 'deselected';
              const checked = state === 'selected';
              const mathConflict = hasPositionMathConflict(position);
              const importable = isImportableLvPosition(position);
              const disabled = state === 'rejected' || !importable;

              return (
                <tr
                  key={row.id}
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
                          setSelection(row.id, 'selected');
                        } else if (position.reviewStatus === 'review_required' || mathConflict) {
                          setSelection(row.id, 'needs_review');
                        } else {
                          setSelection(row.id, 'deselected');
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
                        updateDraft(row.id, {
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
                      onChange={(event) => updateDraft(row.id, { unit: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="contract-order-proposal__edit contract-order-proposal__edit--desc"
                      type="text"
                      value={position.description}
                      disabled={state === 'rejected'}
                      aria-label={translate('documentIntelligence.table.description')}
                      onChange={(event) => updateDraft(row.id, { description: event.target.value })}
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
                        updateDraft(row.id, {
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
                        onClick={() => setSelection(row.id, 'rejected')}
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
      </div>

      <div className="contract-order-proposal__actions">
        <Button
          fullWidth
          loading={isCreating}
          disabled={selectedCount === 0}
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
