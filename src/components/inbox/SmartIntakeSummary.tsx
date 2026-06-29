import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { InboxItem, WorkflowResult } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface SmartIntakeSummaryProps {
  workflow: WorkflowResult;
  item: InboxItem;
  onArchive: () => void;
  onLinkVorgang: () => void;
  onCreateVorgang: () => void;
  onImportPositions: () => void;
  onAcceptTasks: () => void;
  onCancel: () => void;
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
  onArchive,
  onLinkVorgang,
  onCreateVorgang,
  onImportPositions,
  onAcceptTasks,
  onCancel,
}: SmartIntakeSummaryProps) {
  const { translate } = useApp();
  const kindKey = `classifiedKind.${workflow.classifiedKind}` as TranslationKey;

  const handleAction = (actionId: WorkflowResult['nextActions'][number]['id']) => {
    switch (actionId) {
      case 'archive_document':
        onArchive();
        break;
      case 'link_vorgang':
        onLinkVorgang();
        break;
      case 'create_vorgang':
        onCreateVorgang();
        break;
      case 'import_positions':
        onImportPositions();
        break;
      case 'accept_tasks':
        onAcceptTasks();
        break;
      case 'cancel':
        onCancel();
        break;
      default:
        break;
    }
  };

  const vorgangDetail = workflow.suggestedVorgang
    ? workflow.suggestedVorgang.vorgangTitle
    : workflow.similarVorgaenge.length > 0
      ? translate('intake.vorgang.similarFound').replace(
          '{count}',
          String(workflow.similarVorgaenge.length),
        )
      : translate('intake.vorgang.createNew');

  return (
    <Card className="smart-intake-card" highlight>
      <CardTitle>{translate('intake.title')}</CardTitle>
      <CardMeta>{translate('intake.subtitle')}</CardMeta>

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
            workflow.suggestedTasks.length > 0
              ? translate('intake.check.tasksCount').replace(
                  '{count}',
                  String(workflow.suggestedTasks.length),
                )
              : translate('intake.check.tasksNone')
          }
          active={workflow.suggestedTasks.length > 0}
        />
        <CheckRow
          label={translate('intake.check.archiveFolder')}
          detail={workflow.suggestedArchiveFolder.path}
          active={Boolean(workflow.suggestedArchiveFolder.path)}
        />
        <CheckRow
          label={translate('intake.check.nextSteps')}
          detail={
            workflow.documentExplanation?.nextSteps ??
            workflow.classification?.nextTaskLabel ??
            item.officePilotSuggestion
          }
          active
        />
      </ul>

      {workflow.warnings.length > 0 && (
        <div className="smart-intake-warnings">
          {workflow.warnings.map((warning) => (
            <p key={warning.id}>{warning.message}</p>
          ))}
        </div>
      )}

      <div className="smart-intake-actions">
        {workflow.nextActions.map((action) => (
          <Button
            key={action.id}
            type="button"
            variant={action.id === 'cancel' ? 'ghost' : action.id === 'archive_document' ? 'primary' : 'outline'}
            disabled={!action.enabled}
            onClick={() => handleAction(action.id)}
          >
            {translate(action.labelKey as TranslationKey)}
          </Button>
        ))}
      </div>
    </Card>
  );
}
