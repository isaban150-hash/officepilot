/**
 * STEUERBERATER-06A — der sichtbare Kontierungsweg.
 *
 * Geprüft wird vor allem, dass die Oberfläche die Confirm-first-Regel nicht
 * unterläuft: „Übernehmen" speichert, „Bestätigen" bestätigt, und zwar nur
 * dieses. Ein stilles Confirm-on-Save wäre der eine Fehler, den man hier nicht
 * machen darf.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountingAssignmentPanel } from './AccountingAssignmentPanel';
import { AccountingChecklistPanel } from './AccountingChecklistPanel';
import {
  ensureExpenseAccountingAssignment,
  confirmAccountingAssignment,
  resolveVisibleSuggestionReason,
  updateAccountingAssignment,
} from '../../services/accounting/accountingAssignmentService';
import {
  getAccountingAssignmentForSource,
  setAccountingStoreForTests,
} from '../../services/accounting/accountingStore';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { normalizeExpense } from '../../services/expenseNormalize';
import { resetTestStores } from '../../test/resetStores';
import { de } from '../../i18n';
import type { Expense } from '../../types/expense';
import type { AccountingChecklist } from '../../types/accounting';
import type { TranslationKey } from '../../i18n';

/** Echte deutsche Texte — nur so fällt ein durchgereichter Schlüssel auf. */
const translate = (key: TranslationKey): string => de[key] ?? key;

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-ui',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-2026-1',
    title: '06A UI',
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
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-0000000a0001',
      settings: { chartOfAccounts: 'SKR04' },
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

/** Rendert den Bereich mit dem aktuellen Stand aus dem Speicher. */
async function zeige(expense: Expense): Promise<void> {
  await act(async () => {
    root.render(
      <AccountingAssignmentPanel
        assignment={getAccountingAssignmentForSource('expense', expense.id)}
        onStart={() => {
          ensureExpenseAccountingAssignment(expense);
          void zeige(expense);
        }}
        onChanged={() => void zeige(expense)}
        translate={translate}
        testIdPrefix="ausgabe"
      />,
    );
  });
}

async function klick(id: string): Promise<void> {
  await act(async () => {
    (q(id) as HTMLButtonElement).click();
  });
}

