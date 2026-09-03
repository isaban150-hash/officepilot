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
import { buildDocumentSummary } from '../../../services/documentSummary';
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
import type { LetterExplanation } from '../../../services/letterExplanationService';
import type { TranslationKey } from '../../../i18n';
import type { DocumentSummaryActionId } from '../../../types/documentSummary';
import { DocumentReviewChecks } from './DocumentReviewChecks';
import { DocumentReviewHero } from './DocumentReviewHero';
import { DocumentReviewRecommendations } from './DocumentReviewRecommendations';
import { DocumentReviewSuccess } from './DocumentReviewSuccess';
import { ReviewMoreOptionsShell } from './CollapsibleReviewSection';
import { ContractOrderProposalPanel } from './ContractOrderProposalPanel';
import { DocumentExperienceCard } from './DocumentExperienceCard';

interface DocumentReviewExperienceProps {
  item: InboxItem;
  workflow: WorkflowResult;
  executionResult?: WorkflowResultExecution | null;
  isExecuting?: boolean;
  moreOptionsExpanded: boolean;
  onToggleMoreOptions: () => void;
  onApplySuggestion: () => void;
  onCreateContractOrder?: (selectedPositions: EnhancedDetectedOrderPosition[]) => void;
  /** CUSTOMER-FACHOBJEKT-04C — customer decision rendered at the contract confirmation. */
  customerDecisionSlot?: ReactNode;
  customerDecisionBlocked?: boolean;
  onDiscardContractProposal?: () => void;
  /** Secondary inquiry from Auftragskarte — opens more options / communication. */
  onContractInquiry?: () => void;
  isCreatingContractOrder?: boolean;
  /** Optional vorgang id from case match — caller navigates; no auto-link. */
  onOpenVorgang?: (vorgangId?: string) => void;
  onOpenArchive?: () => void;
  onNextDocument: () => void;
  /** Secondary: open vorgang link dialog (invoice/delivery). */
  onLinkVorgang?: () => void;
  /** Secondary: create task without full intake. */
  onCreateTask?: () => void;
  moreOptionsContent: ReactNode;
  /**
   * @deprecated DOCUMENT-EXPERIENCE-02A — archive/actions must not sit above zone D.
   * Prefer content inside Weitere Optionen (F).
   */
  beforeMoreOptions?: ReactNode;
  /** Zone E for Experience Card (Guidance / Letter). */
  experienceDetailsExtra?: ReactNode;
  /** Letter explanation for authority/brief Experience facts (builder input only). */
  letterExplanation?: LetterExplanation | null;
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
  customerDecisionSlot = null,
  customerDecisionBlocked = false,
  onDiscardContractProposal,
  onContractInquiry,
  isCreatingContractOrder = false,
  onOpenVorgang,
  onOpenArchive,
  onNextDocument,
  onLinkVorgang,
  onCreateTask,
  moreOptionsContent,
  beforeMoreOptions = null,
  experienceDetailsExtra = null,
  letterExplanation = null,
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

  const truth = buildDocumentWorkTruthViewForInboxItem({
    item,
    liveWorkflow: workflow,
    sessionFillConfirmRows,
  });
  const displayBi = truth?.businessInterpretation ?? workflow.businessInterpretation;

  const summary = buildDocumentSummary(item, workflow, {
    translate,
    displayBusinessInterpretation: displayBi,
    letter: letterExplanation,
  });

  // Keep overview builder for Details enrichment / conflict lines (not first paint).
  const overview = buildOperationalOverviewView(workflow, {
    senderFallback: item.sender,
    inboxItem: item,
    displayBusinessInterpretation: displayBi,
    unresolvedConflictLines: truth
      ? buildDocumentWorkTruthConflictDisplayLines(truth)
      : undefined,
    includePlanPreview: true,
  });

  const primaryDisabled = !item.isAdvertisement && !workflow.companyRelevant;

