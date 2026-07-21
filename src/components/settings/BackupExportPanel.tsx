import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { exportLocalBackupBundle } from '../../services/backupExportService';
import { validateLocalBackupFile } from '../../services/backupValidateService';
import {
  backupRestorePhaseMessageKey,
  restoreLocalBackupBundle,
} from '../../services/backupRestoreService';
import type { BackupValidationPreview, ValidatedBackupBundle } from '../../types/backupValidate';
import type { BackupRestorePhase } from '../../types/backupRestore';
import type { TranslationKey } from '../../i18n';

type ExportUiStatus = 'idle' | 'loading' | 'success' | 'error';
type ValidateUiStatus = 'idle' | 'checking' | 'preview' | 'error';
type RestoreUiStatus = 'idle' | 'running' | 'success' | 'error';

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sumRecordCounts(counts: BackupValidationPreview['recordCounts']): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function formatExportedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function BackupExportPanel() {
  const { translate } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [exportStatus, setExportStatus] = useState<ExportUiStatus>('idle');
  const [exportErrorKey, setExportErrorKey] = useState<TranslationKey | null>(null);

  const [validateStatus, setValidateStatus] = useState<ValidateUiStatus>('idle');
  const [validateErrorKey, setValidateErrorKey] = useState<TranslationKey | null>(null);
  const [preview, setPreview] = useState<BackupValidationPreview | null>(null);
  const [validatedBundle, setValidatedBundle] = useState<ValidatedBackupBundle | null>(null);

  const [confirmReplace, setConfirmReplace] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<RestoreUiStatus>('idle');
  const [restoreErrorKey, setRestoreErrorKey] = useState<TranslationKey | null>(null);
  const [restorePhaseKey, setRestorePhaseKey] = useState<TranslationKey | null>(null);

  const handleDownload = async () => {
    if (exportStatus === 'loading' || restoreStatus === 'running') return;
    setExportStatus('loading');
    setExportErrorKey(null);

    try {
      const result = await exportLocalBackupBundle();
      if (!result.ok) {
        const key = (result.errorKey as TranslationKey) || 'backup.error.failed';
        setExportErrorKey(key);
        setExportStatus('error');
        return;
      }
      setExportStatus('success');
    } catch {
      setExportErrorKey('backup.error.failed');
      setExportStatus('error');
    }
  };

  const handleFileChosen = async (file: File | undefined) => {
    if (!file || restoreStatus === 'running') return;
    setValidateStatus('checking');
    setValidateErrorKey(null);
    setPreview(null);
    setValidatedBundle(null);
    setConfirmReplace(false);
    setRestoreStatus('idle');
    setRestoreErrorKey(null);
    setRestorePhaseKey(null);

    try {
      const result = await validateLocalBackupFile(file);
      if (!result.ok) {
        setValidateErrorKey(result.errorKey as TranslationKey);
        setValidateStatus('error');
        return;
      }
      setPreview(result.preview);
      setValidatedBundle(result);
      setValidateStatus('preview');
    } catch {
      setValidateErrorKey('backup.validate.error.invalid');
      setValidateStatus('error');
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRestore = async () => {
    if (!validatedBundle || !confirmReplace || restoreStatus === 'running') return;
    setRestoreStatus('running');
    setRestoreErrorKey(null);
    setRestorePhaseKey('backup.restore.phase.safety');

    try {
      const result = await restoreLocalBackupBundle(
        { validated: validatedBundle, confirmed: true, reload: true },
        {
          onPhase: (phase: BackupRestorePhase) => {
            const key = backupRestorePhaseMessageKey(phase);
            if (key) setRestorePhaseKey(key);
          },
        },
      );
      if (!result.ok) {
        setRestoreErrorKey(result.errorKey as TranslationKey);
        setRestoreStatus('error');
        setRestorePhaseKey(null);
        return;
      }
      setRestoreStatus('success');
      setRestorePhaseKey(null);
    } catch {
      setRestoreErrorKey('backup.restore.error.failed');
      setRestoreStatus('error');
      setRestorePhaseKey(null);
    }
  };

  const restoreEnabled =
    validateStatus === 'preview' &&
    Boolean(validatedBundle) &&
    confirmReplace &&
    restoreStatus !== 'running';

  return (
    <Card className="backup-export-panel" data-testid="backup-export-panel">
      <CardTitle>{translate('backup.title')}</CardTitle>
      <p className="backup-export-panel__hint hint-text">{translate('backup.hint')}</p>
      <Button
        type="button"
        fullWidth
        disabled={exportStatus === 'loading' || restoreStatus === 'running'}
        onClick={() => {
          void handleDownload();
        }}
        data-testid="backup-export-download"
      >
        {exportStatus === 'loading' ? translate('backup.loading') : translate('backup.download')}
      </Button>
      {exportStatus === 'success' && (
        <p className="backup-export-panel__success" data-testid="backup-export-success" role="status">
          {translate('backup.success')}
        </p>
      )}
      {exportStatus === 'error' && exportErrorKey && (
        <p className="backup-export-panel__error form-error" data-testid="backup-export-error" role="alert">
          {translate(exportErrorKey)}
        </p>
      )}

      <div className="backup-export-panel__validate" data-testid="backup-validate-section">
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          className="backup-export-panel__file-input"
          data-testid="backup-validate-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            void handleFileChosen(file);
          }}
        />
        <Button
          type="button"
          fullWidth
          disabled={validateStatus === 'checking' || restoreStatus === 'running'}
          onClick={() => fileInputRef.current?.click()}
          data-testid="backup-validate-choose"
        >
          {validateStatus === 'checking'
            ? translate('backup.validate.checking')
            : translate('backup.validate.chooseFile')}
        </Button>

        {validateStatus === 'checking' && (
          <p className="hint-text" data-testid="backup-validate-checking" role="status">
            {translate('backup.validate.checking')}
          </p>
        )}

        {validateStatus === 'preview' && preview && (
          <div className="backup-export-panel__preview" data-testid="backup-validate-preview">
            <p className="backup-export-panel__preview-title">{translate('backup.validate.previewTitle')}</p>
            <dl className="backup-export-panel__preview-list">
              <div>
                <dt>{translate('backup.validate.exportedAt')}</dt>
                <dd data-testid="backup-preview-exported-at">{formatExportedAt(preview.exportedAt)}</dd>
              </div>
              <div>
                <dt>{translate('backup.validate.schemaVersion')}</dt>
                <dd data-testid="backup-preview-schema">{preview.schemaVersion}</dd>
              </div>
              <div>
                <dt>{translate('backup.validate.recordCount')}</dt>
                <dd data-testid="backup-preview-records">{sumRecordCounts(preview.recordCounts)}</dd>
              </div>
              <div>
                <dt>{translate('backup.validate.fileCount')}</dt>
                <dd data-testid="backup-preview-files">{preview.fileCount}</dd>
              </div>
              <div>
                <dt>{translate('backup.validate.totalSize')}</dt>
                <dd data-testid="backup-preview-size">{formatByteSize(preview.totalFileBytes)}</dd>
              </div>
            </dl>
            <p className="backup-export-panel__replace-hint hint-text" data-testid="backup-validate-replace-hint">
              {translate('backup.validate.replaceHint')}
            </p>

            <label className="backup-export-panel__confirm checkbox-row" data-testid="backup-restore-confirm-label">
              <input
                type="checkbox"
                checked={confirmReplace}
                disabled={restoreStatus === 'running'}
                onChange={(e) => setConfirmReplace(e.target.checked)}
                data-testid="backup-restore-confirm"
              />
              {translate('backup.restore.confirm')}
            </label>

            <Button
              type="button"
              fullWidth
              disabled={!restoreEnabled}
              onClick={() => {
                void handleRestore();
              }}
              data-testid="backup-restore-action"
            >
              {translate('backup.restore.action')}
            </Button>

            {restoreStatus === 'running' && restorePhaseKey && (
              <p className="hint-text" data-testid="backup-restore-phase" role="status">
                {translate(restorePhaseKey)}
              </p>
            )}
            {restoreStatus === 'success' && (
              <p className="backup-export-panel__success" data-testid="backup-restore-success" role="status">
                {translate('backup.restore.success')}
              </p>
            )}
            {restoreStatus === 'error' && restoreErrorKey && (
              <p
                className="backup-export-panel__error form-error"
                data-testid="backup-restore-error"
                role="alert"
              >
                {translate(restoreErrorKey)}
              </p>
            )}
          </div>
        )}

        {validateStatus === 'error' && validateErrorKey && (
          <p
            className="backup-export-panel__error form-error"
            data-testid="backup-validate-error"
            role="alert"
          >
            {translate(validateErrorKey)}
          </p>
        )}
      </div>
    </Card>
  );
}
