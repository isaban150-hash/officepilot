import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import {
  applyOfficeActionResult,
  executeDocumentAction,
  isDocumentActionAvailable,
} from '../../services/officeActionService';
import {
  getClassificationForItem,
  getSuggestedVorgangForItem,
} from '../../services/documentClassificationService';
import type {
  DocumentClassificationResult,
  DocumentActionId,
  InboxItem,
  SuggestedDocumentAction,
  SuggestedVorgangLink,
  Vorgang,
} from '../../types/models';
import { linkInboxToExistingVorgang } from '../../services/vorgangService';
import { getLastPersistSuccess } from '../../services/persistenceService';
import type { ApplyOfficeActionContext } from '../../services/officeActionService';
import type { TranslationKey } from '../../i18n';

const MAX_PRIMARY_ACTIONS = 3;

interface Props {
  item: InboxItem;
  classification?: DocumentClassificationResult;
  suggestedVorgang?: SuggestedVorgangLink;
  availableDocumentActions: SuggestedDocumentAction[];
  translate: (key: TranslationKey) => string;
  onVorgangLinked: (item: InboxItem, vorgang: Vorgang) => void;
  onConfirmFiling: () => void;
  onImportArchive: () => void;
  onCreateTask: () => void;
  onOpenVorgangDialog: () => void;
  onItemUpdated: (item: InboxItem) => void;
  navigate: (route: string) => void;
  showToast: (message: string) => void;
}

export function DocumentActionSuggestionsPanel({
  item,
  classification: classificationProp,
  suggestedVorgang: suggestedVorgangProp,
  availableDocumentActions,
  translate,
  onVorgangLinked,
  onConfirmFiling,
  onImportArchive,
  onCreateTask,
  onOpenVorgangDialog,
  onItemUpdated,
  navigate,
  showToast,
}: Props) {
  const [showAllActions, setShowAllActions] = useState(false);
  const classification = classificationProp ?? getClassificationForItem(item);
  const suggestedVorgang = suggestedVorgangProp ?? getSuggestedVorgangForItem(item);
  const availableActions = availableDocumentActions;
  const primaryActions = availableActions.slice(0, MAX_PRIMARY_ACTIONS);
  const secondaryActions = availableActions.slice(MAX_PRIMARY_ACTIONS);
  const visibleActions = showAllActions ? availableActions : primaryActions;

  const actionContext: ApplyOfficeActionContext = {
    navigate,
    translate,
    showToast,
    onItemUpdated,
    delegates: {
      confirmFiling: onConfirmFiling,
      importArchive: onImportArchive,
      createTask: onCreateTask,
      openVorgangDialog: onOpenVorgangDialog,
    },
  };

  const handleLinkSuggestedVorgang = () => {
    if (!suggestedVorgang) return;
    const result = linkInboxToExistingVorgang(item, suggestedVorgang.vorgangId);
    if (result) {
      onVorgangLinked(result.inbox, result.vorgang);
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
      } else {
        showToast(translate('vorgang.link.success'));
      }
    }
  };

  const handleAction = (actionId: DocumentActionId) => {
    if (!isDocumentActionAvailable(actionId, item, classification.classifiedKind)) return;
    const result = executeDocumentAction(actionId, item, {
      classifiedKind: classification.classifiedKind,
    });
    applyOfficeActionResult(result, actionContext);
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

      {visibleActions.length > 0 && (
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
      )}
    </>
  );
}
