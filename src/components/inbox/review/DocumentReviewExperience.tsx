import type { ReactNode } from 'react';
import { Button } from '../../ui/Button';
import {
  buildDocumentReviewChecks,
  buildDocumentReviewHero,
  buildDocumentReviewRecommendations,
  buildDocumentReviewSuccessSteps,
  buildPaperRegisterHint,
  isDocumentReviewComplete,
} from '../../../services/documentReviewViewService';
import { buildOperationalOverviewView } from '../../../services/operationalOverviewView';
import {
  buildDocumentWorkTruthConflictDisplayLines,
} from '../../../services/documentWorkResultResolveService';
import { buildDocumentWorkTruthViewForInboxItem } from '../../../services/documentWorkResultTruthOrchestration';
import type {
  InboxItem,
  WorkflowResult,
  WorkflowResultExecution,
} from '../../../types/models';
import type { DocumentFieldFillConfirmRow } from '../../../types/documentFieldFillConfirm';
import type { EnhancedDetectedOrderPosition } from '../../../types/documentIntelligence';
import type { TranslationKey } from '../../../i18n';
import { DocumentReviewChecks } from './DocumentReviewChecks';
import { DocumentReviewHero } from './DocumentReviewHero';
import { DocumentReviewRecommendations } from './DocumentReviewRecommendations';
import { DocumentReviewSuccess } from './DocumentReviewSuccess';
import { ReviewMoreOptionsShell } from './CollapsibleReviewSection';
import { ContractOrderProposalPanel } from './ContractOrderProposalPanel';
import { OperationalOverview } from './OperationalOverview';

interface DocumentReviewExperienceProps {
  item: InboxItem;
  workflow: WorkflowResult;
  executionResult?: WorkflowResultExecution | null;
  isExecuting?: boolean;
  moreOptionsExpanded: boolean;
  onToggleMoreOptions: () => void;
  onApplySuggestion: () => void;
  onCreateContractOrder?: (selectedPositions: EnhancedDetectedOrderPosition[]) => void;
  onDiscardContractProposal?: () => void;
  isCreatingContractOrder?: boolean;
  onOpenVorgang?: () => void;
  onOpenArchive?: () => void;
  onNextDocument: () => void;
  moreOptionsContent: ReactNode;
  translate: (key: TranslationKey) => string;
  /** Session Fill-Confirm rows — same TruthView as Assist / Free-Question. */
  sessionFillConfirmRows?: DocumentFieldFillConfirmRow[] | null;
}

export function DocumentReviewExperience({
  item,
  workflow,
  executionResult,
  isExecuting = false,
  moreOptionsExpanded,
  onToggleMoreOptions,
  onApplySuggestion,
  onCreateContractOrder,
  onDiscardContractProposal,
  isCreatingContractOrder = false,
  onOpenVorgang,
  onOpenArchive,
  onNextDocument,
  moreOptionsContent,
  translate,
  sessionFillConfirmRows = null,
}: DocumentReviewExperienceProps) {
  const hero = buildDocumentReviewHero(item, workflow);
  const recommendations = buildDocumentReviewRecommendations(item, workflow);
  const checks = buildDocumentReviewChecks(item, workflow);
  const complete = isDocumentReviewComplete(checks);
  const paperRegisterHint = buildPaperRegisterHint(item);
  const successSteps = executionResult?.completed
    ? buildDocumentReviewSuccessSteps(executionResult)
    : [];

  // Display truth (overlay + session Fill-Confirm). Actions still use live `workflow` only.
  const truth = buildDocumentWorkTruthViewForInboxItem({
    item,
    liveWorkflow: workflow,
    sessionFillConfirmRows,
  });
  const overview = buildOperationalOverviewView(workflow, {
    senderFallback: item.sender,
    inboxItem: item,
    displayBusinessInterpretation:
      truth?.businessInterpretation ?? workflow.businessInterpretation,
    unresolvedConflictLines: truth
      ? buildDocumentWorkTruthConflictDisplayLines(truth)
      : undefined,
    // Plan preview always from live workflow (never from snapshot-only truth).
    includePlanPreview: true,
  });

  const primaryDisabled = !item.isAdvertisement && !workflow.companyRelevant;

  const primaryLabel = item.isAdvertisement
    ? translate('reviewWorkflow.action.reviewAdvertisement')
    : translate('reviewWorkflow.action.applySuggestion');

  const showLegacySummary = !overview.present;
  const showContractProposal = Boolean(workflow.contractOrderProposal) && !executionResult?.completed;
  const showOverviewPrimary =
    overview.present && !executionResult?.completed && !showContractProposal;
  const showLegacyPrimary =
    !overview.present && !executionResult?.completed && !showContractProposal;

  return (
    <div className="document-review-experience" data-testid="document-review-experience">
      {overview.present ? (
        <OperationalOverview
          view={overview}
          translate={translate}
          primaryAction={
            showOverviewPrimary
              ? {
                  label: primaryLabel,
                  disabled: primaryDisabled,
                  loading: isExecuting || isCreatingContractOrder,
                  onClick: onApplySuggestion,
                }
              : null
          }
        />
      ) : null}

      {showLegacySummary ? (
        <div className="document-review-experience__layout">
          <div className="document-review-experience__summary">
            <DocumentReviewHero hero={hero} translate={translate} />
          </div>

          <div className="document-review-experience__aside">
            <DocumentReviewRecommendations
              recommendations={recommendations}
              paperRegisterHint={paperRegisterHint}
              translate={translate}
            />
            <DocumentReviewChecks checks={checks} complete={complete} translate={translate} />
          </div>
        </div>
      ) : null}

      {showContractProposal ? (
        <ContractOrderProposalPanel
          proposal={workflow.contractOrderProposal!}
          translate={translate}
          item={item}
          onConfirmImport={(selected) => onCreateContractOrder?.(selected)}
          onDiscard={onDiscardContractProposal}
          onApplySuggestion={
            primaryDisabled
              ? undefined
              : () => {
                  onApplySuggestion();
                }
          }
          isCreating={isCreatingContractOrder}
          isApplying={isExecuting || isCreatingContractOrder}
          collapseUnderOperationalOverview={overview.present}
        />
      ) : null}

      {executionResult?.completed && successSteps.length > 0 ? (
        <DocumentReviewSuccess
          steps={successSteps}
          vorgangId={executionResult.vorgangId ?? item.vorgangId}
          archiveDocumentId={executionResult.archiveDocumentId ?? item.archiveDocumentId}
          translate={translate}
          onOpenVorgang={onOpenVorgang}
          onOpenArchive={onOpenArchive}
          onNextDocument={onNextDocument}
        />
      ) : showLegacyPrimary ? (
        <div className="document-review-experience__primary" data-testid="document-review-primary-action">
          <Button
            fullWidth
            disabled={primaryDisabled}
            loading={isExecuting || isCreatingContractOrder}
            onClick={onApplySuggestion}
            data-testid="document-review-apply-button"
          >
            {primaryLabel}
          </Button>
        </div>
      ) : null}

      <ReviewMoreOptionsShell
        expanded={moreOptionsExpanded}
        onToggle={onToggleMoreOptions}
        toggleLabel={translate('reviewWorkflow.moreOptions.show')}
        hideLabel={translate('reviewWorkflow.moreOptions.hide')}
      >
        {moreOptionsContent}
      </ReviewMoreOptionsShell>
    </div>
  );
}
