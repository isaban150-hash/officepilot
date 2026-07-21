import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupExportPanel } from './BackupExportPanel';

const exportMock = vi.fn();
const validateMock = vi.fn();
const restoreMock = vi.fn();

vi.mock('../../services/backupExportService', () => ({
  exportLocalBackupBundle: (...args: unknown[]) => exportMock(...args),
}));

vi.mock('../../services/backupValidateService', () => ({
  validateLocalBackupFile: (...args: unknown[]) => validateMock(...args),
}));

vi.mock('../../services/backupRestoreService', () => ({
  restoreLocalBackupBundle: (...args: unknown[]) => restoreMock(...args),
  backupRestorePhaseMessageKey: (phase: string) => {
    if (phase === 'safety_backup') return 'backup.restore.phase.safety';
    if (phase === 'rollback') return 'backup.restore.phase.rollback';
    return 'backup.restore.phase.stage';
  },
}));

vi.mock('../../context/AppContext', () => ({
  useApp: () => ({
    translate: (key: string) => key,
  }),
}));

function validBundle() {
  return {
    ok: true as const,
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
    manifest: {
      schemaVersion: 1,
      exportedAt: '',
      recordCounts: {},
      fileCount: 1,
      totalFileBytes: 128,
      files: [],
    },
    zipBytes: new Uint8Array([1]),
    appState: { version: 5, inboxItems: [], vorgaenge: [], tasks: [], setup: {} },
  };
}

describe('BackupExportPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    exportMock.mockReset();
    validateMock.mockReset();
    restoreMock.mockReset();
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
  });

  it('shows preview after file choose; restore disabled without confirmation', async () => {
    validateMock.mockResolvedValue(validBundle());

    act(() => {
      root.render(<BackupExportPanel />);
    });

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
    expect(container.querySelector('[data-testid="backup-validate-restore-unavailable"]')).toBeNull();

    const restoreBtn = container.querySelector(
      '[data-testid="backup-restore-action"]',
    ) as HTMLButtonElement;
    expect(restoreBtn.disabled).toBe(true);
    expect(restoreMock).not.toHaveBeenCalled();
  });

  it('starts restore only after checkbox confirmation', async () => {
    validateMock.mockResolvedValue(validBundle());
    restoreMock.mockResolvedValue({ ok: true, reloaded: true });

    act(() => {
      root.render(<BackupExportPanel />);
    });

    const input = container.querySelector(
      '[data-testid="backup-validate-file-input"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: [new File([new Uint8Array([1])], 'backup.zip', { type: 'application/zip' })],
        configurable: true,
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const checkbox = container.querySelector(
      '[data-testid="backup-restore-confirm"]',
    ) as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });

    const restoreBtn = container.querySelector(
      '[data-testid="backup-restore-action"]',
    ) as HTMLButtonElement;
    expect(restoreBtn.disabled).toBe(false);

    await act(async () => {
      restoreBtn.click();
    });

    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(restoreMock.mock.calls[0]![0].confirmed).toBe(true);
  });

  it('shows safe restore error without sensitive details', async () => {
    validateMock.mockResolvedValue(validBundle());
    restoreMock.mockResolvedValue({
      ok: false,
      reason: 'stage_failed',
      errorKey: 'backup.restore.error.stage',
    });

    act(() => {
      root.render(<BackupExportPanel />);
    });

    const input = container.querySelector(
      '[data-testid="backup-validate-file-input"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: [new File([new Uint8Array([1])], 'bad.zip', { type: 'application/zip' })],
        configurable: true,
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const checkbox = container.querySelector(
      '[data-testid="backup-restore-confirm"]',
    ) as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="backup-restore-action"]') as HTMLButtonElement).click();
    });

    const errorEl = container.querySelector('[data-testid="backup-restore-error"]');
    expect(errorEl?.textContent).toBe('backup.restore.error.stage');
    expect(errorEl?.textContent).not.toMatch(/bad\.zip|blob:|indexeddb/i);
  });
});
