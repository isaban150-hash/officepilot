/**
 * STEUERBERATER-06B — der sichtbare Abschlussweg.
 *
 * Zwei Dinge stehen im Mittelpunkt:
 *
 *   1. Ein nicht bereiter Monat bietet keinen Abschlussknopf, **aber nennt die
 *      Gründe**. Ein gesperrter Knopf ohne Begründung wäre eine Sackgasse.
 *   2. Nirgends steht eine Compliance-Zusage. Der letzte Test prüft das über
 *      den gesamten sichtbaren Text.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountingPeriodPanel } from './AccountingPeriodPanel';
import {
  getAllAccountingPeriodClosures,
  setAccountingPeriodStoreForTests,
} from '../../services/accounting/accountingPeriodStore';
import { setAccountingStoreForTests } from '../../services/accounting/accountingStore';
import type { AccountingAssignment } from '../../types/accounting';
import { setExpenseStoreForTests } from '../../services/expenseStore';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { normalizeExpense } from '../../services/expenseNormalize';
import { resetTestStores } from '../../test/resetStores';
import { de } from '../../i18n';
import type { AccountingPeriodClosure, AccountingPeriodState } from '../../types/accountingPeriod';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

/** Echte deutsche Texte — nur so fällt ein durchgereichter Schlüssel auf. */
const translate = (key: TranslationKey): string => de[key] ?? key;

const MONTH = '2026-09';

function manifest(count = 1) {
  return {
    monthKey: MONTH,
    chartOfAccounts: 'SKR03',
    documentCount: count,
    totalBrutto: 119,
    totalNetto: 100,
    totalSteuer: 19,
    entries: [],
  };
}

