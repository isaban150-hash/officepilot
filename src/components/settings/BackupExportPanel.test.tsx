import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupExportPanel } from './BackupExportPanel';

const exportMock = vi.fn();
const validateMock = vi.fn();

vi.mock('../../services/backupExportService', () => ({
  exportLocalBackupBundle: (...args: unknown[]) => exportMock(...args),
}));

vi.mock('../../services/backupValidateService', () => ({
  validateLocalBackupFile: (...args: unknown[]) => validateMock(...args),
}));

vi.mock('../../context/AppContext', () => ({
  useApp: () => ({
    translate: (key: string) => key,
  }),
}));

describe('BackupExportPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    exportMock.mockReset();
    validateMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not export until the user clicks download', () => {
    act(() => {
      root.render(<BackupExportPanel />);
    });

    expect(exportMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="backup-export-download"]')).toBeTruthy();
    expect(container.textContent).toContain('backup.hint');
    expect(container.textContent).toContain('backup.title');
  });

  it('shows loading then success after explicit click', async () => {
    exportMock.mockResolvedValue({
      ok: true,
      filename: 'OfficePilot_Backup_2026-01-01_00-00.zip',
      blob: new Blob(),
      manifest: {
        schemaVersion: 1,
        exportedAt: '',
        recordCounts: {},
        fileCount: 0,
        totalFileBytes: 0,
        files: [],
      },
    });

    act(() => {
      root.render(<BackupExportPanel />);
    });

    const button = container.querySelector(
      '[data-testid="backup-export-download"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    expect(exportMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="backup-export-success"]')).toBeTruthy();
  });

  it('shows safe error message without sensitive details on failure', async () => {
    exportMock.mockResolvedValue({
      ok: false,
      reason: 'missing_blob',
      errorKey: 'backup.error.missingFile',
    });

    act(() => {
      root.render(<BackupExportPanel />);
    });

    const button = container.querySelector(
      '[data-testid="backup-export-download"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    const errorEl = container.querySelector('[data-testid="backup-export-error"]');
    expect(errorEl?.textContent).toBe('backup.error.missingFile');
    expect(errorEl?.textContent).not.toMatch(/blob:|indexeddb|password/i);
  });

  it('does not validate until a file is chosen; then shows preview', async () => {
    validateMock.mockResolvedValue({
      ok: true,
      preview: {
        exportedAt: '2026-01-15T08:30:00.000Z',
        schemaVersion: 1,
        recordCounts: {
          inboxItems: 1,
          vorgaenge: 2,
          tasks: 0,
          documents: 0,
          expenses: 0,
          uploadedDocuments: 0,
          documentFileRefs: 1,
          documentFileRepresentationBindings: 0,
          communicationHistory: 0,
          knowledgeFacts: 0,
          vorgangNotes: 0,
          dunningDocumentations: 0,
          mailImports: 0,
        },
        fileCount: 1,
        totalFileBytes: 128,
      },
      manifest: { schemaVersion: 1, exportedAt: '', recordCounts: {}, fileCount: 1, totalFileBytes: 128, files: [] },
    });

    act(() => {
      root.render(<BackupExportPanel />);
    });

    expect(validateMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="backup-validate-choose"]')).toBeTruthy();

    const input = container.querySelector(
      '[data-testid="backup-validate-file-input"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([1])], 'backup.zip', { type: 'application/zip' });
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="backup-validate-preview"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="backup-preview-schema"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="backup-preview-files"]')?.textContent).toBe('1');
    expect(container.textContent).toContain('backup.validate.replaceHint');
    expect(container.textContent).toContain('backup.validate.restoreUnavailable');
    expect(container.querySelector('[data-testid="backup-validate-restore"]')).toBeNull();
  });

  it('shows safe validate error without sensitive details', async () => {
    validateMock.mockResolvedValue({
      ok: false,
      reason: 'blob_mismatch',
      errorKey: 'backup.validate.error.blobs',
    });

    act(() => {
      root.render(<BackupExportPanel />);
    });

    const input = container.querySelector(
      '[data-testid="backup-validate-file-input"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([1])], 'bad.zip', { type: 'application/zip' });
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const errorEl = container.querySelector('[data-testid="backup-validate-error"]');
    expect(errorEl?.textContent).toBe('backup.validate.error.blobs');
    expect(errorEl?.textContent).not.toMatch(/bad\.zip|blob:|indexeddb/i);
  });
});
