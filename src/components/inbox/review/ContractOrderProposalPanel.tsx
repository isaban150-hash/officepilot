import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { Card, DataRow } from '../../ui/Card';
import { ShowMoreSection } from '../../ui/ShowMoreSection';
import type { ContractOrderProposal, EnhancedDetectedOrderPosition } from '../../../types/documentIntelligence';
import type { InboxItem } from '../../../types/models';
import type { TranslationKey } from '../../../i18n';
import {
  hasPositionMathConflict,
  isImportableLvPosition,
  type ContractPositionSelectionMap,
  type ContractPositionSelectionState,
} from '../../../services/contractPositionImportService';
import { buildContractWorkspaceSummaryView } from '../../../services/contractWorkspaceSummaryView';
import { buildDocumentSummary } from '../../../services/documentSummary';
import { getInboxExtractedDocumentText } from '../../../services/inboxDocumentText';
import { isContractPlanLocked } from '../../../services/orderPlanIntegrityService';
import { getVorgangById } from '../../../services/vorgangService';
import { Auftragskarte } from './Auftragskarte';
import { ContractWorkspaceSummary } from './ContractWorkspaceSummary';

/** Keep first paint light — remaining rows load on demand inside the editor. */
export const CONTRACT_PROPOSAL_INITIAL_VISIBLE_ROWS = 30;

interface ContractOrderProposalPanelProps {
  proposal: ContractOrderProposal;
  translate: (key: TranslationKey) => string;
  item?: InboxItem;
  onConfirmImport: (selectedPositions: EnhancedDetectedOrderPosition[]) => void;
  onDiscard?: () => void;
  /** Secondary: open inquiry / more options (no new business logic). */
  onInquiry?: () => void;
  /** Used when the proposal has no LV positions (existing Smart Intake entry). */
  onApplySuggestion?: () => void;
  isCreating?: boolean;
  isApplying?: boolean;
  /** CUSTOMER-FACHOBJEKT-04C — rendered right at the confirmation, no second dialog. */
  customerDecisionSlot?: ReactNode;
  /** Blocks the confirm CTAs while the customer decision is still incomplete. */
  customerDecisionBlocked?: boolean;
  /** @deprecated UX-01: Auftragskarte is always primary; kept for call-site compat. */
  collapseUnderOperationalOverview?: boolean;
  /** Zone E extra (e.g. DocumentGuidance) — DOCUMENT-EXPERIENCE-02A. */
  detailsExtra?: ReactNode;
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

/**
 * Selection identity inside the editor.
 *
 * The persisted identity (OrderPosition.id) does not exist yet at this point,
 * and buildContractPositionKey() is derived from positionNumber + description —
 * both editable here, and equal for two unnumbered rows with the same text.
 * A position therefore keeps its slot in proposal.positions as identity for the
 * lifetime of this panel. Nothing of this is persisted.
 */
function selectionKey(index: number): string {
  return `lv-${index}`;
}

/** Mirrors buildDefaultContractPositionSelections on the local selection key. */
function buildInitialSelections(
  positions: EnhancedDetectedOrderPosition[],
): ContractPositionSelectionMap {
  const selections: ContractPositionSelectionMap = {};
  positions.forEach((position, index) => {
    const key = selectionKey(index);
    if (!isImportableLvPosition(position)) {
      selections[key] = 'rejected';
      return;
    }
    if (position.reviewStatus === 'review_required') {
      selections[key] = 'needs_review';
      return;
    }
    selections[key] = 'selected';
  });
  return selections;
}

type PositionSafety = 'rejected' | 'needs_review' | 'safe';

/** Re-evaluated against the draft, because an edit can invalidate a row. */
function classifyPosition(position: EnhancedDetectedOrderPosition): PositionSafety {
  if (!isImportableLvPosition(position)) return 'rejected';
  if (position.reviewStatus === 'review_required' || hasPositionMathConflict(position)) {
    return 'needs_review';
  }
  return 'safe';
}

/**
 * „Auftrag annehmen“ — bestätigt, was der Nutzer sieht.
 *
 * Bestehende Zustände bleiben erhalten; eine bewusste Abwahl wird nicht
 * zurückgenommen. Nur noch nie bewertete sichere Zeilen werden vorausgewählt.
 */
function normalizeSelections(
  positions: EnhancedDetectedOrderPosition[],
  drafts: Record<string, EnhancedDetectedOrderPosition>,
  current: ContractPositionSelectionMap,
): ContractPositionSelectionMap {
  const next = { ...current };
  for (const [index, original] of positions.entries()) {
    const key = selectionKey(index);
    const safety = classifyPosition(drafts[key] ?? original);
    const state = next[key];

    if (safety === 'rejected') {
      next[key] = 'rejected';
      continue;
    }
    if (safety === 'needs_review') {
      if (state !== 'selected' && state !== 'rejected') {
        next[key] = 'needs_review';
      }
      continue;
    }
    if (state === undefined) {
      next[key] = 'selected';
    }
  }
  return next;
}

/**
 * „Alle sicheren auswählen“ — ausdrücklicher Nutzerbefehl.
 *
 * Darf eine frühere Abwahl aufheben, aber niemals review_required oder eine
 * verworfene Zeile freigeben. Importiert selbst nichts.
 */
function selectAllSafeSelections(
  positions: EnhancedDetectedOrderPosition[],
  drafts: Record<string, EnhancedDetectedOrderPosition>,
  current: ContractPositionSelectionMap,
): ContractPositionSelectionMap {
  const next = { ...current };
  for (const [index, original] of positions.entries()) {
    const key = selectionKey(index);
    const safety = classifyPosition(drafts[key] ?? original);
    const state = next[key];

    if (safety === 'rejected') {
      next[key] = 'rejected';
      continue;
    }
    if (safety === 'needs_review') {
      if (state !== 'selected' && state !== 'rejected') {
        next[key] = 'needs_review';
      }
      continue;
    }
    if (state !== 'rejected') {
      next[key] = 'selected';
    }
  }
  return next;
}

export function ContractOrderProposalPanel({
  proposal,
  translate,
  item,
  onConfirmImport,
  onDiscard,
  onInquiry,
  onApplySuggestion,
  isCreating = false,
  isApplying = false,
  customerDecisionSlot = null,
  customerDecisionBlocked = false,
  detailsExtra = null,
}: ContractOrderProposalPanelProps) {
  const positions = proposal.positions;
  const linkedVorgangId = item?.vorgangId ?? null;
  const vorgang = linkedVorgangId ? getVorgangById(linkedVorgangId) ?? null : null;
  const planLocked = Boolean(vorgang && isContractPlanLocked(vorgang));
  const summaryView = buildContractWorkspaceSummaryView(proposal, { item, vorgang });
  const summaryItem: InboxItem =
    item ??
    ({
      id: 'contract-summary-fallback',
      title: proposal.customer?.trim() || 'Auftrag',
      documentType: 'kundenauftrag',
      sender: proposal.customer ?? '',
      priority: 'mittel',
      deadline: null,
      recommendedAction: 'auftrag_annehmen',
      digitalFolder: { id: 'dig-contract', name: 'Verträge', path: '/vertraege/' },
      paperFiling: { folderId: 'folder-contract', register: 'V', label: 'Vertrag' },
      status: 'neu',
      receivedAt: new Date(0).toISOString(),
      recognizedData: {},
      officePilotSuggestion: '',
      nextTaskLabel: '',
      securityHint: '',
      classifiedKind: proposal.intelligence.classifiedKind,
    } satisfies InboxItem);
  const documentSummary = buildDocumentSummary(summaryItem, null, {
    translate,
    proposal,
    vorgang,
  });

  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(CONTRACT_PROPOSAL_INITIAL_VISIBLE_ROWS, positions.length),
  );
  const [drafts, setDrafts] = useState<Record<string, EnhancedDetectedOrderPosition>>({});
  const [selections, setSelections] = useState<ContractPositionSelectionMap>(() =>
    buildInitialSelections(positions),
  );
  const [scopeExpanded, setScopeExpanded] = useState(false);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [contractOpen, setContractOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expandedClauseId, setExpandedClauseId] = useState<string | null>(null);
  const [originalOpen, setOriginalOpen] = useState(false);
  const originalTextId = useId();
  const clauseRegionId = useId();
  const scrollFrameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const resolvePosition = (
    original: EnhancedDetectedOrderPosition,
    index: number,
  ): EnhancedDetectedOrderPosition => {
    return drafts[selectionKey(index)] ?? original;
  };