async function tippe(id: string, value: string): Promise<void> {
  const input = q(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/* ================================================================== */

describe('Z — Kontierungsbereich am Beleg', () => {
  it('Z1: ohne Kontierung steht ein Satz und ein Weg, keine leere Maske', async () => {
    await zeige(ausgabe());
    expect(q('ausgabe-accounting-empty')).not.toBeNull();
    expect(text()).toContain('Für diesen Beleg wurde noch nichts kontiert.');
    expect(q('ausgabe-accounting-start')).not.toBeNull();
  });

  /* Z4/Z6/Z8/Z12 — der angelegte Vorschlag zeigt alles Nötige. */
  it('Z4/Z6/Z8/Z12: der Vorschlag zeigt Rahmen, Stand, Herkunft und Buchungstext', async () => {
    const expense = ausgabe();
    await zeige(expense);
    await klick('ausgabe-accounting-start');

    expect(wert('ausgabe-accounting-chart'), 'der Kontenrahmen des Betriebs').toBe('SKR04');
    expect(wert('ausgabe-accounting-status')).toBe('Zu prüfen');
    expect(wert('ausgabe-accounting-origin')).toBe('Vorgeschlagen');
    expect(wert('ausgabe-accounting-account')).toBe('Noch kein Sachkonto');
    expect(wert('ausgabe-accounting-booking-text')).toBe('Baustoff Süd GmbH · RE-2026-1');
    // Die Begründung sagt, warum kein Konto vorgeschlagen wird.
    expect(wert('ausgabe-accounting-reason')).toContain('Sachkonto schlägt OfficeTakt nicht vor');
  });

  /*
   * Z3/Z5/Z10/Z11 — der Kern: Übernehmen speichert, bestätigt aber nicht. Erst
   * der zweite, ausdrückliche Knopf setzt „Bestätigt".
   */
  it('Z3/Z5/Z10/Z11: Übernehmen speichert, erst Bestätigen bestätigt', async () => {
    const expense = ausgabe();
    await zeige(expense);
    await klick('ausgabe-accounting-start');

    await klick('ausgabe-accounting-edit');
    await tippe('ausgabe-accounting-input-account', '4930');
    await tippe('ausgabe-accounting-input-label', 'Bürobedarf');
    await tippe('ausgabe-accounting-input-booking-text', 'Eigener Text');
    // Der Satz, der den Unterschied benennt, steht im Formular.
    expect(wert('ausgabe-accounting-save-hint')).toContain('Bestätigt wird erst');

    await klick('ausgabe-accounting-save');

    expect(wert('ausgabe-accounting-account')).toBe('4930');
    expect(wert('ausgabe-accounting-account-label')).toBe('Bürobedarf');
    expect(wert('ausgabe-accounting-booking-text')).toBe('Eigener Text');
    expect(wert('ausgabe-accounting-origin')).toBe('Manuell gewählt');
    expect(wert('ausgabe-accounting-status'), 'Speichern darf nicht bestätigen').toBe('Zu prüfen');
    expect(getAccountingAssignmentForSource('expense', 'exp-ui')!.status).toBe('needs_review');

    await klick('ausgabe-accounting-confirm');
    expect(wert('ausgabe-accounting-status')).toBe('Bestätigt');
    expect(getAccountingAssignmentForSource('expense', 'exp-ui')!.confirmedAt).toBeTruthy();
    // Nach der Bestätigung gibt es nichts mehr zu bestätigen.
    expect(q('ausgabe-accounting-confirm')).toBeNull();
  });

  it('Z7: ohne Sachkonto wird die Bestätigung mit Begründung abgewiesen', async () => {
    const expense = ausgabe();
    await zeige(expense);
    await klick('ausgabe-accounting-start');
    await klick('ausgabe-accounting-confirm');

    expect(q('ausgabe-accounting-error')).not.toBeNull();
    expect(wert('ausgabe-accounting-error')).toContain('fehlt das Sachkonto');
    expect(wert('ausgabe-accounting-status')).toBe('Zu prüfen');
  });

  it('Z9: „Klärung nötig“ lässt sich ausdrücklich setzen', async () => {
    const expense = ausgabe();
    await zeige(expense);
    await klick('ausgabe-accounting-start');
    await klick('ausgabe-accounting-unclear');

    expect(wert('ausgabe-accounting-status')).toBe('Klärung nötig');
  });

  it('eine bestätigte Kontierung verlangt nach einer Änderung erneute Prüfung', async () => {
    const expense = ausgabe();
    await zeige(expense);
    await klick('ausgabe-accounting-start');
    const id = getAccountingAssignmentForSource('expense', 'exp-ui')!.id;
    updateAccountingAssignment(id, { accountNumber: '4930' });
    confirmAccountingAssignment(id);
    await zeige(expense);
    expect(wert('ausgabe-accounting-status')).toBe('Bestätigt');

    await klick('ausgabe-accounting-edit');
    await tippe('ausgabe-accounting-input-account', '4980');
    await klick('ausgabe-accounting-save');

    expect(wert('ausgabe-accounting-status')).toBe('Zu prüfen');
  });

  it('ein unklarer Steuerstatus zeigt sich als Klärungsfall', async () => {
    const expense = ausgabe({ id: 'exp-unclear', taxStatus: 'unclear' });
    await zeige(expense);
    await klick('ausgabe-accounting-start');
    expect(wert('ausgabe-accounting-status')).toBe('Klärung nötig');
    expect(wert('ausgabe-accounting-reason')).toContain('Steuerstatus des Belegs ist unklar');
  });

  /* Z14 — keine technischen Schlüssel und keine Enum-Werte. */
  it('Z14: es steht kein technischer Schlüssel und kein Enum-Wert im Bereich', async () => {
    const expense = ausgabe();
    await zeige(expense);
    await klick('ausgabe-accounting-start');

    const sichtbar = text();
    expect(sichtbar).not.toMatch(/accounting\./);
    expect(sichtbar).not.toMatch(/needs_review|needs_clarification|confirmed/);
    expect(sichtbar).not.toMatch(/\bsuggested\b|\bmanual\b/);
    expect(sichtbar).not.toMatch(/standard_19/);
    expect(sichtbar).toContain('Zu prüfen');
    expect(sichtbar).toContain('Vorgeschlagen');
  });
});

/* ================================================================== */

describe('Z13 — Monatsübersicht im Steuerberaterbereich', () => {
  function checklist(overrides: Partial<AccountingChecklist> = {}): AccountingChecklist {
    return {
      monthKey: '2026-09',
      chartOfAccounts: 'SKR04',
      totalRelevantDocuments: 15,
      /* 01H — die vier Stände sind disjunkt: 12 + 1 + 1 + 1 = 15. */
      confirmedCount: 12,
      needsReviewCount: 1,
      needsClarificationCount: 1,
      unassignedCount: 1,
      openEntries: [
        {
          sourceType: 'expense',
          sourceId: 'exp-1',
          belegnummer: 'RE-1',
          datum: '2026-09-05',
          gegenpartei: 'Baustoff Süd GmbH',
          brutto: 119,
          status: 'needs_review',
          accountNumber: '',
          bookingText: '',
        },
        {
          sourceType: 'expense',
          sourceId: 'exp-credit',
          belegnummer: 'GS-1',
          datum: '2026-09-07',
          gegenpartei: 'Baustoff Süd GmbH',
          brutto: -119,
          status: 'needs_clarification',
          accountNumber: '',
          bookingText: '',
          hinweis: 'storniert',
        },
      ],
      confirmedEntries: [],
      ...overrides,
    };
  }

  async function zeigeListe(value: AccountingChecklist): Promise<void> {
    await act(async () => {
      root.render(<AccountingChecklistPanel checklist={value} translate={translate} />);
    });
  }

  it('Z13: der Fortschritt steht als Satz da', async () => {
    await zeigeListe(checklist());
    expect(wert('accounting-checklist-progress')).toBe('12 von 15 Belegen kontiert');
    expect(wert('accounting-checklist-review')).toBe('1 zu prüfen');
    expect(wert('accounting-checklist-clarify')).toBe('1 in Klärung');
    expect(wert('accounting-checklist-chart')).toBe('SKR04');
  });

  /* 01H — Befund „24 zu prüfen" für 23 nicht kontierte und 1 zu prüfenden Beleg. */
  it('01H: nicht kontiert, zu prüfen, Klärung und bestätigt stehen getrennt', async () => {
    await zeigeListe(
      checklist({
        totalRelevantDocuments: 26,
        confirmedCount: 1,
        needsReviewCount: 1,
        needsClarificationCount: 1,
        unassignedCount: 23,
      }),
    );
    expect(wert('accounting-checklist-unassigned')).toBe('23 nicht kontiert');
    expect(wert('accounting-checklist-review')).toBe('1 zu prüfen');
    expect(wert('accounting-checklist-clarify')).toBe('1 in Klärung');
    expect(wert('accounting-checklist-confirmed')).toBe('1 bestätigt');
    expect(text()).not.toContain('24 zu prüfen');
    expect(text()).not.toMatch(/needs_review|needs_clarification|confirmed|unassigned/);
  });

  it('die offenen Belege stehen mit Betrag und Stand in der Liste', async () => {
    await zeigeListe(checklist());
    expect(q('accounting-checklist-entry-exp-1')).not.toBeNull();
    expect(wert('accounting-checklist-status-exp-1')).toBe('Zu prüfen');
    expect(wert('accounting-checklist-status-exp-credit')).toBe('Klärung nötig');
    // Die Gutschrift behält ihr Vorzeichen.
    expect(wert('accounting-checklist-meta-exp-credit')).toContain('-119,00');
  });

  it('ohne relevante Belege steht ein Satz statt einer Nullenwand', async () => {
    await zeigeListe(
      checklist({
        totalRelevantDocuments: 0,
        confirmedCount: 0,
        needsReviewCount: 0,
        needsClarificationCount: 0,
        unassignedCount: 0,
        openEntries: [],
      }),
    );
    expect(q('accounting-checklist-empty')).not.toBeNull();
    expect(q('accounting-checklist-summary')).toBeNull();
  });

  /* Kein Export, keine Festschreibung — und die Oberfläche sagt das auch. */
  it('die Übersicht verspricht weder Export noch Abschluss', async () => {
    await zeigeListe(checklist());
    expect(q('accounting-checklist-no-export')).not.toBeNull();
    expect(text()).toContain('Noch keine DATEV-Datei und kein Monatsabschluss');
    expect(text()).not.toMatch(/accounting\.overview\./);
  });
});

/* ================================================================== */
/* 01H — der Sachkonto-Hinweis folgt dem aktuellen Stand               */
/* ================================================================== */

/*
 * Befund: Nach Eingabe eines gültigen Sachkontos blieb „… bitte eintragen"
 * stehen. Der Grund war beim Anlegen eingefroren und wurde bis zur
 * Bestätigung angezeigt. Jetzt wird er aus dem gespeicherten Sachkonto
 * abgeleitet — keine zweite, lokale Wahrheit im Formular.
 */
describe('01H — Sachkonto-Hinweis', () => {
  const HINWEIS = 'Sachkonto schlägt OfficeTakt nicht vor';

  async function speichereKonto(value: string): Promise<void> {
    await klick('ausgabe-accounting-edit');
    await tippe('ausgabe-accounting-input-account', value);
    await klick('ausgabe-accounting-save');
  }

  it('leer → eingetragen → geändert → entfernt → eingetragen → bestätigt', async () => {
    await zeige(ausgabe());
    await klick('ausgabe-accounting-start');

    // leer
    expect(wert('ausgabe-accounting-reason')).toContain(HINWEIS);

    // eingetragen
    await speichereKonto('4930');
    expect(wert('ausgabe-accounting-account')).toBe('4930');
    expect(q('ausgabe-accounting-reason'), 'Hinweis nach Eintrag noch sichtbar').toBeNull();

    // geändert
    await speichereKonto('4980');
    expect(wert('ausgabe-accounting-account')).toBe('4980');
    expect(q('ausgabe-accounting-reason')).toBeNull();

    // entfernt
    await speichereKonto('');
    expect(wert('ausgabe-accounting-account')).toBe('Noch kein Sachkonto');
    expect(wert('ausgabe-accounting-reason'), 'Hinweis nach Entfernen nicht zurück').toContain(HINWEIS);

    // wieder eingetragen und bestätigt
    await speichereKonto('4930');
    await klick('ausgabe-accounting-confirm');
    expect(wert('ausgabe-accounting-status')).toBe('Bestätigt');
    expect(q('ausgabe-accounting-reason')).toBeNull();

    // Der gespeicherte Vorschlagsgrund bleibt als Herkunft erhalten.
    expect(getAccountingAssignmentForSource('expense', 'exp-ui')!.suggestionReason).toBe(
      'accounting.reason.noAccountCatalog',
    );
  });

  it('nur Leerzeichen gelten nicht als Sachkonto', async () => {
    await zeige(ausgabe());
    await klick('ausgabe-accounting-start');
    await speichereKonto('   ');
    expect(wert('ausgabe-accounting-reason')).toContain(HINWEIS);
  });
});

describe('01H — resolveVisibleSuggestionReason', () => {
  const basis = {
    status: 'needs_review' as const,
    suggestionReason: 'accounting.reason.noAccountCatalog',
    accountNumber: '',
  };

  it('leer: Hinweis sichtbar', () => {
    expect(resolveVisibleSuggestionReason(basis)).toBe('accounting.reason.noAccountCatalog');
  });

  it('eingetragen: kein Hinweis', () => {
    expect(resolveVisibleSuggestionReason({ ...basis, accountNumber: '4930' })).toBeNull();
  });

  it('bestätigt: kein Hinweis', () => {
    expect(
      resolveVisibleSuggestionReason({ ...basis, status: 'confirmed', accountNumber: '4930' }),
    ).toBeNull();
  });

  it('andere Gründe betreffen nicht das Sachkonto und bleiben stehen', () => {
    expect(
      resolveVisibleSuggestionReason({
        status: 'needs_clarification',
        suggestionReason: 'accounting.reason.taxUnclear',
        accountNumber: '4930',
      }),
    ).toBe('accounting.reason.taxUnclear');
  });

  it('ohne Grund: nichts', () => {
    expect(resolveVisibleSuggestionReason({ ...basis, suggestionReason: undefined })).toBeNull();
  });
});
