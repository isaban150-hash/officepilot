import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { exportLocalBackupBundle } from '../../services/backupExportService';
import type { TranslationKey } from '../../i18n';

type BackupUiStatus = 'idle' | 'loading' | 'success' | 'error';

export function BackupExportPanel() {
  const { translate } = useApp();
  const [status, setStatus] = useState<BackupUiStatus>('idle');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const handleDownload = async () => {
    if (status === 'loading') return;
    setStatus('loading');
    setErrorKey(null);

    try {
      const result = await exportLocalBackupBundle();
      if (!result.ok) {
        const key = (result.errorKey as TranslationKey) || 'backup.error.failed';
        setErrorKey(key);
        setStatus('error');
        return;
      }
      setStatus('success');
    } catch {
      setErrorKey('backup.error.failed');
      setStatus('error');
    }
  };

  return (
    <Card className="backup-export-panel" data-testid="backup-export-panel">
      <CardTitle>{translate('backup.title')}</CardTitle>
      <p className="backup-export-panel__hint hint-text">{translate('backup.hint')}</p>
      <Button
        type="button"
        fullWidth
        disabled={status === 'loading'}
        onClick={() => {
          void handleDownload();
        }}
        data-testid="backup-export-download"
      >
        {status === 'loading' ? translate('backup.loading') : translate('backup.download')}
      </Button>
      {status === 'success' && (
        <p className="backup-export-panel__success" data-testid="backup-export-success" role="status">
          {translate('backup.success')}
        </p>
      )}
      {status === 'error' && errorKey && (
        <p className="backup-export-panel__error form-error" data-testid="backup-export-error" role="alert">
          {translate(errorKey)}
        </p>
      )}
    </Card>
  );
}
