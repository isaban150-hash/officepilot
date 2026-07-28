import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui/Button';
import { Card, DataRow } from '../../ui/Card';
import { ShowMoreSection } from '../../ui/ShowMoreSection';
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
import { buildContractWorkspaceSummaryView } from '../../../services/contractWorkspaceSummaryView';
import { getInboxExtractedDocumentText } from '../../../services/inboxDocumentText';
import { isContractPlanLocked } from '../../../services/orderPlanIntegrityService';
import { getVorgangById } from '../../../services/vorgangService';
import { ContractWorkspaceSummary } from './ContractWorkspaceSummary';

/** Keep first paint light — remaining rows load on demand inside the editor. */
export const CONTRACT_PROPOSAL_INITIAL_VISIBLE_ROWS = 30;

interface ContractOrderProposalPanelProps {
  proposal: ContractOrderProposal;
  translate: (key: TranslationKey) => string;
  item?: InboxItem;
  onConfirmImport: (selectedPositions: EnhancedDetectedOrderPosition[]) => void;
  onDiscard?: () => void;
  /** Used as chef primary when the proposal has no LV positions. */
  onApplySuggestion?: () => void;
  isCreating?: boolean;
  isApplying?: boolean;
  /**
   * When operational overview is already open above: keep chef primary visible
   * and collapse ContractWorkspaceSummary behind a disclosure.
   */
  collapseUnderOperationalOverview?: boolean;
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
  onApplySuggestion,
  isCreating = false,
  isApplying = false,
  collapseUnderOperationalOverview = false,
}: ContractOrderProposalPanelProps) {
  const positions = proposal.positions;
  const linkedVorgangId = item?.vorgangId ?? null;
  const vorgang = linkedVorgangId ? getVorgangById(linkedVorgangId) ?? null : null;
  const planLocked = Boolean(vorgang && isContractPlanLocked(vorgang));
  const summaryView = buildContractWorkspaceSummaryView(proposal, { item, vorgang });

  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(CONTRACT_PROPOSAL_INITIAL_VISIBLE_ROWS, positions.length),
  );
  const [drafts, setDrafts] = useState<Record<string, EnhancedDetectedOrderPosition>>({});
  const [selections, setSelections] = useState<ContractPositionSelectionMap>(() =>
    buildDefaultContractPositionSelections(positions),
  );
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [expandedClauseId, setExpandedClauseId] = useState<string | null>(null);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const originalTextId = useId();
  const technicalDetailsId = useId();
  const clauseRegionId = useId();
  const scrollFrameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

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

  const openEditorAndFocus = () => {
    setEditorExpanded(true);
    if (scrollFrameRef.current != null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      document
        .querySelector('[data-testid="contract-order-positions-editor"]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const visiblePositions = positions.slice(0, visibleCount);
  const hasMore = visibleCount < positions.length;
  const originalText = item ? getInboxExtractedDocumentText(item).trim() : '';
  const hasPositions = positions.length > 0;

  const primaryAction = hasPositions
    ? {
        label: translate('documentIntelligence.action.reviewPositionsBelow'),
        onClick: openEditorAndFocus,
        disabled: planLocked,
        loading: false,
        testId: 'contract-chef-primary-action',
      }
    : onApplySuggestion
      ? {
          label: translate('reviewWorkflow.action.applySuggestion'),
          onClick: onApplySuggestion,
          disabled: planLocked,
          loading: isApplying,
          testId: 'contract-chef-primary-action',
        }
      : undefined;

  const chefMoneyValue = summaryView.moneyMetric?.value?.trim() ?? '';
  const lvTotalLabel = summaryView.lvOverview?.totalLabel?.trim() ?? '';
  const showDistinctLvTotal =
    Boolean(lvTotalLabel) && (!chefMoneyValue || lvTotalLabel !== chefMoneyValue);

  return (
    <Card className="contract-order-proposal" data-testid="contract-order-proposal">
      <div className="contract-order-proposal__intro" data-testid="contract-order-proposal-intro">
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

      {collapseUnderOperationalOverview && primaryAction ? (
        <div
          className="contract-order-proposal__open-primary"
          data-testid="contract-workspace-summary-primary"
        >
          <Button
            fullWidth
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
            loading={primaryAction.loading}
            data-testid={primaryAction.testId}
          >
            {primaryAction.label}
          </Button>
        </div>
      ) : null}

      {collapseUnderOperationalOverview ? (
        <details
          className="contract-order-proposal__details-disclosure"
          data-testid="contract-details-disclosure"
        >
          <summary data-testid="contract-details-disclosure-toggle">
            {translate('operationalOverview.contractDetails.toggle')}
          </summary>
          <div
            className="contract-order-proposal__details-disclosure-body"
            data-testid="contract-details-disclosure-body"
          >
            <ContractWorkspaceSummary
              proposal={proposal}
              translate={translate}
              item={item}
              vorgang={vorgang}
            />
          </div>
        </details>
      ) : (
        <ContractWorkspaceSummary
          proposal={proposal}
          translate={translate}
          item={item}
          vorgang={vorgang}
          primaryAction={primaryAction}
        />
      )}

      {summaryView.lvOverview ? (
        <section
          className="contract-order-proposal__lv-overview"
          data-testid="contract-order-lv-overview"
        >
          <h4>{translate('documentIntelligence.workspace.section.lvOverview')}</h4>
          <p
            className="contract-order-proposal__lv-meta"
            data-testid="contract-order-lv-meta"
          >
            {summaryView.lvOverview.positionCount}{' '}
            {translate('documentIntelligence.field.positions')}
            {' · '}
            {summaryView.lvOverview.importableCount}{' '}
            {translate('documentIntelligence.workspace.positions.importable')}
            {summaryView.lvOverview.needsReviewCount > 0
              ? ` · ${summaryView.lvOverview.needsReviewCount} ${translate('documentIntelligence.workspace.positions.needsReview')}`
              : ''}
          </p>
          {showDistinctLvTotal ? (
            <p
              className="contract-order-proposal__lv-total-secondary"
              data-testid="contract-order-lv-total-secondary"
            >
              {translate('documentIntelligence.field.contractTotal')}: {lvTotalLabel}
            </p>
          ) : null}

          <div
            className="contract-order-proposal__compact-list"
            data-testid="contract-order-compact-positions"
          >
            {summaryView.compactPositions.map((position) => (
              <article
                key={buildContractPositionKey(position)}
                className="contract-order-proposal__compact-item"
                data-testid={`contract-compact-position-${position.positionNumber ?? 'x'}`}
              >
                <div className="contract-order-proposal__compact-top">
                  <span className="contract-order-proposal__compact-pos">
                    {position.positionNumber || '–'}
                  </span>
                  <span className="contract-order-proposal__compact-total">
                    {formatMoney(position.lineTotal)}
                  </span>
                </div>
                <p className="contract-order-proposal__compact-desc">{position.description}</p>
                <p className="contract-order-proposal__compact-meta">
                  {position.quantity || '–'} {position.unit || ''}
                  {' · '}
                  {formatMoney(position.unitPrice)}
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {hasPositions ? (
        <div
          className="contract-order-proposal__editor-wrap"
          data-testid="contract-order-positions-editor"
        >
          <ShowMoreSection
            expanded={editorExpanded}
            onToggle={() => setEditorExpanded((current) => !current)}
            showLabel={translate('documentIntelligence.action.editBillOfQuantities')}
            hideLabel={translate('documentIntelligence.action.hideBillOfQuantities')}
            testId="contract-lv-editor-disclosure"
          >
            <div className="contract-order-proposal__positions" data-testid="contract-order-positions">
              <h4>{translate('documentIntelligence.positionsTitle')}</h4>
              <div
                className="contract-order-proposal__table-scroll"
                data-testid="contract-order-table-scroll"
              >
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
                                } else if (
                                  position.reviewStatus === 'review_required' ||
                                  mathConflict
                                ) {
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
                              onChange={(event) =>
                                updateDraft(original, { description: event.target.value })
                              }
                            />
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
                          <td className="contract-order-proposal__money">
                            {formatMoney(position.lineTotal)}
                          </td>
                          <td>
                            <span
                              className={`contract-order-proposal__badge contract-order-proposal__badge--${state}`}
                            >
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
              </div>
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

              <div className="contract-order-proposal__editor-actions">
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
              </div>
            </div>
          </ShowMoreSection>
        </div>
      ) : null}

      {summaryView.clauseRows.length > 0 ? (
        <div
          className="contract-order-proposal__clauses"
          data-testid="contract-order-proposal-clauses"
        >
          <h4>{translate('documentIntelligence.workspace.section.clauses')}</h4>
          <ul className="contract-order-proposal__clause-list">
            {summaryView.clauseRows.map((clause) => {
              const expanded = expandedClauseId === clause.id;
              const detailId = `${clauseRegionId}-${clause.id}`;
              const hasLongText = clause.value !== clause.shortValue;
              return (
                <li
                  key={clause.id}
                  className="contract-order-proposal__clause-item"
                  data-testid={`contract-clause-${clause.id}`}
                >
                  <div className="contract-order-proposal__clause-head">
                    <span className="contract-order-proposal__clause-name">
                      {translate(clause.labelKey)}
                    </span>
                    <span className="contract-order-proposal__clause-short">{clause.shortValue}</span>
                  </div>
                  {hasLongText ? (
                    <>
                      <button
                        type="button"
                        className="contract-order-proposal__clause-toggle"
                        data-testid={`contract-clause-toggle-${clause.id}`}
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        onClick={() =>
                          setExpandedClauseId((current) =>
                            current === clause.id ? null : clause.id,
                          )
                        }
                      >
                        {expanded
                          ? translate('documentIntelligence.workspace.clause.hideDetail')
                          : translate('documentIntelligence.workspace.clause.showDetail')}
                      </button>
                      {expanded ? (
                        <p
                          id={detailId}
                          className="contract-order-proposal__clause-full"
                          data-testid={`contract-clause-full-${clause.id}`}
                        >
                          {clause.value}
                        </p>
                      ) : (
                        <div id={detailId} hidden />
                      )}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {originalText ? (
        <details
          className="contract-order-proposal__original-text"
          data-testid="contract-order-proposal-original-text"
          onToggle={(event) =>
            setOriginalOpen((event.currentTarget as HTMLDetailsElement).open)
          }
        >
          <summary aria-expanded={originalOpen} aria-controls={originalTextId}>
            {translate('documentIntelligence.workspace.section.originalText')}
          </summary>
          <pre id={originalTextId} className="contract-order-proposal__original-text-body">
            {originalText}
          </pre>
        </details>
      ) : null}

      {summaryView.showTechnicalDetails ? (
        <details
          className="contract-order-proposal__technical"
          data-testid="contract-order-proposal-technical"
          onToggle={(event) =>
            setTechnicalOpen((event.currentTarget as HTMLDetailsElement).open)
          }
        >
          <summary aria-expanded={technicalOpen} aria-controls={technicalDetailsId}>
            {translate('documentIntelligence.workspace.section.technical')}
          </summary>
          <div id={technicalDetailsId}>
            <DataRow
              label={translate('documentIntelligence.section.contractCore')}
              value={summaryView.technicalMeta.contractCorePages}
            />
            <DataRow
              label={translate('documentIntelligence.section.billOfQuantities')}
              value={summaryView.technicalMeta.billOfQuantitiesPages}
            />
            <DataRow
              label={translate('documentIntelligence.section.technicalAttachments')}
              value={String(summaryView.technicalMeta.technicalAttachmentCount)}
            />
          </div>
        </details>
      ) : null}

      <div className="contract-order-proposal__actions">
        {planLocked ? (
          <p
            className="invoice-hint invoice-hint--warning"
            data-testid="contract-import-plan-locked"
          >
            {translate('orderPlan.confirmedHint')}
          </p>
        ) : null}
        {onDiscard && (
          <Button
            variant="ghost"
            fullWidth
            disabled={isCreating || isApplying}
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
