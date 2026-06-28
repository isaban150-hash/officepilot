import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import {
  getClassificationForItem,
  getSuggestedVorgangForItem,
} from '../../services/documentClassificationService';
import type { DocumentClassificationResult } from '../../types/models';
import { linkInboxToExistingVorgang } from '../../services/vorgangService';
import type { DocumentActionId, InboxItem, SuggestedDocumentAction, Vorgang } from '../../types/models';
import type { TranslationKey } from '../../i18n';

const MAX_PRIMARY_ACTIONS = 3;

interface Props {
  item: InboxItem;
  translate: (key: TranslationKey) => string;
  onVorgangLinked: (item: InboxItem, vorgang: Vorgang) => void;
  onConfirmFiling: () => void;
  onImportArchive: () => void;
  onCreateTask: () => void;
  onOpenVorgangDialog: () => void;
  onShowToast: (message: string) => void;
}

export function DocumentActionSuggestionsPanel({
  item,
  translate,
  onVorgangLinked,
  onConfirmFiling,
  onImportArchive,
  onCreateTask,
  onOpenVorgangDialog,
  onShowToast,
}: Props) {
  const [showAllActions, setShowAllActions] = useState(false);
  const classification: DocumentClassificationResult = getClassificationForItem(item);
  const suggestedVorgang = getSuggestedVorgangForItem(item);

  const primaryActions = classification.actions.slice(0, MAX_PRIMARY_ACTIONS);
  const secondaryActions = classification.actions.slice(MAX_PRIMARY_ACTIONS);
  const visibleActions = showAllActions ? classification.actions : primaryActions;

  const handleLinkSuggestedVorgang = () => {
    if (!suggestedVorgang) return;
    const result = linkInboxToExistingVorgang(item, suggestedVorgang.vorgangId);
    if (result) {
      onVorgangLinked(result.inbox, result.vorgang);
      onShowToast(translate('vorgang.link.success'));
    }
  };

  const handleAction = (actionId: DocumentActionId) => {
    switch (actionId) {
      case 'save_bg_bau_folder':
      case 'save_tax_folder':
      case 'save_health_folder':
        onConfirmFiling();
        break;
      case 'confirm_filing':
        if (item.isAdvertisement) {
          onShowToast(translate('classification.action.disposeHint'));
        } else {
          onConfirmFiling();
        }
        break;
      case 'check_deadline':
      case 'monitor_validity':
        if (item.taskTemplate) {
          onCreateTask();
        } else {
          onShowToast(translate('classification.action.deadlineHint'));
        }
        break;
      case 'show_contact':
        onShowToast(
          item.recognizedData.Ansprechpartner
            ? `${translate('classification.action.contactLabel')}: ${item.recognizedData.Ansprechpartner}`
            : `${translate('classification.action.contactLabel')}: ${item.sender}`,
        );
        break;
      case 'link_vorgang':
      case 'create_vorgang':
      case 'import_positions':
      case 'import_hours':
      case 'check_proof_requirements':
      case 'suggest_schlussrechnung':
        onOpenVorgangDialog();
        break;
      case 'check_payment':
      case 'record_expense':
        onShowToast(translate('classification.action.paymentHint'));
        break;
      case 'archive':
        onImportArchive();
        break;
      case 'send_to_customer':
        onShowToast(translate('classification.action.sendToCustomerHint'));
        break;
      case 'mark_important':
        onShowToast(translate('classification.action.markedImportant'));
        break;
      case 'create_task':
        onCreateTask();
        break;
      default:
        break;
    }
  };

  const kindKey = `classifiedKind.${classification.classifiedKind}` as TranslationKey;
  const processKey = `processType.${classification.processType}` as TranslationKey;

  return (
    <>
      <Card className="classification-explanation" highlight>
        <h3 className="section__title">{translate('classification.explanationTitle')}</h3>
        <dl className="classification-meta">
          <div className="classification-meta__row">
            <dt>{translate('classification.documentKind')}</dt>
            <dd>{translate(kindKey)}</dd>
          </div>
          <div className="classification-meta__row">
            <dt>{translate('classification.processType')}</dt>
            <dd>{translate(processKey)}</dd>
          </div>
          <div className="classification-meta__row">
            <dt>{translate('classification.suggestedFolder')}</dt>
            <dd>{classification.digitalFolder.path}</dd>
          </div>
          <div className="classification-meta__row">
            <dt>{translate('classification.detectionReason')}</dt>
            <dd>{translate(classification.detectionReasonKey as TranslationKey)}</dd>
          </div>
          <div className="classification-meta__row">
            <dt>{translate('classification.nextAction')}</dt>
            <dd>{classification.nextTaskLabel}</dd>
          </div>
        </dl>
        <p className="classification-explanation__summary">{classification.explanation}</p>
      </Card>

      {suggestedVorgang && (
        <Card className="classification-vorgang-hint">
          <h3 className="section__title">{translate('classification.vorgangSuggestionTitle')}</h3>
          <p>
            {translate('classification.vorgang.couldBelongTo').replace(
              '{vorgang}',
              suggestedVorgang.vorgangTitle,
            )}
          </p>
          <p className="classification-vorgang-hint__meta">
            {translate(suggestedVorgang.reasonKey as TranslationKey)} · {suggestedVorgang.customer}
          </p>
          <Button type="button" onClick={handleLinkSuggestedVorgang}>
            {translate('classification.vorgang.linkButton')}
          </Button>
        </Card>
      )}

      <Card className="classification-actions">
        <h3 className="section__title">{translate('classification.actionsTitle')}</h3>
        <div className="classification-actions__buttons">
          {visibleActions.map((action: SuggestedDocumentAction) => (
            <Button
              key={action.id}
              type="button"
              variant={action.variant ?? 'outline'}
              onClick={() => handleAction(action.id)}
            >
              {translate(action.labelKey as TranslationKey)}
            </Button>
          ))}
        </div>
        {secondaryActions.length > 0 && (
          <button
            type="button"
            className="classification-actions__toggle"
            onClick={() => setShowAllActions((prev) => !prev)}
          >
            {showAllActions
              ? translate('classification.showLess')
              : translate('classification.showMore')}
          </button>
        )}
      </Card>
    </>
  );
}
