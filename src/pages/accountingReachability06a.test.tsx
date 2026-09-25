/**
 * STEUERBERATER-06A — Erreichbarkeit der Kontierung über die echten Routen.
 *
 * **Das ist kein Browser-Smoke.** In der Sitzung, in der dieser Test entstand,
 * stand kein Browserwerkzeug zur Verfügung; was er prüfen kann, ist die Stufe
 * darunter: Rendert die **echte Route** der Anwendung den neuen Bereich, und
 * steht dort das, was ein Nutzer lesen soll?
 *
 * Das deckt genau die Lücke, die Komponententests offen lassen. Die Bereiche
 * aus `accountingUi06a.test.tsx` funktionieren für sich; ob sie in der
 * zusammengesetzten Anwendung überhaupt erscheinen, sagt erst dieser Test.
 * Genau daran wäre die fehlende Kontenrahmen-Auswahl aufgefallen.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { AusgabeDetailPage } from './AusgabeDetailPage';
import { OperatingSettingsPage } from './settings/OperatingSettingsPage';
import { setExpenseStoreForTests } from '../services/expenseStore';
import { setAccountingStoreForTests } from '../services/accounting/accountingStore';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import { normalizeExpense } from '../services/expenseNormalize';
import { resetTestStores } from '../test/resetStores';
import type { Expense } from '../types/expense';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-reach',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-2026-9',
    title: '06A ERREICHBARKEIT',
    issueDate: '2026-06-01',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetTestStores();
  setAccountingStoreForTests([]);
  setExpenseStoreForTests([]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-0000000a0001',
      settings: {},
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

async function zeige(path: string, element: React.ReactElement, pattern: string): Promise<void> {
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppProvider initialSetup={completeSetup}>
            <Routes>
              <Route path={pattern} element={element} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
}

/* ================================================================== */

describe('06A — die Kontierung ist in der Anwendung erreichbar', () => {
  /* 1 — Einstellungen: der Kontenrahmen ist bedienbar. */
  it('S1: die Betriebseinstellungen zeigen die Kontenrahmen-Auswahl', async () => {
    await zeige('/einstellungen/betrieb', <OperatingSettingsPage />, '/einstellungen/betrieb');

    expect(q('settings-operating-accounting'), 'der Buchhaltungsabschnitt fehlt').not.toBeNull();
    const select = q('settings-chart-of-accounts-select') as HTMLSelectElement;
    expect(select, 'die Auswahl fehlt').not.toBeNull();
    expect([...select.options].map((o) => o.value)).toEqual(['SKR03', 'SKR04']);
    expect(text()).toContain('Kontenrahmen');
    // Solange nichts gewählt ist, sagt die Seite das ausdrücklich.
    expect(q('settings-chart-of-accounts-unset')).not.toBeNull();
    expect(text()).toContain('Noch nicht festgelegt');
  });

  it('S2: die Auswahl lässt sich speichern und bleibt nach erneutem Betreten stehen', async () => {
    await zeige('/einstellungen/betrieb', <OperatingSettingsPage />, '/einstellungen/betrieb');

    const select = q('settings-chart-of-accounts-select') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setter.call(select, 'SKR04');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(q('settings-chart-of-accounts-unset'), 'jetzt ist es eine Entscheidung').toBeNull();

    // Seite neu betreten — wie nach einem Reload aus dem persistierten Zustand.
    await zeige('/einstellungen/betrieb', <OperatingSettingsPage />, '/einstellungen/betrieb');
    expect((q('settings-chart-of-accounts-select') as HTMLSelectElement).value).toBe('SKR04');
  });

  /* 2 — Ausgabendetail: der Kontierungsbereich ist da und bedienbar. */
  it('S3: die Ausgabenseite zeigt den Kontierungsbereich', async () => {
    setExpenseStoreForTests([ausgabe()]);
    await zeige('/ausgaben/exp-reach', <AusgabeDetailPage />, '/ausgaben/:id');

    expect(q('ausgabe-section-accounting'), 'der Kontierungsabschnitt fehlt').not.toBeNull();
    expect(text()).toContain('Kontierung');
    expect(q('ausgabe-accounting-start'), 'der Weg zum Anlegen fehlt').not.toBeNull();
  });

  it('S4: der Vorschlag erscheint prüfbedürftig, mit ausdrücklichem Bestätigungsweg', async () => {
    setExpenseStoreForTests([ausgabe()]);
    await zeige('/ausgaben/exp-reach', <AusgabeDetailPage />, '/ausgaben/:id');

    await act(async () => {
      (q('ausgabe-accounting-start') as HTMLButtonElement).click();
    });

    expect(q('ausgabe-accounting-status')!.textContent).toBe('Zu prüfen');
    expect(q('ausgabe-accounting-status')!.textContent).not.toBe('Bestätigt');
    expect(q('ausgabe-accounting-confirm'), 'der Bestätigungsweg fehlt').not.toBeNull();
    expect(q('ausgabe-accounting-edit'), 'der Bearbeitungsweg fehlt').not.toBeNull();
    // Sachkonto, Bezeichnung und Buchungstext sind sichtbar.
    expect(text()).toContain('Sachkonto');
    expect(text()).toContain('Kontobezeichnung');
    expect(text()).toContain('Buchungstext');
  });

  /*
   * 3 — die Geldwahrheit bleibt unangetastet. Kontierung ist ein
   * Metadatenvorgang; Betrag, Steuer und Zahlungsstatus des Belegs dürfen sich
   * dadurch nicht ändern.
   */
  it('S5: das Kontieren verändert den Beleg nicht', async () => {
    const expense = ausgabe();
    setExpenseStoreForTests([expense]);
    await zeige('/ausgaben/exp-reach', <AusgabeDetailPage />, '/ausgaben/:id');

    await act(async () => {
      (q('ausgabe-accounting-start') as HTMLButtonElement).click();
    });

    const { getExpenseFromStoreById } = await import('../services/expenseStore');
    const nachher = getExpenseFromStoreById('exp-reach')!;
    expect(nachher.grossAmount).toBe(119);
    expect(nachher.netAmount).toBe(100);
    expect(nachher.taxAmount).toBe(19);
    expect(nachher.taxStatus).toBe('standard_19');
    expect(nachher.paymentStatus).toBe(expense.paymentStatus);
  });

  /* 4 — keine technischen Namen in der zusammengesetzten Seite. */
  it('S6: auf der Ausgabenseite steht kein technischer Kontierungsbegriff', async () => {
    setExpenseStoreForTests([ausgabe()]);
    await zeige('/ausgaben/exp-reach', <AusgabeDetailPage />, '/ausgaben/:id');
    await act(async () => {
      (q('ausgabe-accounting-start') as HTMLButtonElement).click();
    });

    const sichtbar = q('ausgabe-section-accounting')!.textContent ?? '';
    expect(sichtbar).not.toMatch(/needs_review|needs_clarification|confirmed/);
    expect(sichtbar).not.toMatch(/accounting\./);
    expect(sichtbar).toContain('Vorgeschlagen');
  });
});
