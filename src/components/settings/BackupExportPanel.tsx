import { useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
import { Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { exportLocalBackupBundle } from '../../services/backupExportService';
import { previewLocalBackupAreaCounts } from '../../services/backupAreaPreview';
import { validateLocalBackupFile } from '../../services/backupValidateService';
import {
  backupRestorePhaseMessageKey,
  isCloudWorkspaceScopeActive,
  restoreLocalBackupBundle,
} from '../../services/backupRestoreService';
import { BACKUP_SECTION_ID } from '../../services/backupSectionNavigation';
import { resolveWorkspaceDataExportAccess } from '../../services/workspace/workspaceRoleService';
import { useWorkspaceWriteAccess } from '../../hooks/useWorkspaceWriteAccess';
import type { BackupValidationPreview, ValidatedBackupBundle } from '../../types/backupValidate';
import {
  BACKUP_AREA_KEYS,
  type BackupAreaCounts,
  type BackupAreaKey,
  type BackupMissingFileEntry,
} from '../../types/backupExport';
import type { BackupRestorePhase } from '../../types/backupRestore';
import { buildPersistedStateSnapshot } from '../../services/persistenceService';
import { getActiveStorageAccount } from '../../services/storage/storageScopeService';
import { deviceDataFingerprint, recordDeviceBackup } from '../../services/storage/deviceDataService';
import { getWorkspaceStoreSnapshot } from '../../services/workspace/workspaceStore';
import type { TranslationKey } from '../../i18n';

/** EINRICHTUNG-01 (S-13) — `missing`: Dateien fehlen, Zustimmung zur Teilsicherung steht aus. */
type ExportUiStatus = 'idle' | 'loading' | 'success' | 'missing' | 'error';
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

function MissingFileList({ files, translate, testId }: {
  files: BackupMissingFileEntry[];
  translate: (key: TranslationKey) => string;
  testId: string;
}) {
  return (
    <ul className="backup-export-panel__missing-list" data-testid={testId}>
      {files.map((file) => (
        <li key={file.fileRefId}>{file.originalFileName?.trim() || translate('backup.missing.unnamed')}</li>
      ))}
    </ul>
  );
}

/** EINRICHTUNG-01 (AP7; 1.23) — Bereichsnamen in der Reihenfolge der Liste 1.23. */
const AREA_LABEL: Record<BackupAreaKey, TranslationKey> = {
  customers: 'backup.area.customers',
  vorgaenge: 'backup.area.vorgaenge',
  offers: 'backup.area.offers',
  invoices: 'backup.area.invoices',
  payments: 'backup.area.payments',
  expenses: 'backup.area.expenses',
  documents: 'backup.area.documents',
  files: 'backup.area.files',
  letters: 'backup.area.letters',
  emails: 'backup.area.emails',
  tasks: 'backup.area.tasks',
  knowledge: 'backup.area.knowledge',
  bankTransactions: 'backup.area.bankTransactions',
  employees: 'backup.area.employees',
  employeePayments: 'backup.area.employeePayments',
  accountingAssignments: 'backup.area.accountingAssignments',
  settings: 'backup.area.settings',
};

function AreaCountList({ counts, translate, testId }: {
  counts: BackupAreaCounts;
  translate: (key: TranslationKey) => string;
  testId: string;
}) {
  return (
    <dl className="backup-export-panel__preview-list backup-export-panel__counts" data-testid={testId}>
      {BACKUP_AREA_KEYS.map((key) => (
        <div key={key}>
          <dt>{translate(AREA_LABEL[key])}</dt>
          <dd data-testid={`${testId}-${key}`}>{counts[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

export function BackupExportPanel() {
  const { translate } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // EINRICHTUNG-01 (E9; Z-05.10, Z-06.5) — Sicherung nur für Inhaber und Admins bzw. im lokalen Betrieb.
  const exportAllowed = resolveWorkspaceDataExportAccess(useWorkspaceWriteAccess());
  // S-10.3 — im Cloud-Betrieb keine Wiederherstellung über die lokale Sicherung.
  const cloudScope = isCloudWorkspaceScopeActive();
  // 1.23 — vor dem Download: Zählung je Bereich aus demselben Bestand und mit derselben Funktion wie das Manifest.
  const [countsRevision, setCountsRevision] = useState(0);
  const areaCounts = useMemo(() => {
    void countsRevision; // nach jedem Lauf neu zählen
    return exportAllowed ? previewLocalBackupAreaCounts() : null;
  }, [exportAllowed, countsRevision]);

  const [exportStatus, setExportStatus] = useState<ExportUiStatus>('idle');
  const [exportErrorKey, setExportErrorKey] = useState<TranslationKey | null>(null);
  const [missingFiles, setMissingFiles] = useState<BackupMissingFileEntry[]>([]);
  const [exportPartial, setExportPartial] = useState(false);
  const [confirmIncomplete, setConfirmIncomplete] = useState(false);

  const [validateStatus, setValidateStatus] = useState<ValidateUiStatus>('idle');
  const [validateErrorKey, setValidateErrorKey] = useState<TranslationKey | null>(null);
  const [preview, setPreview] = useState<BackupValidationPreview | null>(null);
  const [validatedBundle, setValidatedBundle] = useState<ValidatedBackupBundle | null>(null);

  const [confirmReplace, setConfirmReplace] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<RestoreUiStatus>('idle');
  const [restoreErrorKey, setRestoreErrorKey] = useState<TranslationKey | null>(null);
  const [restorePhaseKey, setRestorePhaseKey] = useState<TranslationKey | null>(null);
  // EINRICHTUNG-01 (AP8; 1.28) — die lokale Wiederherstellung startet erst nach der Rückfrage.
  const [restoreAsk, setRestoreAsk] = useState(false);

  const handleDownload = async (allowMissingFiles = false) => {
    if (!exportAllowed || exportStatus === 'loading' || restoreStatus === 'running') return;
    setExportStatus('loading');
    setExportErrorKey(null);
    setExportPartial(false);

    try {
      const result = await exportLocalBackupBundle(new Date(), { allowMissingFiles });
      if (!result.ok) {
        // S-13.1 — ohne Zustimmung keine Teilsicherung: fehlende Dateien nennen und fragen.
        if (result.reason === 'missing_blob' && result.missingFiles && result.missingFiles.length > 0) {
          setMissingFiles(result.missingFiles);
          setExportStatus('missing');
          return;
        }
        const key = (result.errorKey as TranslationKey) || 'backup.error.failed';
        setExportErrorKey(key);
        setExportStatus('error');
        return;
      }
      setMissingFiles(result.manifest.missingFiles ?? []);
      setExportPartial(result.incomplete === true);
      setExportStatus('success');
      // EINRICHTUNG-01 (AP8; 1.29) — Hinweis für „Daten auf diesem Gerät“: nur in dieser Sitzung, nur für Konto und
      // Betrieb dieser Sicherung. Seit Abschluss 22 (E-13) nur zur Anzeige — eine Sicherung schaltet das Entfernen nie frei.
      const konto = getActiveStorageAccount()?.userId;
      const betrieb = getWorkspaceStoreSnapshot()?.id;
      if (cloudScope && konto && betrieb) {
        recordDeviceBackup({
          userId: konto,
          workspaceId: betrieb,
          fileName: result.filename,
          createdAt: new Date().toISOString(),
          complete: result.incomplete !== true && (result.manifest.missingFiles ?? []).length === 0,
          fingerprint: deviceDataFingerprint(buildPersistedStateSnapshot()),
        });
      }
    } catch {
      setExportErrorKey('backup.error.failed');
      setExportStatus('error');
    } finally {
      setCountsRevision((value) => value + 1);
    }
  };

  // S-13.4 — Abbrechen: keine Datei, Bestand unverändert.
  const handleCancelPartial = () => {
    setMissingFiles([]);
    setExportStatus('idle');
  };

  const handleFileChosen = async (file: File | undefined) => {
    if (!file || restoreStatus === 'running') return;
    setValidateStatus('checking');
    setValidateErrorKey(null);
    setPreview(null);
    setValidatedBundle(null);
    setConfirmReplace(false);
    setConfirmIncomplete(false);
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
    if (cloudScope || !validatedBundle || !confirmReplace || restoreStatus === 'running') return;
    // S-13.3 — eine Teilsicherung braucht die ausdrückliche Bestätigung der Lücke.
    if (preview?.incomplete && !confirmIncomplete) return;
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
    !cloudScope &&
    validateStatus === 'preview' &&
    Boolean(validatedBundle) &&
    confirmReplace &&
    (!preview?.incomplete || confirmIncomplete) &&
    restoreStatus !== 'running';

  return (
    <section
      id={BACKUP_SECTION_ID}
      tabIndex={-1}
      className="backup-section"
      data-testid="backup-section"
      aria-labelledby="backup-section-title"
    >
      <Card className="backup-export-panel" data-testid="backup-export-panel">
        <CardTitle>
          <span id="backup-section-title">{translate('backup.title')}</span>
        </CardTitle>
        <p className="backup-export-panel__hint hint-text">{translate('backup.hint')}</p>
        {areaCounts ? (
          <div className="backup-export-panel__preview" data-testid="backup-export-counts-section">
            <p className="backup-export-panel__preview-title">{translate('backup.counts.title')}</p>
            <AreaCountList counts={areaCounts} translate={translate} testId="backup-export-counts" />
            <p className="hint-text">{translate('backup.counts.emailsHint')}</p>
          </div>
        ) : null}
        {!exportAllowed ? (
          <p className="hint-text" data-testid="backup-export-not-allowed" role="note">
            {translate('backup.export.notAllowed')}
          </p>
        ) : (
          <Button
            type="button"
            fullWidth
            disabled={exportStatus === 'loading' || exportStatus === 'missing' || restoreStatus === 'running'}
            onClick={() => {
              void handleDownload();
            }}
            data-testid="backup-export-download"
          >
            {exportStatus === 'loading' ? translate('backup.loading') : translate('backup.download')}
          </Button>
        )}
      {exportStatus === 'missing' && (
        <div className="backup-export-panel__missing" data-testid="backup-export-missing" role="alert">
          <p className="form-error">{translate('backup.error.missingFile')}</p>
          <MissingFileList files={missingFiles} translate={translate} testId="backup-export-missing-list" />
          <p className="hint-text">{translate('backup.missing.hint')}</p>
          <div className="backup-export-panel__missing-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void handleDownload(true);
              }}
              data-testid="backup-export-allow-partial"
            >
              {translate('backup.missing.allowPartial')}
            </Button>
            <Button type="button" variant="secondary" onClick={handleCancelPartial} data-testid="backup-export-cancel-partial">
              {translate('backup.missing.cancel')}
            </Button>
          </div>
        </div>
      )}
      {exportStatus === 'success' && (
        <div className="backup-export-panel__success" data-testid="backup-export-success" role="status">
          <p>{translate(exportPartial ? 'backup.successPartial' : 'backup.success')}</p>
          {exportPartial && (
            <MissingFileList files={missingFiles} translate={translate} testId="backup-export-partial-list" />
          )}
        </div>
      )}
      {exportStatus === 'error' && exportErrorKey && (
        <p className="backup-export-panel__error form-error" data-testid="backup-export-error" role="alert">
          {translate(exportErrorKey)}
        </p>
      )}

      {cloudScope ? (
        <p className="hint-text" data-testid="backup-restore-cloud-blocked" role="note">
          {translate('backup.restore.cloudBlocked')}
        </p>
      ) : (
      <div className="backup-export-panel__validate" data-testid="backup-validate-section">
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          className="backup-export-panel__file-input"
          // EINRICHTUNG-01 (AP9; 1.32) — beschriftet; bedient wird sie über den sichtbaren Knopf (kein zweiter Tab-Halt).
          aria-label={translate('backup.validate.chooseFile')}
          tabIndex={-1}
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
            {preview.areaCounts ? (
              <>
                <p className="backup-export-panel__preview-title">{translate('backup.validate.contentTitle')}</p>
                <AreaCountList counts={preview.areaCounts} translate={translate} testId="backup-preview-counts" />
              </>
            ) : null}
            <p className="backup-export-panel__replace-hint hint-text" data-testid="backup-validate-replace-hint">
              {translate('backup.validate.replaceHint')}
            </p>

            {preview.incomplete && (
              <div className="backup-export-panel__incomplete" data-testid="backup-validate-incomplete" role="alert">
                <p className="form-error">{translate('backup.validate.incomplete')}</p>
                <MissingFileList
                  files={preview.missingFiles ?? []}
                  translate={translate}
                  testId="backup-validate-missing-list"
                />
                <label className="backup-export-panel__confirm checkbox-row" data-testid="backup-restore-confirm-incomplete-label">
                  <input
                    type="checkbox"
                    checked={confirmIncomplete}
                    disabled={restoreStatus === 'running'}
                    onChange={(e) => setConfirmIncomplete(e.target.checked)}
                    data-testid="backup-restore-confirm-incomplete"
                  />
                  {translate('backup.restore.confirmIncomplete')}
                </label>
              </div>
            )}

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
              onClick={() => setRestoreAsk(true)}
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
      )}
      <SimpleConfirmDialog
        open={restoreAsk}
        title={translate('confirm.restore.title')}
        message={translate('confirm.restore.text')}
        confirmLabel={translate('confirm.restore.action')}
        cancelLabel={translate('common.cancel')}
        confirmTestId="backup-restore-dialog-confirm"
        cancelTestId="backup-restore-dialog-cancel"
        dialogTestId="backup-restore-dialog"
        onConfirm={() => {
          setRestoreAsk(false);
          void handleRestore();
          return true;
        }}
        onCancel={() => setRestoreAsk(false)}
      />
    </Card>
    </section>
  );
}
