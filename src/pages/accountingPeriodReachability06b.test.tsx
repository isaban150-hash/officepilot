/**
 * STEUERBERATER-06B — Erreichbarkeit des Monatsabschlusses in der Anwendung.
 *
 * **Das ist kein Browser-Smoke.** In der Sitzung, in der dieser Test entstand,
 * stand kein Browser- und kein Computer-Use-Werkzeug zur Verfügung. Geprüft
 * wird die Stufe darunter: Rendert die **echte Steuerberaterseite** den neuen
 * Abschlussbereich, und steht dort das, was ein Nutzer lesen soll?
 *
 * Das deckt die Lücke, die Komponententests offen lassen — dass der Bereich für
 * sich funktioniert, sagt noch nicht, dass er in der zusammengesetzten Seite
 * überhaupt erscheint.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { TestProviders } from '../test/testProviders';
import { DEFAULT_SETUP } from '../data/mockData';
import { SteuerberaterPage } from './SteuerberaterPage';
import { setExpenseStoreForTests } from '../services/expenseStore';
import { setAccountingStoreForTests } from '../services/accounting/accountingStore';
import { setAccountingPeriodStoreForTests } from '../services/accounting/accountingPeriodStore';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import { normalizeExpense } from '../services/expenseNormalize';
import { resetTestStores } from '../test/resetStores';
import type { Expense } from '../types/expense';
import type { AccountingAssignment } from '../types/accounting';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-06b',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-06B',
    title: '06B ERREICHBARKEIT',
    issueDate: new Date().toISOString().slice(0, 10),
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

function kontierung(overrides: Partial<AccountingAssignment> = {}): AccountingAssignment {
  return {
    id: 'k-06b',
    sourceType: 'expense',
    sourceId: 'exp-06b',
    chartOfAccounts: 'SKR03',
    accountNumber: '4930',
    accountLabel: 'Bürobedarf',
    taxTreatment: 'standard_19',
    bookingText: 'Baustoff Süd GmbH · RE-06B',
    status: 'confirmed',
    origin: 'manual',
    confirmedAt: '2026-09-24T10:00:00.000Z',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetTestStores();
  setExpenseStoreForTests([]);
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-0000000b0001',
      settings: { chartOfAccounts: 'SKR04' },
      version: 1,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<div />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetTestStores();
});

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const text = () => container.textContent ?? '';

/** Betritt die Seite neu — wie ein Nutzer, nicht als blosses Re-Render. */
async function zeigeSteuerberater(): Promise<void> {
  await act(async () => root.unmount());
  root = createRoot(container);
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

/* ================================================================== */

describe('06B — der Monatsabschluss ist in der Anwendung erreichbar', () => {
  it('S1: die Steuerberaterseite zeigt den Abschlussbereich', async () => {
    await zeigeSteuerberater();

    expect(q('steuerberater-period'), 'der Abschlussabschnitt fehlt').not.toBeNull();
    expect(q('accounting-period')).not.toBeNull();
    expect(text()).toContain('Monatsabschluss');
    expect(text()).toContain('Stand');
  });

  it('S2: ein nicht kontierter Beleg erscheint als Blocker, ohne Abschlussknopf', async () => {
    setExpenseStoreForTests([ausgabe()]);
    await zeigeSteuerberater();

    expect(q('accounting-period-blockers'), 'die Blocker fehlen').not.toBeNull();
    expect(text()).toContain('Belege ohne Kontierung: 1');
    expect(q('accounting-period-close'), 'kein Abschluss ohne Bereitschaft').toBeNull();
  });

  it('S3: ein vollständig kontierter Monat bietet den Abschluss an', async () => {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    await zeigeSteuerberater();

    expect(q('accounting-period-blockers')).toBeNull();
    expect(q('accounting-period-close'), 'der Abschlussknopf fehlt').not.toBeNull();
    expect(text()).toContain('Bereit zum Abschluss');
  });

  /*
   * S4 — die ganze Kette über die echte Seite: abschliessen, und danach zeigt
   * die Seite den Abschluss samt Revision und Verlauf.
   */
  it('S4: der Abschluss über die Seite wird danach dort angezeigt', async () => {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    await zeigeSteuerberater();

    await act(async () => {
      (q('accounting-period-close') as HTMLButtonElement).click();
    });
    expect(q('accounting-period-close-dialog')).not.toBeNull();
    await act(async () => {
      (q('accounting-period-close-confirm') as HTMLButtonElement).click();
    });

    expect(text()).toContain('Abgeschlossen');
    expect(q('accounting-period-revision')!.textContent).toBe('1');
    expect(q('accounting-period-history')).not.toBeNull();
    expect(q('accounting-period-reopen'), 'der Weg zurück fehlt').not.toBeNull();
  });

  /*
   * S5 — die Kernzusage, über die echte Seite geprüft: Ändert sich danach
   * etwas, bleibt es nicht bei „Abgeschlossen".
   */
  it('S5: nach einer Änderung meldet die Seite „Seit Abschluss geändert“', async () => {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    await zeigeSteuerberater();
    await act(async () => {
      (q('accounting-period-close') as HTMLButtonElement).click();
    });
    await act(async () => {
      (q('accounting-period-close-confirm') as HTMLButtonElement).click();
    });
    expect(text()).toContain('Abgeschlossen');

    // Eine nachträgliche Kontierungsänderung — die Seite neu betreten.
    setAccountingStoreForTests([kontierung({ accountNumber: '4980' })]);
    await zeigeSteuerberater();

    expect(text()).toContain('Seit Abschluss geändert');
    expect(q('accounting-period-changed')).not.toBeNull();
    expect(text()).toContain('erneut prüfen');
  });

  it('S6: auf der Seite steht kein technischer Schlüssel und keine Rechtssicherheitszusage', async () => {
    setExpenseStoreForTests([ausgabe()]);
    await zeigeSteuerberater();

    const sichtbar = q('steuerberater-period')!.textContent ?? '';
    expect(sichtbar).not.toMatch(/accountingPeriod\./);
    expect(sichtbar).not.toMatch(/not_ready|changed_after_close|unassigned_documents/);
    expect(sichtbar).not.toMatch(/GoBD|rechtssicher|festgeschrieben/i);
  });
});
