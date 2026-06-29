import { Button } from '../ui/Button';
import { Badge, Card, CardMeta, CardTitle, DataRow } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import {
  confirmDispose,
  deferItem,
  getPriorityLabel,
  getStatusLabel,
  saveAdvertisementAnyway,
} from '../../services/inboxService';
import { confirmFiling } from '../../services/inboxTaskService';
import { formatPaperFilingInstruction } from '../../services/paperFolderService';
import type { InboxItem } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface InboxCardProps {
  item: InboxItem;
  onReview: (id: string) => void;
  onUpdated: () => void;
}

const PRIORITY_TONE: Record<string, 'default' | 'info' | 'warning' | 'success'> = {
  kritisch: 'warning',
  hoch: 'warning',
  mittel: 'info',
  niedrig: 'default',
};

export function InboxCard({ item, onReview, onUpdated }: InboxCardProps) {
  const { translate, showToast } = useApp();
  const docTypeKey = `docType.${item.documentType}` as TranslationKey;
  const actionKey = `action.${item.recommendedAction}` as TranslationKey;

  const handleFiling = () => {
    const result = confirmFiling(item.id);
    if (result) {
      const msg = result.taskCreated
        ? `${result.message} Aufgabe: ${result.taskCreated.title}`
        : result.message;
      showToast(msg);
      onUpdated();
    }
  };

  const handleDefer = () => {
    const result = deferItem(item.id);
    if (result) {
      showToast(result.message);
      onUpdated();
    }
  };

  const handleDispose = () => {
    const result = confirmDispose(item.id);
    if (result) {
      showToast(result.message);
      onUpdated();
    }
  };

  const handleSaveAnyway = () => {
    const result = saveAdvertisementAnyway(item.id);
    if (result) {
      showToast(result.message);
      onUpdated();
    }
  };

  return (
    <Card className={`inbox-card inbox-card--${item.priority}`}>
      <div className="inbox-card__header">
        <CardTitle>{item.title}</CardTitle>
        <div className="badge-row">
          {item.isNewUpload && (
            <Badge tone="info">{translate('inbox.justCaptured')}</Badge>
          )}
          {item.userModified && (
            <Badge tone="success">{translate('inbox.manuallyReviewed')}</Badge>
          )}
          {(item.vorgangLinkStatus === 'linked' || item.vorgangLinkStatus === 'created') && (
            <Badge tone="info">{translate('vorgang.linkedBadge')}</Badge>
          )}
          <Badge tone={PRIORITY_TONE[item.priority] ?? 'default'}>
            {getPriorityLabel(item.priority)}
          </Badge>
          <Badge tone={item.status === 'neu' ? 'info' : 'default'}>
            {getStatusLabel(item.status)}
          </Badge>
        </div>
      </div>

      <CardMeta>{item.sender}</CardMeta>

      <div className="inbox-card__meta">
        <DataRow label={translate('inbox.documentType')} value={translate(docTypeKey)} />
        <DataRow label={translate('inbox.recommendedAction')} value={translate(actionKey)} />
        {item.deadline && (
          <DataRow label={translate('analysis.deadline')} value={item.deadline} />
        )}
        <DataRow
          label={translate('analysis.digitalFolder')}
          value={item.digitalFolder.path}
        />
        <DataRow
          label={translate('analysis.paperFiling')}
          value={formatPaperFilingInstruction(item.paperFiling)}
        />
      </div>

      <div className="inbox-card__actions">
        <Button fullWidth onClick={() => onReview(item.id)}>
          {translate('inbox.reviewNow')}
        </Button>
        {!item.isAdvertisement && (
          <>
            <Button variant="outline" fullWidth onClick={handleFiling}>
              {translate('inbox.confirmFiling')}
            </Button>
            <Button variant="ghost" fullWidth onClick={handleDefer}>
              {translate('inbox.defer')}
            </Button>
          </>
        )}
        {item.isAdvertisement && (
          <>
            <Button variant="outline" fullWidth onClick={handleDispose}>
              {translate('inbox.confirmDispose')}
            </Button>
            <Button variant="ghost" fullWidth onClick={handleSaveAnyway}>
              {translate('inbox.saveAnyway')}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