  /*
   * CONTRACT-ORDER-ALREADY-LINKED-UX-01D — ein bereits erfasster Werkvertrag
   * bietet die produktive Erfassung nicht erneut an.
   *
   * Die Entscheidung faellt an einer einzigen Stelle: `attachDocumentCaseMatch`
   * zieht `accept_contract_order` zurueck, sobald das Dokument an einem Vorgang
   * haengt. Bleibt die Aktion aus, darf auch die Auftragskarte nicht mehr
   * erscheinen — sonst boete sie dieselbe Erfassung ein zweites Mal an, genau
   * wie auf dem iPhone beobachtet.
   *
   * Der Auftragsvorschlag wird weiterhin berechnet und bleibt unangetastet.
   */
  const acceptOfferWithdrawn = summary.primaryAction.id !== 'accept_contract_order';
  const showContractProposal =
    Boolean(workflow.contractOrderProposal) &&
    !executionResult?.completed &&
    !acceptOfferWithdrawn;
  // Experience Card is the shared first paint for every family without an open proposal —
  // including contract/auftrag. Excluding family==='contract' left a lead-surface hole
  // (no Experience Card, no Auftragskarte, no legacy primary) when no proposal exists.
  const showExperience = !showContractProposal && !executionResult?.completed;
  const showLegacySummary =
    !showContractProposal && !executionResult?.completed && !showExperience && !overview.present;
  const showLegacyPrimary =
    !showContractProposal && !executionResult?.completed && !showExperience && !overview.present;

  const nextStepDetail = summary.details.find((d) => d.id === 'nextStep');

  const detailsBody = (
    <>
      {nextStepDetail?.proseText ? (
        <p data-testid="document-experience-next-step">
          <strong>{translate('documentExperience.details.nextStep')}: </strong>
          {nextStepDetail.proseText}
        </p>
      ) : null}
      {overview.uncertaintyLines.length > 0 || overview.recognitionUncertain ? (
        <ul data-testid="document-experience-detail-uncertainty">
          {overview.recognitionUncertain ? (
            <li>{translate('operationalOverview.uncertainty.recognition')}</li>
          ) : null}
          {overview.uncertaintyLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {experienceDetailsExtra}
    </>
  );

  const handleExperienceAction = (actionId: DocumentSummaryActionId) => {
    if (actionId === 'later') {
      onNextDocument();
      return;
    }
    if (actionId === 'open_vorgang') {
      const matchedId = summary.caseMatch?.matchedCaseId ?? item.vorgangId;
      onOpenVorgang?.(matchedId);
      return;
    }
    if (actionId === 'link_vorgang' || actionId === 'select_vorgang') {
      onLinkVorgang?.();
      return;
    }
    if (actionId === 'create_vorgang') {
      onApplySuggestion();
      return;
    }
    if (actionId === 'create_task') {
      onCreateTask?.();
      return;
    }
    // Existing intake / family primary path — no domain match writes here.
    if (actionId === summary.primaryAction.id) {
      onApplySuggestion();
      return;
    }
    onApplySuggestion();
  };

  return (
    <div className="document-review-experience" data-testid="document-review-experience">
      {showExperience ? (
        <DocumentExperienceCard
          summary={summary}
          translate={translate}
          onAction={handleExperienceAction}
          actionUi={{
            [summary.primaryAction.id]: {
              disabled: primaryDisabled || !summary.primaryAction.enabled,
              loading: isExecuting || isCreatingContractOrder,
              testId: 'document-review-apply-button',
            },
            later: {
              testId: 'document-experience-secondary-later',
              variant: 'ghost',
            },
            link_vorgang: {
              testId: 'document-experience-secondary-link_vorgang',
            },
            create_task: {
              testId: 'document-experience-secondary-create_task',
            },
          }}
          details={detailsBody}
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
          customerDecisionSlot={customerDecisionSlot}
          customerDecisionBlocked={customerDecisionBlocked}
          onDiscard={onDiscardContractProposal}
          onInquiry={onContractInquiry}
          onApplySuggestion={
            primaryDisabled
              ? undefined
              : () => {
                  onApplySuggestion();
                }
          }
          isCreating={isCreatingContractOrder}
          isApplying={isExecuting || isCreatingContractOrder}
          detailsExtra={experienceDetailsExtra}
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
            {translate('reviewWorkflow.action.applySuggestion')}
          </Button>
        </div>
      ) : null}

      {beforeMoreOptions}

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
