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
import type {
  InboxItem,
  WorkflowResult,
  WorkflowResultExecution,
} from '../../../types/models';
import type { EnhancedDetectedOrderPosition } from '../../../types/documentIntelligence';
import type { TranslationKey } from '../../../i18n';
import { DocumentReviewChecks } from './DocumentReviewChecks';
import { DocumentReviewHero } from './DocumentReviewHero';
import { DocumentReviewRecommendations } from './DocumentReviewRecommendations';
import { DocumentReviewSuccess } from './DocumentReviewSuccess';
import { ReviewMoreOptionsShell } from './CollapsibleReviewSection';
import { ContractOrderProposalPanel } from './ContractOrderProposalPanel';

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
  onNextDocument: () => void;
  moreOptionsContent: ReactNode;
  translate: (key: TranslationKey) => string;
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
  onNextDocument,
  moreOptionsContent,
  translate,
}: DocumentReviewExperienceProps) {
  const hero = buildDocumentReviewHero(item, workflow);
  const recommendations = buildDocumentReviewRecommendations(item, workflow);
  const checks = buildDocumentReviewChecks(item, workflow);
  const complete = isDocumentReviewComplete(checks);
  const paperRegisterHint = buildPaperRegisterHint(item);
  const successSteps = executionResult?.completed
    ? buildDocumentReviewSuccessSteps(executionResult)
    : [];

  const primaryDisabled = !item.isAdvertisement && !workflow.companyRelevant;

  const primaryLabel = item.isAdvertisement
    ? translate('reviewWorkflow.action.reviewAdvertisement')
    : translate('reviewWorkflow.action.applySuggestion');

  const scrollToProposal = () => {
    document
      .querySelector('[data-testid="contract-order-proposal"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="document-review-experience" data-testid="document-review-experience">
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

      {workflow.contractOrderProposal && !executionResult?.completed && (
        <ContractOrderProposalPanel
          proposal={workflow.contractOrderProposal}
          translate={translate}
          onConfirmImport={(selected) => onCreateContractOrder?.(selected)}
          onDiscard={onDiscardContractProposal}
          isCreating={isCreatingContractOrder}
        />
      )}

      {executionResult?.completed && successSteps.length > 0 ? (
        <DocumentReviewSuccess
          steps={successSteps}
          vorgangId={executionResult.vorgangId ?? item.vorgangId}
          translate={translate}
          onOpenVorgang={onOpenVorgang}
          onNextDocument={onNextDocument}
        />
      ) : workflow.contractOrderProposal ? (
        <div className="document-review-experience__primary" data-testid="document-review-primary-action">
          <Button
            variant="outline"
            fullWidth
            onClick={scrollToProposal}
            data-testid="document-review-scroll-proposal-button"
          >
            {translate('documentIntelligence.action.reviewPositionsBelow')}
          </Button>
        </div>
      ) : (
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
      )}

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
