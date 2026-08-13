import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { InboxItem, WorkflowResult, WorkflowResultExecution } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { formatMessage } from '../../i18n/formatMessage';
import type { ExplanationTextBlock } from '../../i18n/types';
import { isDocumentFilingDecisionConfirmed } from '../../services/documentFilingDecisionService';
import { getTaskProposals } from '../../services/workflowDecisionUtils';

interface SmartIntakeSummaryProps {
  workflow: WorkflowResult;
  item: InboxItem;
  executionResult?: WorkflowResultExecution | null;
  isExecuting?: boolean;
  onExecuteAll: () => void;
  onArchive: () => void;
  onCreateVorgang: () => void;
  onImportPositions: () => void;
  onAcceptTasks: () => void;
  onCancel: () => void;
  /** ORDER-PLAN-INTEGRITY-01: hide/disable position import when linked vorgang is confirmed. */
  importPositionsLocked?: boolean;
}

function CheckRow({
  label,
  detail,
  active = true,
}: {
  label: string;
  detail?: string;
  active?: boolean;
}) {
  return (
    <li className={`smart-intake-check ${active ? 'smart-intake-check--active' : 'smart-intake-check--inactive'}`}>
      <span className="smart-intake-check__mark" aria-hidden>
        {active ? '✓' : '–'}
      </span>
      <span className="smart-intake-check__content">
        <strong>{label}</strong>
        {detail ? <span className="smart-intake-check__detail">{detail}</span> : null}
      </span>
    </li>
  );
}

