import { useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import {
  previewDefinitelyMockCleanup,
  removeDefinitelyMockDataFromActiveScope,
} from '../../services/storage/storageBootstrapService';

export function DemoDataCleanupPanel() {
  const { translate, showToast } = useApp();
  const [confirmed, setConfirmed] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const preview = useMemo(() => previewDefinitelyMockCleanup(), [confirmed, isRemoving]);

  const hasMockData =
    preview.vorgaenge.length > 0 ||
    preview.inboxItems.length > 0 ||
    preview.taskIds.length > 0;

  const handleRemove = async () => {
    setIsRemoving(true);
    try {
      const result = removeDefinitelyMockDataFromActiveScope();
      if (!result.success) {
        showToast(translate('dataCleanup.failed'));
        return;
      }
      showToast(translate('dataCleanup.success'));
      setConfirmed(false);
      window.location.reload();
    } finally {
      setIsRemoving(false);
    }
  };

  if (!hasMockData) {
    return (
      <Card className="demo-cleanup-panel" data-testid="demo-data-cleanup-panel">
        <CardTitle>{translate('dataCleanup.title')}</CardTitle>
        <CardMeta>{translate('dataCleanup.noneFound')}</CardMeta>
      </Card>
    );
  }

  return (
    <Card className="demo-cleanup-panel" data-testid="demo-data-cleanup-panel">
      <CardTitle>{translate('dataCleanup.title')}</CardTitle>
      <CardMeta>{translate('dataCleanup.intro')}</CardMeta>

      {preview.vorgaenge.length > 0 && (
        <div className="demo-cleanup-panel__group" data-testid="demo-cleanup-vorgaenge">
          <strong>{translate('dataCleanup.vorgaenge')}</strong>
          <ul>
            {preview.vorgaenge.map((vorgang) => (
              <li key={vorgang.id}>
                {vorgang.title} ({vorgang.id})
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.inboxItems.length > 0 && (
        <div className="demo-cleanup-panel__group" data-testid="demo-cleanup-inbox">
          <strong>{translate('dataCleanup.inbox')}</strong>
          <ul>
            {preview.inboxItems.map((item) => (
              <li key={item.id}>
                {item.title} ({item.id})
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.taskIds.length > 0 && (
        <div className="demo-cleanup-panel__group" data-testid="demo-cleanup-tasks">
          <strong>{translate('dataCleanup.tasks')}</strong>
          <ul>
            {preview.taskIds.map((taskId) => (
              <li key={taskId}>{taskId}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="demo-cleanup-panel__confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          data-testid="demo-cleanup-confirm"
        />
        {translate('dataCleanup.confirmLabel')}
      </label>

      <Button
        variant="outline"
        fullWidth
        disabled={!confirmed || isRemoving}
        loading={isRemoving}
        onClick={() => void handleRemove()}
        data-testid="demo-cleanup-remove"
      >
        {translate('dataCleanup.remove')}
      </Button>
    </Card>
  );
}