  const selectedCount = useMemo(
    () =>
      positions.filter((original, index) => {
        const key = selectionKey(index);
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
    index: number,
    patch: Partial<Pick<EnhancedDetectedOrderPosition, 'description' | 'quantity' | 'unit' | 'unitPrice'>>,
  ) => {
    const key = selectionKey(index);
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
      .map((original, index) => ({ original, index }))
      .filter(({ index }) => selections[selectionKey(index)] === 'selected')
      .map(({ original, index }) => resolvePosition(original, index))
      .filter((position) => isImportableLvPosition(position));
    onConfirmImport(selected);
  };

  const handleSelectAllSafe = () => {
    setSelections((current) => selectAllSafeSelections(positions, drafts, current));
  };

  /** Primary CTA — existing create/apply paths only, no new business logic. */
  const handleAccept = () => {
    if (planLocked) return;
    if (positions.length === 0) {
      onApplySuggestion?.();
      return;
    }
    const nextSelections = normalizeSelections(positions, drafts, selections);
    const selected = positions
      .map((original, index) => ({ original, index }))
      .filter(({ index }) => nextSelections[selectionKey(index)] === 'selected')
      .map(({ original, index }) => resolvePosition(original, index))
      .filter((position) => isImportableLvPosition(position));
    setSelections(nextSelections);
    if (selected.length === 0) {
      setScopeExpanded(true);
      setEditorExpanded(true);
      return;
    }
    onConfirmImport(selected);
  };

  const visiblePositions = positions.slice(0, visibleCount);
  const hasMore = visibleCount < positions.length;
  const originalText = item ? getInboxExtractedDocumentText(item).trim() : '';
  const hasPositions = positions.length > 0;
  const acceptDisabled =
    planLocked || customerDecisionBlocked || (hasPositions ? false : !onApplySuggestion);

  const chefMoneyValue = summaryView.moneyMetric?.value?.trim() ?? '';
  const lvTotalLabel = summaryView.lvOverview?.totalLabel?.trim() ?? '';
  const showDistinctLvTotal =
    Boolean(lvTotalLabel) && (!chefMoneyValue || lvTotalLabel !== chefMoneyValue);

  return (
    <div className="contract-order-proposal" data-testid="contract-order-proposal">
      <ContractWorkspaceSummary
        proposal={proposal}
        translate={translate}
        item={item}
        vorgang={vorgang}
      />

      {/* CUSTOMER-FACHOBJEKT-04C — must stay outside the collapsible LV editor:
          the primary confirmation is the Auftragskarte, not the position editor. */}
      {customerDecisionSlot}

      <Auftragskarte
        summary={documentSummary}
        translate={translate}
        acceptDisabled={acceptDisabled}
        acceptLoading={isCreating || isApplying}
        onAccept={handleAccept}
        onInquiry={onInquiry}
        onReject={onDiscard}
        scopeExpanded={scopeExpanded}
        onToggleScope={() => setScopeExpanded((open) => !open)}
        showScopeToggle={hasPositions}
        detailsExtra={detailsExtra}
      />

      {scopeExpanded && hasPositions ? (
        <Card className="contract-order-proposal__scope" data-testid="auftragskarte-lv-scope">
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
                {summaryView.compactPositions.map((position, index) => (
                  <article
                    key={selectionKey(index)}
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
                      {visiblePositions.map((original, index) => {
                        const key = selectionKey(index);
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
                                  updateDraft(original, index, {
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
                                onChange={(event) => updateDraft(original, index, { unit: event.target.value })}
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
                                  updateDraft(original, index, { description: event.target.value })
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
                                  updateDraft(original, index, {
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
                    disabled={planLocked || selectedCount === 0 || customerDecisionBlocked}
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
        </Card>
      ) : null}

      {planLocked ? (
        <p
          className="invoice-hint invoice-hint--warning"
          data-testid="contract-import-plan-locked"
        >
          {translate('orderPlan.confirmedHint')}
        </p>
      ) : null}

      <details
        className="contract-order-proposal__details-disclosure"
        data-testid="auftragskarte-contract"
        onToggle={(event) =>
          setContractOpen((event.currentTarget as HTMLDetailsElement).open)
        }
      >
        <summary data-testid="auftragskarte-contract-toggle" aria-expanded={contractOpen}>
          {contractOpen
            ? translate('auftragskarte.action.hideContract')
            : translate('auftragskarte.action.showContract')}
        </summary>
        <div
          className="contract-order-proposal__details-disclosure-body"
          data-testid="auftragskarte-contract-body"
        >
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
                        <span className="contract-order-proposal__clause-short">
                          {clause.shortValue}
                        </span>
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
        </div>
      </details>

      <details
        className="contract-order-proposal__details-disclosure"
        data-testid="auftragskarte-details"
        onToggle={(event) =>
          setDetailsOpen((event.currentTarget as HTMLDetailsElement).open)
        }
      >
        <summary data-testid="auftragskarte-details-toggle" aria-expanded={detailsOpen}>
          {translate('auftragskarte.section.technical')}
        </summary>
        <div
          className="contract-order-proposal__details-disclosure-body"
          data-testid="auftragskarte-details-body"
        >
          <div className="contract-order-proposal__intro" data-testid="contract-order-proposal-intro">
            <p>{translate('documentIntelligence.proposal.instruction')}</p>
          </div>

          {proposal.progressBillingHint ? (
            <p className="contract-order-proposal__hint" data-testid="contract-progress-billing-hint">
              {translate(proposal.progressBillingHint as TranslationKey)}
            </p>
          ) : null}

          {proposal.technicalAttachmentsLabel ? (
            <p
              className="contract-order-proposal__hint"
              data-testid="contract-technical-attachments-hint"
            >
              {translate(proposal.technicalAttachmentsLabel as TranslationKey)}
            </p>
          ) : null}

          {summaryView.showTechnicalDetails ? (
            <div
              className="contract-order-proposal__technical"
              data-testid="contract-order-proposal-technical"
            >
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
          ) : null}

          {proposal.paymentTermsSummary?.trim() ? (
            <DataRow
              label={translate('auftragskarte.field.paymentTerms')}
              value={proposal.paymentTermsSummary.trim()}
            />
          ) : null}
          {summaryView.deadlineFact?.value?.trim() ? (
            <DataRow
              label={translate('auftragskarte.field.deadline')}
              value={summaryView.deadlineFact.value.trim()}
            />
          ) : null}
        </div>
      </details>
    </div>
  );
}