export function SmartIntakeSummary({
  workflow,
  item,
  executionResult,
  isExecuting = false,
  onExecuteAll,
  onArchive,
  onCreateVorgang,
  onImportPositions,
  onAcceptTasks,
  onCancel,
  importPositionsLocked = false,
}: SmartIntakeSummaryProps) {
  const { translate } = useApp();
  const kindKey = `classifiedKind.${workflow.classifiedKind}` as TranslationKey;
  const renderExplanationBlock = (block: ExplanationTextBlock) =>
    formatMessage((key) => translate(key as TranslationKey), block);

  // Prefer `workflowDecision` when present (live path). Fall back to legacy `suggestedTasks` for
  // legacy/restore/test fixtures where no decision was produced.
  const taskProposals = getTaskProposals(workflow);

  const vorgangDetail = workflow.suggestedVorgang
    ? workflow.suggestedVorgang.vorgangTitle
    : workflow.similarVorgaenge.length > 0
      ? translate('intake.vorgang.similarFound').replace(
          '{count}',
          String(workflow.similarVorgaenge.length),
        )
      : translate('intake.vorgang.createNew');

  const canExecuteAll =
    workflow.companyRelevant &&
    !item.isAdvertisement &&
    isDocumentFilingDecisionConfirmed(item);
  const canArchive =
    workflow.companyRelevant &&
    !item.importedToArchive &&
    isDocumentFilingDecisionConfirmed(item);

  return (
    <Card className="smart-intake-card" highlight>
      <CardTitle>{translate('intake.title')}</CardTitle>
      <CardMeta>{translate('intake.subtitle')}</CardMeta>

      {executionResult?.completed && (
        <p className="smart-intake-success">{translate('intake.execute.success')}</p>
      )}

      {executionResult && !executionResult.completed && executionResult.failedSteps.length > 0 && (
        <div className="smart-intake-warnings">
          {executionResult.failedSteps.map((failure) => (
            <p key={`${failure.step}-${failure.message}`}>
              {failure.step}: {failure.message}
            </p>
          ))}
        </div>
      )}

      <ul className="smart-intake-checks">
        <CheckRow
          label={translate('intake.check.documentRecognized')}
          detail={translate(kindKey)}
          active={Boolean(workflow.classification)}
        />
        <CheckRow
          label={translate('intake.check.companyRelevance')}
          detail={
            workflow.companyRelevant
              ? workflow.companyRelevance.matchedHints.slice(0, 2).join(', ') ||
                translate('intake.check.companyRelevanceYes')
              : translate('intake.check.companyRelevanceNo')
          }
          active={workflow.companyRelevant}
        />
        <CheckRow
          label={translate('intake.check.contract')}
          detail={
            workflow.contractAnalysis
              ? workflow.contractAnalysis.contractType ?? translate('intake.check.contractYes')
              : translate('intake.check.contractNo')
          }
          active={Boolean(workflow.contractAnalysis?.isContract)}
        />
        <CheckRow
          label={translate('intake.check.vorgang')}
          detail={vorgangDetail}
          active={Boolean(workflow.suggestedVorgang || workflow.similarVorgaenge.length > 0 || workflow.contractAnalysis?.isContract)}
        />
        <CheckRow
          label={translate('intake.check.positions')}
          detail={
            workflow.suggestedOrderPositions.length > 0
              ? translate('intake.check.positionsCount').replace(
                  '{count}',
                  String(workflow.suggestedOrderPositions.length),
                )
              : translate('intake.check.positionsNone')
          }
          active={workflow.suggestedOrderPositions.length > 0}
        />
        <CheckRow
          label={translate('intake.check.proofs')}
          detail={
            workflow.requiredDocuments.length > 0
              ? workflow.requiredDocuments.map((doc) => doc.type.replace(/_/g, ' ')).join(', ')
              : translate('intake.check.proofsNone')
          }
          active={workflow.requiredDocuments.length > 0}
        />
        <CheckRow
          label={translate('intake.check.tasks')}
          detail={
            taskProposals.length > 0
              ? translate('intake.check.tasksCount').replace('{count}', String(taskProposals.length))
              : translate('intake.check.tasksNone')
          }
          active={taskProposals.length > 0}
        />
        <CheckRow
          label={translate('intake.check.archiveFolder')}
          detail={workflow.suggestedArchiveFolder.path}
          active={Boolean(workflow.suggestedArchiveFolder.path)}
        />
        <CheckRow
          label={translate('intake.check.nextSteps')}
          detail={
            (workflow.documentExplanation?.nextSteps
              ? renderExplanationBlock(workflow.documentExplanation.nextSteps)
              : undefined) ??
            workflow.classification?.nextTaskLabel ??
            item.officePilotSuggestion
          }
          active
        />
      </ul>

      {workflow.warnings.length > 0 && !executionResult && (
        <div className="smart-intake-warnings">
          {workflow.warnings.map((warning) => (
            <p key={warning.id}>{warning.message}</p>
          ))}
        </div>
      )}

      <div className="smart-intake-actions smart-intake-actions--primary">
        <Button
          type="button"
          fullWidth
          disabled={!canExecuteAll || isExecuting || executionResult?.completed}
          onClick={onExecuteAll}
          data-testid="smart-intake-execute-all"
        >
          {translate('intake.action.executeAll')}
        </Button>
        {!isDocumentFilingDecisionConfirmed(item) && !item.importedToArchive ? (
          <p className="muted" data-testid="smart-intake-filing-confirm-required">
            {translate('filingDecision.confirmRequired')}
          </p>
        ) : null}
      </div>

      <div className="smart-intake-actions">
        <Button
          type="button"
          variant="outline"
          disabled={isExecuting || !canArchive}
          onClick={onArchive}
          data-testid="smart-intake-archive"
        >
          {translate('intake.action.archive')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isExecuting || Boolean(item.vorgangId)}
          onClick={onCreateVorgang}
          data-testid="smart-intake-create-vorgang"
        >
          {translate('intake.action.createVorgang')}
        </Button>
        {!importPositionsLocked ? (
          <Button
            type="button"
            variant="outline"
            data-testid="smart-intake-import-positions"
            disabled={
              isExecuting ||
              workflow.suggestedOrderPositions.length === 0 ||
              Boolean(workflow.contractOrderProposal
                ? false
                : !item.vorgangId && !workflow.suggestedVorgang)
            }
            onClick={onImportPositions}
          >
            {workflow.contractOrderProposal
              ? translate('documentIntelligence.action.reviewPositionsBelow')
              : translate('documentIntelligence.action.confirmSelectedPositions').replace(
                  '{count}',
                  String(workflow.suggestedOrderPositions.length),
                )}
          </Button>
        ) : (
          <p className="invoice-hint invoice-hint--warning" data-testid="smart-intake-import-locked">
            {translate('orderPlan.confirmedHint')}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={isExecuting || taskProposals.length === 0}
          onClick={onAcceptTasks}
        >
          {translate('intake.action.acceptTasks')}
        </Button>
        <Button type="button" variant="ghost" disabled={isExecuting} onClick={onCancel}>
          {translate('intake.action.cancel')}
        </Button>
      </div>
    </Card>
  );
}
