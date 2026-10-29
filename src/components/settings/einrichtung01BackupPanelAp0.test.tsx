/**
 * EINRICHTUNG-01 (AP0, E9; S-10.3, S-12.2, S-13.1–S-13.4; Exportrecht Z-05.10/Z-06.5 vorgezogen) —
 * die Oberfläche der Datensicherung.
 *
 * Die Dienste sind ersetzt; geprüft wird, was das Panel anbietet, meldet und erst nach
 * ausdrücklicher Zustimmung tut. Die Dienste selbst prüft `einrichtung01BackupAp0.test.ts`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupExportPanel } from './BackupExportPanel';
import type { WorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';

const exportMock = vi.fn();
const validateMock = vi.fn();
const restoreMock = vi.fn();
const cloudMock = vi.fn(() => false);
const accessMock = vi.fn(
  (): WorkspaceWriteAccess => ({ canWrite: true, canIntake: true, role: 'owner', reason: 'owner_or_admin' }),
);

vi.mock('../../services/backupExportService', () => ({
  exportLocalBackupBundle: (...args: unknown[]) => exportMock(...args),
}));
vi.mock('../../services/backupValidateService', () => ({
  validateLocalBackupFile: (...args: unknown[]) => validateMock(...args),
}));
vi.mock('../../services/backupRestoreService', () => ({
  restoreLocalBackupBundle: (...args: unknown[]) => restoreMock(...args),
  backupRestorePhaseMessageKey: () => 'backup.restore.phase.stage',
  isCloudWorkspaceScopeActive: () => cloudMock(),
}));
vi.mock('../../hooks/useWorkspaceWriteAccess', () => ({
  useWorkspaceWriteAccess: () => accessMock(),
}));
vi.mock('../../context/AppContext', () => ({
  useApp: () => ({ translate: (key: string) => key }),
}));

const FEHLEND = [
  { fileRefId: 'ref-1', originalFileName: 'Aufmass Bad.pdf' },
  { fileRefId: 'ref-2' },
];

function teilsicherung() {
  return {
    ok: true as const,
    preview: {
      exportedAt: '2026-10-01T07:00:00.000Z',
      schemaVersion: 1,
      recordCounts: { inboxItems: 0, vorgaenge: 1, tasks: 0, documents: 0, expenses: 0, uploadedDocuments: 0, documentFileRefs: 2, documentFileRepresentationBindings: 0, communicationHistory: 0, knowledgeFacts: 0, vorgangNotes: 0, dunningDocumentations: 0, mailImports: 0 },
      fileCount: 0,
      totalFileBytes: 0,
      incomplete: true as const,
      missingFiles: FEHLEND,
    },
    manifest: { schemaVersion: 1, exportedAt: '', recordCounts: {}, fileCount: 0, totalFileBytes: 0, files: [], incomplete: true, missingFiles: FEHLEND },
    zipBytes: new Uint8Array([1]),
    appState: { version: 5 },
  };
}

let container: HTMLDivElement;
let root: Root;

function q(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<BackupExportPanel />);
  });
}

async function click(id: string): Promise<void> {
  const el = q(id);
  expect(el, id).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function waehleDatei(): Promise<void> {
  const input = q('backup-validate-file-input') as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array([1])], 'teil.zip', { type: 'application/zip' })],
      configurable: true,
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  exportMock.mockReset();
  validateMock.mockReset();
  restoreMock.mockReset();
  cloudMock.mockReset();
  cloudMock.mockReturnValue(false);
  accessMock.mockReset();
  accessMock.mockReturnValue({ canWrite: true, canIntake: true, role: 'owner', reason: 'owner_or_admin' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('EINRICHTUNG-01 AP0 — Datensicherung in der Oberfläche', () => {
  it('S-12.2: nach dem Klick meldet das Panel „Download gestartet“ (backup.success)', async () => {
    exportMock.mockResolvedValue({ ok: true, filename: 'x.zip', blob: new Blob(), manifest: { files: [] }, incomplete: false, objectUrl: 'blob:x', revokeObjectUrl: () => {} });
    await render();
    expect(exportMock).not.toHaveBeenCalled();
    await click('backup-export-download');
    expect(exportMock).toHaveBeenCalledWith(expect.any(Date), { allowMissingFiles: false });
    expect(q('backup-export-success')?.textContent).toBe('backup.success');
  });

  it('S-13.1/S-13.4: fehlende Dateien werden genannt; Abbrechen erzeugt keine Datei', async () => {
    exportMock.mockResolvedValue({ ok: false, reason: 'missing_blob', errorKey: 'backup.error.missingFile', missingFiles: FEHLEND });
    await render();
    await click('backup-export-download');
    expect(q('backup-export-missing')).not.toBeNull();
    expect(q('backup-export-missing-list')?.textContent).toContain('Aufmass Bad.pdf');
    expect(q('backup-export-missing-list')?.textContent).toContain('backup.missing.unnamed');
    expect(q('backup-export-success')).toBeNull();
    expect((q('backup-export-download') as HTMLButtonElement).disabled).toBe(true);

    await click('backup-export-cancel-partial');
    expect(q('backup-export-missing')).toBeNull();
    expect(exportMock).toHaveBeenCalledTimes(1);
    expect((q('backup-export-download') as HTMLButtonElement).disabled).toBe(false);
  });

  it('S-13.2: erst mit Zustimmung entsteht eine Teilsicherung; die Meldung sagt „Teilsicherung“ und nennt die Lücke', async () => {
    exportMock
      .mockResolvedValueOnce({ ok: false, reason: 'missing_blob', errorKey: 'backup.error.missingFile', missingFiles: FEHLEND })
      .mockResolvedValueOnce({
        ok: true, filename: 'x.zip', blob: new Blob(), manifest: { files: [], incomplete: true, missingFiles: FEHLEND },
        incomplete: true, objectUrl: 'blob:x', revokeObjectUrl: () => {},
      });
    await render();
    await click('backup-export-download');
    await click('backup-export-allow-partial');
    expect(exportMock).toHaveBeenLastCalledWith(expect.any(Date), { allowMissingFiles: true });
    expect(q('backup-export-success')?.querySelector('p')?.textContent).toBe('backup.successPartial');
    expect(q('backup-export-partial-list')?.textContent).toContain('Aufmass Bad.pdf');
  });

  it('S-13.3: eine Teilsicherung zeigt die Lücke vor dem Ersetzen und braucht eine eigene Bestätigung', async () => {
    validateMock.mockResolvedValue(teilsicherung());
    restoreMock.mockResolvedValue({ ok: true, reloaded: true });
    await render();
    await waehleDatei();
    expect(q('backup-validate-incomplete')).not.toBeNull();
    expect(q('backup-validate-missing-list')?.textContent).toContain('Aufmass Bad.pdf');

    await click('backup-restore-confirm');
    expect((q('backup-restore-action') as HTMLButtonElement).disabled).toBe(true);
    await click('backup-restore-action');
    expect(restoreMock).not.toHaveBeenCalled();

    await click('backup-restore-confirm-incomplete');
    expect((q('backup-restore-action') as HTMLButtonElement).disabled).toBe(false);
    await click('backup-restore-action');
    // EINRICHTUNG-01 (AP8; 1.28) — die Wiederherstellung startet erst nach der Rückfrage.
    await click('backup-restore-dialog-confirm');
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });

  it('S-10.3: im Cloud-Betrieb gibt es keine Wiederherstellung, nur die Erklärung', async () => {
    cloudMock.mockReturnValue(true);
    await render();
    expect(q('backup-restore-cloud-blocked')?.textContent).toBe('backup.restore.cloudBlocked');
    expect(q('backup-validate-file-input')).toBeNull();
    expect(q('backup-restore-action')).toBeNull();
    expect(restoreMock).not.toHaveBeenCalled();
    // Die Sicherung selbst bleibt für Inhaber und Admins erreichbar.
    expect(q('backup-export-download')).not.toBeNull();
  });

  it('E9: Mitglieder und eine ungeklärte Rolle bekommen keine Sicherung angeboten; Admins schon', async () => {
    accessMock.mockReturnValue({ canWrite: false, canIntake: true, role: 'member', reason: 'member' });
    await render();
    expect(q('backup-export-download')).toBeNull();
    expect(q('backup-export-not-allowed')?.textContent).toBe('backup.export.notAllowed');
    act(() => root.unmount());

    root = createRoot(container);
    accessMock.mockReturnValue({ canWrite: false, canIntake: false, role: null, reason: 'membership_unknown' });
    await render();
    expect(q('backup-export-download')).toBeNull();
    act(() => root.unmount());

    root = createRoot(container);
    accessMock.mockReturnValue({ canWrite: true, canIntake: true, role: 'admin', reason: 'owner_or_admin' });
    await render();
    expect(q('backup-export-download')).not.toBeNull();
    act(() => root.unmount());

    root = createRoot(container);
    accessMock.mockReturnValue({ canWrite: true, canIntake: true, role: null, reason: 'local_only' });
    await render();
    expect(q('backup-export-download')).not.toBeNull();
  });
});