function closure(overrides: Partial<AccountingPeriodClosure> = {}): AccountingPeriodClosure {
  return {
    id: 'cl-1',
    monthKey: MONTH,
    revision: 1,
    closedAt: '2026-09-24T10:00:00.000Z',
    closedBy: 'user-1',
    fingerprint: 'p1:aaaa:100',
    manifest: manifest(),
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

function state(overrides: Partial<AccountingPeriodState> = {}): AccountingPeriodState {
  return {
    monthKey: MONTH,
    readiness: 'ready',
    blockers: [],
    currentFingerprint: 'p1:aaaa:100',
    currentManifest: manifest(),
    activeClosure: null,
    isCurrentClosureValid: false,
    revisionHistory: [],
    ...overrides,
  };
}

function ausgabe(): Expense {
  return normalizeExpense({
    id: 'exp-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-1',
    title: '06B UI',
    issueDate: '2026-09-05',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
  } as Expense);
}

/**
 * Eine bestaetigte Kontierung fuer den Testbeleg.
 *
 * Noetig, weil `closeAccountingPeriod` den Monat **selbst** neu ableitet,
 * statt dem uebergebenen Zustand zu glauben. Genau so soll es sein: Der
 * Dienst ist die Wahrheit, nicht die Ansicht — sonst liesse sich ein
 * Abschluss durch einen veralteten Props-Wert erzwingen.
 */
function kontierung(): AccountingAssignment {
  return {
    id: 'k1',
    sourceType: 'expense',
    sourceId: 'exp-1',
    chartOfAccounts: 'SKR03',
    accountNumber: '4930',
    accountLabel: 'Bürobedarf',
    taxTreatment: 'standard_19',
    bookingText: 'Baustoff Süd GmbH · RE-1',
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
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  setExpenseStoreForTests([]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-0000000b0001',
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
  resetTestStores();
});

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const wert = (id: string) => q(id)?.textContent ?? '';
const text = () => container.textContent ?? '';

async function zeige(value: AccountingPeriodState, onChanged: () => void = () => {}): Promise<void> {
  await act(async () => {
    root.render(
      <AccountingPeriodPanel
        state={value}
        monthLabel="September 2026"
        onChanged={onChanged}
        translate={translate}
      />,
    );
  });
}

async function klick(id: string): Promise<void> {
  await act(async () => {
    (q(id) as HTMLButtonElement).click();
  });
}

/* ================================================================== */

describe('AB — Monatsabschluss in der Oberfläche', () => {
  /* AB1 — der Stand ist sichtbar. */
  it('AB1: der Monatsstand steht als Abzeichen da', async () => {
    await zeige(state({ readiness: 'ready' }));
    expect(wert('accounting-period-state')).toBe('Bereit zum Abschluss');
    expect(wert('accounting-period-count')).toBe('1');
  });

  /* AB2/AB3 — Blocker verständlich, Knopf erst bei Bereitschaft. */
  it('AB2/AB3: ein nicht bereiter Monat nennt die Gründe und bietet keinen Abschluss', async () => {
    await zeige(
      state({
        readiness: 'not_ready',
        blockers: [
          { code: 'unassigned_documents', count: 3, sourceIds: ['a', 'b', 'c'] },
          { code: 'needs_clarification', count: 1, sourceIds: ['d'] },
        ],
      }),
    );

    expect(q('accounting-period-close'), 'kein Abschluss ohne Bereitschaft').toBeNull();
    expect(q('accounting-period-blockers')).not.toBeNull();
    expect(wert('accounting-period-blocker-unassigned_documents')).toBe(
      'Belege ohne Kontierung: 3',
    );
    expect(wert('accounting-period-blocker-needs_clarification')).toBe(
      'Kontierungen in Klärung: 1',
    );
    expect(wert('accounting-period-state')).toBe('Noch nicht bereit');
  });

  /* AB4 — der Abschlussdialog nennt Monat und Belegzahl. */
  it('AB4: der Abschlussdialog nennt Monat und Anzahl', async () => {
    setExpenseStoreForTests([ausgabe()]);
    await zeige(state({ readiness: 'ready', currentManifest: manifest(15) }));

    await klick('accounting-period-close');
    expect(q('accounting-period-close-dialog')).not.toBeNull();
    expect(text()).toContain('Sie schließen September 2026 mit 15 steuerlich relevanten Belegen ab.');
    expect(q('accounting-period-close-confirm')).not.toBeNull();
    expect(q('accounting-period-close-cancel')).not.toBeNull();
  });

  it('ein leerer Monat bekommt einen eigenen Satz im Dialog', async () => {
    await zeige(state({ readiness: 'open', currentManifest: manifest(0) }));
    expect(q('accounting-period-empty')).not.toBeNull();
    expect(text()).toContain('Keine steuerlich relevanten Belege in diesem Monat.');

    await klick('accounting-period-close');
    expect(text()).toContain('Sie schließen September 2026 ohne steuerlich relevante Belege ab.');
  });

  /* AB5/AB6 — nach dem Abschluss sind Datum und Revision sichtbar. */
  it('AB5/AB6: ein abgeschlossener Monat zeigt Datum, Revision und Hinweis', async () => {
    await zeige(
      state({ readiness: 'closed', activeClosure: closure(), isCurrentClosureValid: true }),
    );

    expect(wert('accounting-period-state')).toBe('Abgeschlossen');
    expect(wert('accounting-period-closed-at')).toBe('24.09.2026');
    expect(wert('accounting-period-revision')).toBe('1');
    expect(q('accounting-period-closed-hint')).not.toBeNull();
    expect(text()).toContain('Spätere Änderungen an Belegen oder Kontierungen werden erkannt');
    // Kein zweiter Abschluss auf einen offenen Abschluss.
    expect(q('accounting-period-close')).toBeNull();
  });

  /* AB7 — die Wiederöffnung ist eine eigene, bewusste Aktion. */
  it('AB7: die Wiederöffnung verlangt einen Dialog und sagt, dass die Historie bleibt', async () => {
    await zeige(
      state({ readiness: 'closed', activeClosure: closure(), isCurrentClosureValid: true }),
    );

    expect(q('accounting-period-reopen')).not.toBeNull();
    await klick('accounting-period-reopen');

    expect(q('accounting-period-reopen-dialog')).not.toBeNull();
    expect(text()).toContain('Der bisherige Abschluss bleibt in der Historie erhalten.');
    expect(q('accounting-period-reason'), 'das Grundfeld fehlt').not.toBeNull();
    expect(q('accounting-period-reopen-confirm')).not.toBeNull();
  });

  /* AB8 — die Historie. */
  it('AB8: der Abschlussverlauf zeigt beide Revisionen mit Zustand', async () => {
    await zeige(
      state({
        readiness: 'closed',
        activeClosure: closure({ id: 'cl-2', revision: 2, closedAt: '2026-09-26T10:00:00.000Z' }),
        isCurrentClosureValid: true,
        revisionHistory: [
          closure({ id: 'cl-2', revision: 2, closedAt: '2026-09-26T10:00:00.000Z' }),
          closure({
            id: 'cl-1',
            revision: 1,
            reopenedAt: '2026-09-25T10:00:00.000Z',
            reopenReason: 'Beleg nachgereicht',
          }),
        ],
      }),
    );

    expect(q('accounting-period-history')).not.toBeNull();
    expect(wert('accounting-period-history-2')).toContain('24.09.2026'.slice(0, 0) + '26.09.2026');
    expect(wert('accounting-period-history-2')).toContain('Aktuell');
    expect(wert('accounting-period-history-1')).toContain('Später wieder geöffnet');
    expect(wert('accounting-period-history-1')).toContain('Beleg nachgereicht');
  });

  /* AB9 — die Warnung nach einer Änderung. */
  it('AB9: ein veralteter Abschluss wird sichtbar als geändert gemeldet', async () => {
    await zeige(
      state({
        readiness: 'changed_after_close',
        activeClosure: closure(),
        isCurrentClosureValid: false,
        currentFingerprint: 'p1:bbbb:200',
      }),
    );

    expect(wert('accounting-period-state')).toBe('Seit Abschluss geändert');
    expect(q('accounting-period-changed')).not.toBeNull();
    expect(text()).toContain('haben sich seit dem Abschluss geändert');
    expect(text()).toContain('erneut prüfen');
    // Der Abschluss bleibt sichtbar — er war zu seiner Zeit richtig.
    expect(wert('accounting-period-revision')).toBe('1');
  });

  /* AB10 — keine technischen Schlüssel. */
  it('AB10: es steht kein technischer Schlüssel und kein Enum-Wert im Bereich', async () => {
    await zeige(
      state({
        readiness: 'changed_after_close',
        activeClosure: closure(),
        blockers: [{ code: 'needs_review', count: 2, sourceIds: ['a', 'b'] }],
        revisionHistory: [closure()],
      }),
    );

    const sichtbar = text();
    expect(sichtbar).not.toMatch(/accountingPeriod\./);
    expect(sichtbar).not.toMatch(/changed_after_close|not_ready|needs_review|unassigned_documents/);
    expect(sichtbar).toContain('Seit Abschluss geändert');
    expect(sichtbar).toContain('Kontierungen noch zu prüfen: 2');
  });

  /*
   * AB11 — die wichtigste Zusage der Produktsprache: Der Bereich verspricht
   * keine Rechtssicherheit. OfficeTakt sperrt nach dem Abschluss nichts, und
   * ein Wort wie „festgeschrieben" wäre genau die Zusage, die es nicht
   * einlösen kann.
   */
  it('AB11: nirgends steht eine GoBD- oder Rechtssicherheitsbehauptung', async () => {
    for (const readiness of ['ready', 'closed', 'changed_after_close'] as const) {
      await zeige(
        state({
          readiness,
          activeClosure: readiness === 'ready' ? null : closure(),
          revisionHistory: readiness === 'ready' ? [] : [closure()],
        }),
      );
      const sichtbar = text();
      expect(sichtbar, readiness).not.toMatch(/GoBD/i);
      expect(sichtbar, readiness).not.toMatch(/rechtssicher/i);
      expect(sichtbar, readiness).not.toMatch(/festgeschrieben/i);
      expect(sichtbar, readiness).not.toMatch(/unveränderbar/i);
    }
  });

  /*
   * Die Kette, die wirklich zählt: bereit → Dialog → bestätigen → der Aufrufer
   * erfährt davon. Ohne diesen Test wäre der Knopf nur Dekoration.
   */
  it('der Abschluss über den Dialog meldet die Änderung zurück', async () => {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    let geaendert = 0;
    await zeige(state({ readiness: 'ready' }), () => {
      geaendert += 1;
    });

    await klick('accounting-period-close');
    await klick('accounting-period-close-confirm');
    expect(geaendert).toBe(1);
  });

  it('Abbrechen im Abschlussdialog schliesst nichts ab', async () => {
    let geaendert = 0;
    await zeige(state({ readiness: 'ready' }), () => {
      geaendert += 1;
    });

    await klick('accounting-period-close');
    await klick('accounting-period-close-cancel');
    expect(q('accounting-period-close-dialog')).toBeNull();
    expect(geaendert).toBe(0);
  });
});

/* ================================================================== */
/* 01H — der Abschluss trägt den angemeldeten Nutzer                   */
/* ================================================================== */

describe('01H — closedBy aus der Oberfläche', () => {
  async function schliesseAb(closedBy: string | undefined): Promise<void> {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    await act(async () => {
      root.render(
        <AccountingPeriodPanel
          state={state({ readiness: 'ready' })}
          monthLabel="September 2026"
          onChanged={() => {}}
          translate={translate}
          closedBy={closedBy}
        />,
      );
    });
    await klick('accounting-period-close');
    await klick('accounting-period-close-confirm');
  }

  it('mit angemeldetem Nutzer wird seine ID gespeichert', async () => {
    await schliesseAb('7f1c2d3e-0000-4000-8000-000000000001');
    const [gespeichert] = getAllAccountingPeriodClosures();
    expect(gespeichert?.closedBy).toBe('7f1c2d3e-0000-4000-8000-000000000001');
  });

  it('ohne Nutzer wird niemand eingetragen', async () => {
    await schliesseAb(undefined);
    const [gespeichert] = getAllAccountingPeriodClosures();
    expect(gespeichert).toBeDefined();
    expect(gespeichert.closedBy).toBeUndefined();
  });
});
