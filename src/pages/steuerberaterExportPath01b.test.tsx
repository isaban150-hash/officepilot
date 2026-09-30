/**
 * P0/P1-INTEGRITAET 01B / P3 — die Übergabe an den Steuerberater hat genau
 * einen Weg, und der führt durch das 06C-Gate.
 *
 * Der frühere Monatsmappen-Export im Seitenkopf lief am Monatsabschluss
 * vorbei. Geprüft wird: Ohne gültige Freigabe gibt es keinen Exportknopf,
 * 06C-Blocker verhindern den Export auch beim direkten Aufruf, eine gültige
 * Freigabe führt genau über `exportAccountingPackage`, und die Rollenprüfung
 * greift weiter.
 *
 * Neutrale Beispieldaten, kein Netzwerk, kein Download.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { TestProviders } from '../test/testProviders';
import { DEFAULT_SETUP } from '../data/mockData';
import { SteuerberaterPage } from './SteuerberaterPage';
import * as exportRunner from '../services/accounting/accountingExportRunner';
import * as monatsmappeExport from '../services/steuerberater/monatsmappeExportService';
import * as workspaceRoles from '../services/workspace/workspaceRoleService';
import { setAccountingStoreForTests } from '../services/accounting/accountingStore';
import { setAccountingPeriodStoreForTests } from '../services/accounting/accountingPeriodStore';
import { closeAccountingPeriod } from '../services/accounting/accountingPeriodService';
import { setExpenseStoreForTests } from '../services/expenseStore';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import { normalizeExpense } from '../services/expenseNormalize';
import { resetTestStores } from '../test/resetStores';
import type { AccountingAssignment } from '../types/accounting';
import type { Expense } from '../types/expense';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const monthKey = () => new Date().toISOString().slice(0, 7);

function ausgabe(): Expense {
  return normalizeExpense({
    id: 'exp-01b',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Beispiel Lieferant GmbH',
    invoiceNumber: 'RE-01B',
    title: 'P3',
    issueDate: new Date().toISOString().slice(0, 10),
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
  } as Expense);
}

function kontierung(): AccountingAssignment {
  return {
    id: 'k-01b',
    sourceType: 'expense',
    sourceId: 'exp-01b',
    chartOfAccounts: 'SKR03',
    accountNumber: '4930',
    accountLabel: 'Bürobedarf',
    taxTreatment: 'standard_19',
    bookingText: 'Beispiel Lieferant GmbH · RE-01B',
    status: 'confirmed',
    origin: 'manual',
    confirmedAt: '2026-09-24T10:00:00.000Z',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetTestStores();
  setExpenseStoreForTests([ausgabe()]);
  setAccountingStoreForTests([kontierung()]);
  setAccountingPeriodStoreForTests([]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-0000000d0001',
      settings: { chartOfAccounts: 'SKR03' },
      version: 1,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  resetTestStores();
});

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function zeigeSeite(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/steuerberater']}>
        <AuthProvider>
          <TestProviders initialSetup={completeSetup}>
            <SteuerberaterPage />
          </TestProviders>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
}

/** Dieselbe Berechtigungswahrheit, die Seite und Exportweg verwenden. */
function berechtigt(canWrite: boolean): void {
  vi.spyOn(workspaceRoles, 'resolveWorkspaceWriteAccess').mockReturnValue(
    canWrite
      ? { canWrite: true, canIntake: true, role: 'owner', reason: 'owner_or_admin' }
      : { canWrite: false, canIntake: true, role: 'member', reason: 'member' },
  );
}

async function monatsmappeVorbereiten(): Promise<void> {
  await act(async () => {
    q('steuerberater-prepare-folder')!.click();
  });
  expect(q('steuerberater-documents')).not.toBeNull();
}

