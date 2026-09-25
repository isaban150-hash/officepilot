/**
 * STEUERBERATER-06C — die sichtbare Übergabe.
 *
 * Zwei Zusagen stehen im Mittelpunkt:
 *
 *   1. **Kein toter Knopf.** Ist der Export nicht möglich, steht der Grund da,
 *      statt dass ein Klick eine Fehlermeldung wirft.
 *   2. **Kein Fake-DATEV.** Der DATEV-Bereich bietet keine Aktion an, sondern
 *      erklärt, was fehlt. Nirgends entsteht eine Datei, die so heisst.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../../context/AuthContext';
import { TestProviders } from '../../test/testProviders';
import { DEFAULT_SETUP } from '../../data/mockData';
import { AccountingExportPanel } from './AccountingExportPanel';
import { SteuerberaterPage } from '../../pages/SteuerberaterPage';
import { collectDatevBlockers } from '../../services/accounting/accountingExportGateService';
import { setAccountingStoreForTests } from '../../services/accounting/accountingStore';
import { setAccountingPeriodStoreForTests } from '../../services/accounting/accountingPeriodStore';
import { closeAccountingPeriod } from '../../services/accounting/accountingPeriodService';
import { setExpenseStoreForTests } from '../../services/expenseStore';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { normalizeExpense } from '../../services/expenseNormalize';
import { resetTestStores } from '../../test/resetStores';
import { de } from '../../i18n';
import type { AccountingExportReadiness } from '../../services/accounting/accountingExportGateService';
import type { AccountingPeriodState } from '../../types/accountingPeriod';
import type { AccountingAssignment } from '../../types/accounting';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

/** Echte deutsche Texte — nur so fällt ein durchgereichter Schlüssel auf. */
const translate = (key: TranslationKey): string => de[key] ?? key;

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

function state(): AccountingPeriodState {
  return {
    monthKey: '2026-09',
    readiness: 'closed',
    blockers: [],
    currentFingerprint: 'p1:aaaa:100',
    currentManifest: {
      monthKey: '2026-09',
      chartOfAccounts: 'SKR03',
      documentCount: 1,
      totalBrutto: 119,
      totalNetto: 100,
      totalSteuer: 19,
      entries: [],
    },
    activeClosure: null,
    isCurrentClosureValid: true,
    revisionHistory: [],
  };
}

function readiness(overrides: Partial<AccountingExportReadiness> = {}): AccountingExportReadiness {
  return {
    monthKey: '2026-09',
    packageAllowed: true,
    packageBlockers: [],
    datevAllowed: false,
    datevBlockers: collectDatevBlockers(),
    state: state(),
    ...overrides,
  };
}

function ausgabe(): Expense {
  return normalizeExpense({
    id: 'exp-06c',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-06C',
    title: '06C UI',
    issueDate: new Date().toISOString().slice(0, 10),
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
  } as Expense);
}

