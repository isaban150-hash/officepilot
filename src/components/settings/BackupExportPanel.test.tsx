import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupExportPanel } from './BackupExportPanel';

const exportMock = vi.fn();

vi.mock('../../services/backupExportService', () => ({
  exportLocalBackupBundle: (...args: unknown[]) => exportMock(...args),
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
});
