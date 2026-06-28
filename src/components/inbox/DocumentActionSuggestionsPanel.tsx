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
  const classification: DocumentClassificationResult = getClassificationForItem(item);
  const suggestedVorgang = getSuggestedVorgangForItem(item);

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
        onOpenVorgangDialog();
        break;
      case 'check_payment':
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

  return (
    <>
      <Card className="classification-explanation" highlight>
        <h3 className="section__title">{translate('classification.explanationTitle')}</h3>
        <p className="classification-explanation__kind">{translate(kindKey)}</p>
        <p>{classification.explanation}</p>
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
          {classification.actions.map((action: SuggestedDocumentAction) => (
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
      </Card>
    </>
  );
}