describe('P3 — nur ein Exportweg, und der geht durch 06C', () => {
  it('der frühere Monatsmappen-Export existiert nicht mehr (02B-FINAL)', () => {
    expect('exportMonatsmappe' in monatsmappeExport).toBe(false);
  });

  it('ohne gültige Freigabe: kein Exportknopf — weder alt noch 06C', async () => {
    berechtigt(true);
    await zeigeSeite();
    expect(q('steuerberater-export-button')).toBeNull();
    await monatsmappeVorbereiten();
    expect(q('steuerberater-export-button'), 'der alte Export ist zurück').toBeNull();
    expect(q('accounting-export-package')).toBeNull();
    expect(q('accounting-export-blocker-not_closed')).not.toBeNull();
  });

  it('06C-Blocker verhindern den Export auch beim direkten Aufruf', async () => {
    const download = vi.fn();
    const ohneAbschluss = await exportRunner.exportAccountingPackage({ monthKey: monthKey(), userId: undefined, skipGate: true, download });
    expect(ohneAbschluss.outcome).toBe('blocked');

    // Abschluss, danach ändert sich der Stand → „seit Abschluss geändert".
    expect(closeAccountingPeriod(monthKey()).success).toBe(true);
    setAccountingStoreForTests([{ ...kontierung(), accountNumber: '4940' }]);
    const geaendert = await exportRunner.exportAccountingPackage({ monthKey: monthKey(), userId: undefined, skipGate: true, download });
    expect(geaendert.outcome).toBe('blocked');
    if (geaendert.outcome === 'blocked') {
      expect(geaendert.readiness.packageBlockers.map((item) => item.code)).toContain('changed_after_close');
    }
    expect(download).not.toHaveBeenCalled();
  });

  it('gültige Freigabe: genau der 06C-Weg; der Dateiname bleibt nach dem Export sichtbar', async () => {
    expect(closeAccountingPeriod(monthKey()).success).toBe(true);
    berechtigt(true);
    const neu = vi
      .spyOn(exportRunner, 'exportAccountingPackage')
      .mockResolvedValue({ outcome: 'exported', fileName: 'paket.zip', documentCount: 1, manifest: {} });

    await zeigeSeite();
    await monatsmappeVorbereiten();
    expect(q('steuerberater-export-button')).toBeNull();
    const paket = q('accounting-export-package');
    expect(paket, 'die 06C-Aktion fehlt').not.toBeNull();

    await act(async () => {
      paket!.click();
    });
    expect(neu).toHaveBeenCalledTimes(1);
    expect(neu.mock.calls[0][0]).toMatchObject({ monthKey: monthKey() });
    // 02B-FINAL — das Panel wird nach dem Export neu aufgebaut; der Dateiname bleibt.
    expect(q('accounting-export-created')?.textContent).toBe('paket.zip');
    expect(q('accounting-export-failed')).toBeNull();

    // Ein weiterer Export bleibt möglich und zeigt seinen eigenen Namen.
    neu.mockResolvedValueOnce({ outcome: 'exported', fileName: 'paket-2.zip', documentCount: 1, manifest: {} });
    await act(async () => {
      q('accounting-export-package')!.click();
    });
    expect(neu).toHaveBeenCalledTimes(2);
    expect(q('accounting-export-created')?.textContent).toBe('paket-2.zip');
  });

  it('fehlgeschlagener Export: der Fehlerhinweis bleibt nach dem Neuaufbau sichtbar, kein Dateiname', async () => {
    expect(closeAccountingPeriod(monthKey()).success).toBe(true);
    berechtigt(true);
    vi.spyOn(exportRunner, 'exportAccountingPackage').mockResolvedValue({ outcome: 'export_failed', detail: 'test' });
    await zeigeSeite();
    await monatsmappeVorbereiten();
    await act(async () => {
      q('accounting-export-package')!.click();
    });
    expect(q('accounting-export-failed')).not.toBeNull();
    expect(q('accounting-export-created')).toBeNull();
    expect(q('accounting-export-package')).not.toBeNull();
  });

  it('Rollenprüfung: ohne Finanzrecht keine aktive Exportaktion, auch bei gültigem Abschluss', async () => {
    expect(closeAccountingPeriod(monthKey()).success).toBe(true);
    berechtigt(false);
    const neu = vi.spyOn(exportRunner, 'exportAccountingPackage');
    await zeigeSeite();
    await monatsmappeVorbereiten();
    expect(q('steuerberater-export-button')).toBeNull();
    expect(q('accounting-export-package')).toBeNull();
    expect(q('accounting-export-forbidden')).not.toBeNull();
    expect(q('steuerberater-export-forbidden')).not.toBeNull();
    expect(neu).not.toHaveBeenCalled();
  });

  it('Rollenprüfung im Exportweg selbst bleibt bestehen', async () => {
    expect(closeAccountingPeriod(monthKey()).success).toBe(true);
    vi.spyOn(monatsmappeExport, 'assertMonatsmappeAllowed').mockResolvedValue({
      allowed: false,
      detail: 'member',
    } as Awaited<ReturnType<typeof monatsmappeExport.assertMonatsmappeAllowed>>);
    const download = vi.fn();
    const result = await exportRunner.exportAccountingPackage({ monthKey: monthKey(), userId: undefined, download });
    expect(result.outcome).toBe('forbidden');
    expect(download).not.toHaveBeenCalled();
  });
});