function kontierung(): AccountingAssignment {
  return {
    id: 'k-06c',
    sourceType: 'expense',
    sourceId: 'exp-06c',
    chartOfAccounts: 'SKR03',
    accountNumber: '4930',
    accountLabel: 'Bürobedarf',
    taxTreatment: 'standard_19',
    bookingText: 'Baustoff Süd GmbH · RE-06C',
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
  setExpenseStoreForTests([]);
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-0000000c0001',
      settings: { chartOfAccounts: 'SKR03' },
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

async function zeige(
  value: AccountingExportReadiness,
  onCreate: () => Promise<string | null> = async () => 'paket.zip',
): Promise<void> {
  await act(async () => {
    root.render(
      <AccountingExportPanel readiness={value} onCreatePackage={onCreate} translate={translate} />,
    );
  });
}

/* ================================================================== */

describe('V/W — die Übergabe in der Oberfläche', () => {
  it('bei gültigem Abschluss steht die Paketaktion bereit', async () => {
    await zeige(readiness());
    expect(q('accounting-export-package')).not.toBeNull();
    expect(text()).toContain('Steuerberater-Paket erstellen');
    expect(text()).toContain('Buchungsdaten, Originalbelege');
    expect(q('accounting-export-blockers')).toBeNull();
  });

  /* W — kein toter Knopf, sondern der Grund. */
  it('W: ein nicht abgeschlossener Monat zeigt den Grund statt eines Knopfes', async () => {
    await zeige(
      readiness({ packageAllowed: false, packageBlockers: [{ code: 'not_closed' }] }),
    );
    expect(q('accounting-export-package'), 'kein Knopf ohne Abschluss').toBeNull();
    expect(q('accounting-export-blocker-not_closed')).not.toBeNull();
    expect(text()).toContain('Der Monat ist nicht abgeschlossen.');
  });

  /* E — der Satz für den veralteten Abschluss, wörtlich wie beauftragt. */
  it('E: ein veralteter Abschluss wird mit dem vorgesehenen Satz erklärt', async () => {
    await zeige(
      readiness({ packageAllowed: false, packageBlockers: [{ code: 'changed_after_close' }] }),
    );
    expect(text()).toContain(
      'Seit dem Monatsabschluss wurden steuerlich relevante Daten geändert. Öffnen und prüfen Sie den Monat erneut.',
    );
    expect(q('accounting-export-package')).toBeNull();
  });

  it('offene Punkte werden mit Anzahl genannt', async () => {
    await zeige(
      readiness({
        packageAllowed: false,
        packageBlockers: [{ code: 'period_blockers', detail: '3' }],
      }),
    );
    expect(text()).toContain('Es sind noch 3 Punkte offen.');
  });

  /* V — DATEV wird nicht angeboten, sondern erklärt. */
  it('V: DATEV bietet keine Aktion, sondern nennt konkret, was fehlt', async () => {
    await zeige(readiness());

    expect(text()).toContain('DATEV-Format ist noch nicht eingerichtet.');
    expect(text()).toContain('Für DATEV fehlen noch Gegenkonten und die Buchungsrichtung.');
    expect(text()).toContain('Es fehlen die DATEV-Steuerschlüssel.');
    expect(text()).toContain('Berater- und Mandantennummer sind nicht hinterlegt.');
    // Und der Hinweis, dass das Paket davon unabhängig ist.
    expect(q('accounting-export-datev-note')).not.toBeNull();
    // Kein Knopf, der nie funktioniert.
    const knoepfe = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(knoepfe.some((t) => /DATEV/i.test(t)), 'keine DATEV-Aktion').toBe(false);
  });

  it('das Erstellen meldet den Dateinamen zurück', async () => {
    await zeige(readiness(), async () => 'Steuerberater_2026-09_Revision-1.zip');
    await act(async () => {
      (q('accounting-export-package') as HTMLButtonElement).click();
    });
    expect(q('accounting-export-created')?.textContent).toBe(
      'Steuerberater_2026-09_Revision-1.zip',
    );
  });

  it('ein Fehlschlag wird sichtbar gemeldet', async () => {
    await zeige(readiness(), async () => null);
    await act(async () => {
      (q('accounting-export-package') as HTMLButtonElement).click();
    });
    expect(q('accounting-export-failed')).not.toBeNull();
    expect(text()).toContain('Das Paket konnte nicht erstellt werden.');
  });

  it('kein technischer Schlüssel und kein Enum-Wert im Bereich', async () => {
    await zeige(
      readiness({ packageAllowed: false, packageBlockers: [{ code: 'changed_after_close' }] }),
    );
    const sichtbar = text();
    expect(sichtbar).not.toMatch(/accountingExport\./);
    expect(sichtbar).not.toMatch(/not_closed|changed_after_close|period_blockers/);
    expect(sichtbar).not.toMatch(/datev_no_/);
  });
});

/* ================================================================== */
/* Erreichbarkeit über die echte Seite                                 */
/* ================================================================== */

describe('AF-Ersatz — die Übergabe ist in der Anwendung erreichbar', () => {
  /*
   * **Kein Browser-Smoke.** In dieser Sitzung stand kein Browserwerkzeug zur
   * Verfügung; geprüft wird die Stufe darunter — rendert die echte
   * Steuerberaterseite den Übergabebereich, und verhält er sich dort richtig?
   */
  async function zeigeSeite(): Promise<void> {
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

  it('S1: die Seite zeigt den Übergabebereich', async () => {
    await zeigeSeite();
    expect(q('steuerberater-export'), 'der Übergabeabschnitt fehlt').not.toBeNull();
    expect(q('accounting-export')).not.toBeNull();
    expect(text()).toContain('Übergabe an den Steuerberater');
  });

  it('S2: ohne Abschluss steht dort der Grund, kein Knopf', async () => {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    await zeigeSeite();

    expect(q('accounting-export-package')).toBeNull();
    expect(text()).toContain('Der Monat ist nicht abgeschlossen.');
  });

  it('S3: nach dem Abschluss steht die Paketaktion bereit', async () => {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    const monthKey = new Date().toISOString().slice(0, 7);
    expect(closeAccountingPeriod(monthKey).success).toBe(true);

    await zeigeSeite();
    expect(q('accounting-export-package'), 'die Paketaktion fehlt').not.toBeNull();
    expect(q('accounting-export-blockers')).toBeNull();
  });

  it('S4: die Seite verspricht kein DATEV-Format', async () => {
    await zeigeSeite();
    const bereich = q('steuerberater-export')!.textContent ?? '';
    expect(bereich).toContain('DATEV-Format ist noch nicht eingerichtet.');
    expect(bereich).not.toMatch(/GoBD|rechtssicher|festgeschrieben/i);
  });
});
