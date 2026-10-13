/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N06/N09) — Kontierungswahrheit.
 *
 * WEISS N06: Sachkonto 4980 und Steuerbehandlung „unclear" — die Bestätigung gelang,
 * die Steuer blieb ungeklärt; das Panel bot keine Korrektur der Steuer an.
 * WEISS N09: lokale bestätigte und Cloud-„zu prüfen"-Kontierung mit verschiedenen
 * Kennungen für dieselbe Ausgabe — danach zwei Datensätze; das Detail wählte „bestätigt",
 * der Export „zu prüfen" und erzeugte keine Buchung.
 *
 * Nachschärfung (Abnahme in der echten App): Eine eigene Steuerauswahl im Panel erlaubte
 * „19 %" an einer Ausgabe, die selbst „unklar" mit 0 € Steuer sagte — der Export hätte
 * „19 %" ohne Steuerbetrag gebucht. Jetzt gilt eine Steuerwahrheit je Beleg: Die
 * Kontierung folgt dem Steuerstatus des Belegs; geklärt wird am Beleg (samt Beträgen).
 *
 *  S1–S9  Steuer: Bestätigung verlangt geklärte Steuer und denselben Steuerstatus wie der
 *         Beleg; Korrekturweg über den Beleg, Angleichen für Altbestand; eine fachliche
 *         Belegänderung nimmt die Bestätigung zurück, eine redaktionelle nicht; die
 *         Kontierung übernimmt die Steuer des Belegs; Altbestand „bestätigt + unklar" oder
 *         „bestätigt mit anderer Steuer" gilt überall als „zu prüfen"; Vorabprüfung;
 *         die Monatsmappe trägt den Steuerstatus je Beleg
 *  W1–W5  Wahrheit je Beleg: Detail, Übersicht und Export wählen dieselbe Zeile (beide
 *         Reihenfolgen); der Abgleich entfernt die nie übertragene Doppelung und schliesst
 *         ihren Sendeauftrag; verlorene Bestätigung derselben Kennung bleibt; Grabstein
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adoptSourceTaxTreatment,
  confirmAccountingAssignment,
  requireAccountingReviewAfterSourceChange,
} from './accountingAssignmentService';
import { getAccountingAssignmentForSource, getAccountingAssignmentById, setAccountingStoreForTests } from './accountingStore';
import { effectiveAccountingStatus } from './accountingCanonical';
import { findAccountingServerRuleViolation, mergeAccountingFromPull } from './accountingCloudSyncService';
import { applyAccountingPullToState } from './accountingCloudPullService';
import { buildAccountingChecklist } from './accountingOverviewService';
import { buildBookingExport } from './accountingBookingExportService';
import { buildAccountingPeriodState, collectPeriodBlockers } from './accountingPeriodService';
import { buildPeriodManifest } from './accountingPeriodFingerprint';
import { updateExpense } from '../expenseService';
import { hydrateExpenseStore } from '../expenseStore';
import { normalizeExpense } from '../expenseNormalize';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { AccountingAssignmentPanel } from '../../components/accounting/AccountingAssignmentPanel';
import { t, type TranslationKey } from '../../i18n';
import { resetTestStores } from '../../test/resetStores';
import type { AccountingAssignment, AccountingTaxTreatment } from '../../types/accounting';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';
import type { MonatsmappeBeleg, MonatsmappeModel } from '../steuerberater/monatsmappeModelService';

function kontierung(overrides: Partial<AccountingAssignment> = {}): AccountingAssignment {
  return {
    id: 'k1',
    sourceType: 'expense',
    sourceId: 'exp-1',
    chartOfAccounts: 'SKR03',
    accountNumber: '4980',
    accountLabel: 'Betriebsbedarf',
    taxTreatment: 'standard_19',
    bookingText: 'Material',
    status: 'needs_review',
    origin: 'manual',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    ...overrides,
  };
}

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-1',
    title: 'Material',
    issueDate: '2026-09-05',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

function beleg(overrides: Partial<MonatsmappeBeleg> = {}): MonatsmappeBeleg {
  return {
    belegart: 'eingangsbeleg',
    id: 'exp-1',
    belegnummer: 'RE-1',
    datum: '2026-09-05',
    gegenpartei: 'Baustoff Süd GmbH',
    netto: 100,
    steuer: 19,
    brutto: 119,
    status: 'aktiv',
    zahlungsstatus: 'offen',
    zahlungssumme: 0,
    documentStatus: 'archived',
    documents: [],
    ...overrides,
  };
}

function modell(belegOverrides: Partial<MonatsmappeBeleg> = {}): MonatsmappeModel {
  return {
    monthKey: '2026-09',
    ausgangsrechnungen: [],
    eingangsbelege: [beleg(belegOverrides)],
    zahlungenAusgang: [],
    zahlungenEingang: [],
    stornos: [],
    fehlendeDokumente: [],
    stornosOhneDatum: [],
    isEmpty: false,
  };
}

beforeEach(() => {
  resetTestStores();
  setAccountingStoreForTests([]);
});

function zeigePanel(props: { sourceTaxTreatment?: AccountingTaxTreatment; onClarifyTax?: () => void; readOnly?: boolean }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  const zeige = () =>
    root.render(
      <AccountingAssignmentPanel
        assignment={getAccountingAssignmentById('k1')}
        onStart={() => undefined}
        onChanged={() => zeige()}
        translate={(key: TranslationKey) => t(key)}
        testIdPrefix="n06"
        {...props}
      />,
    );
  act(() => {
    root = createRoot(container);
    zeige();
  });
  const q = (id: string) => container.querySelector(`[data-testid="n06-accounting-${id}"]`) as HTMLElement | null;
  const klick = (id: string) => act(() => q(id)!.click());
  const ende = () => {
    act(() => root.unmount());
    container.remove();
  };
  return { q, klick, ende };
}

describe('N06 S — Steuerbehandlung', () => {
  it('S1: mit „unklar" keine Bestätigung; die Kontierung übernimmt die geklärte Steuer des Belegs — nie gegen den Beleg', () => {
    setAccountingStoreForTests([kontierung({ taxTreatment: 'unclear', status: 'needs_clarification', suggestionReason: 'accounting.reason.taxUnclear' })]);
    expect(confirmAccountingAssignment('k1')).toEqual({ success: false, errorKey: 'accounting.confirmNeedsTax' });
    expect(getAccountingAssignmentById('k1')?.status).toBe('needs_clarification');
    // Der Beleg wird geklärt: Die Kontierung folgt ihm, steht „zu prüfen" und nennt den Grund.
    const gefolgt = requireAccountingReviewAfterSourceChange('expense', 'exp-1', { taxTreatment: 'standard_19' })!;
    expect(gefolgt).toMatchObject({ taxTreatment: 'standard_19', status: 'needs_review', suggestionReason: 'accounting.reason.sourceTaxChanged' });
    // Gegen einen anderen Steuerstatus des Belegs wird nicht bestätigt …
    expect(confirmAccountingAssignment('k1', { sourceTaxTreatment: 'standard_7' })).toEqual({
      success: false,
      errorKey: 'accounting.confirmTaxMismatch',
    });
    // … mit demselben schon.
    expect(confirmAccountingAssignment('k1', { sourceTaxTreatment: 'standard_19' }).success).toBe(true);
    expect(getAccountingAssignmentById('k1')?.status).toBe('confirmed');
    expect(t('accounting.confirmNeedsTax')).toContain('Steuerstatus des Belegs');
    expect(t('accounting.confirmTaxMismatch')).toContain('Steuerstatus des Belegs');
  });

  it('S2: das Panel führt keine zweite Steuer; der Korrekturweg führt zum Beleg', () => {
    setAccountingStoreForTests([kontierung({ taxTreatment: 'unclear', status: 'needs_clarification', suggestionReason: 'accounting.reason.taxUnclear' })]);
    let geklaert = 0;
    const p = zeigePanel({ sourceTaxTreatment: 'unclear', onClarifyTax: () => (geklaert += 1) });
    try {
      // Ein Hinweis, nicht zwei: Der Vorschlagsgrund sagt es schon; der Korrekturweg steht daneben.
      expect(p.q('reason')?.textContent).toBe(t('accounting.reason.taxUnclear'));
      expect(p.q('tax-unclear')).toBeNull();
      expect(p.q('tax-mismatch')).toBeNull();
      p.klick('clarify-tax');
      expect(geklaert).toBe(1);
      // Das Formular bietet Konto, Bezeichnung und Buchungstext — keine eigene Steuerauswahl.
      p.klick('edit');
      expect(p.q('form')).not.toBeNull();
      expect(p.q('input-tax')).toBeNull();
      p.klick('cancel');
      // Bestätigen scheitert sichtbar.
      p.klick('confirm');
      expect(p.q('error')?.textContent).toBe(t('accounting.confirmNeedsTax'));
      expect(getAccountingAssignmentById('k1')?.status).toBe('needs_clarification');
    } finally {
      p.ende();
    }
    // Altbestand ohne passenden Vorschlagsgrund: dann steht der eigene Steuerhinweis da.
    setAccountingStoreForTests([kontierung({ taxTreatment: 'unclear', suggestionReason: 'accounting.reason.noAccountCatalog' })]);
    const alt = zeigePanel({ sourceTaxTreatment: 'unclear', onClarifyTax: () => (geklaert += 1) });
    try {
      expect(alt.q('reason')).toBeNull();
      expect(alt.q('tax-unclear')?.textContent).toContain('Steuerstatus des Belegs');
      expect(alt.q('clarify-tax')).not.toBeNull();
    } finally {
      alt.ende();
    }
    // Ohne Korrekturweg (Rechnung, Mitglied) nur der Hinweis, kein Knopf.
    const ohne = zeigePanel({ sourceTaxTreatment: 'unclear' });
    try {
      expect(ohne.q('tax-unclear')).not.toBeNull();
      expect(ohne.q('clarify-tax')).toBeNull();
    } finally {
      ohne.ende();
    }
  });

  it('S2b: Altbestand mit anderer Steuer als der Beleg — „zu prüfen", Angleichen, dann bestätigen', () => {
    setAccountingStoreForTests([kontierung({ status: 'confirmed', confirmedAt: '2026-09-10T10:00:00.000Z' })]);
    const p = zeigePanel({ sourceTaxTreatment: 'standard_7' });
    try {
      expect(p.q('status')?.textContent).toBe(t('accounting.status.needs_review'));
      expect(p.q('tax-mismatch')?.textContent).toContain('weicht vom Steuerstatus des Belegs ab');
      p.klick('confirm');
      expect(p.q('error')?.textContent).toBe(t('accounting.confirmTaxMismatch'));
      p.klick('adopt-tax');
      expect(getAccountingAssignmentById('k1')).toMatchObject({
        taxTreatment: 'standard_7',
        status: 'needs_review',
        suggestionReason: 'accounting.reason.sourceTaxChanged',
        confirmedAt: undefined,
      });
      expect(p.q('tax-mismatch')).toBeNull();
      expect(p.q('reason')?.textContent).toBe(t('accounting.reason.sourceTaxChanged'));
      p.klick('confirm');
      expect(getAccountingAssignmentById('k1')?.status).toBe('confirmed');
      expect(p.q('status')?.textContent).toBe(t('accounting.status.confirmed'));
    } finally {
      p.ende();
    }
    // Mitglied: sieht die Abweichung, aber keinen Knopf.
    setAccountingStoreForTests([kontierung({ status: 'confirmed', confirmedAt: '2026-09-10T10:00:00.000Z' })]);
    const mitglied = zeigePanel({ sourceTaxTreatment: 'standard_7', readOnly: true });
    try {
      expect(mitglied.q('tax-mismatch')).not.toBeNull();
      expect(mitglied.q('adopt-tax')).toBeNull();
    } finally {
      mitglied.ende();
    }
    // Ist der Beleg selbst ungeklärt, geht die angeglichene Kontierung in die Klärung.
    setAccountingStoreForTests([kontierung({ status: 'confirmed', confirmedAt: '2026-09-10T10:00:00.000Z' })]);
    expect(adoptSourceTaxTreatment('k1', 'unclear').success).toBe(true);
    expect(getAccountingAssignmentById('k1')).toMatchObject({
      taxTreatment: 'unclear',
      status: 'needs_clarification',
      suggestionReason: 'accounting.reason.taxUnclear',
    });
  });

  it('S3: eine fachliche Belegänderung nimmt die Bestätigung zurück — mit Hinweis — und die Steuer folgt', () => {
    hydrateExpenseStore([ausgabe()]);
    setAccountingStoreForTests([kontierung({ status: 'confirmed', confirmedAt: '2026-09-10T10:00:00.000Z' })]);
    // Steuerstatus und Beträge stimmig geändert (19 % → 7 %).
    expect(updateExpense('exp-1', { taxStatus: 'standard_7', taxAmount: 7, grossAmount: 107 }).success).toBe(true);
    const danach = getAccountingAssignmentForSource('expense', 'exp-1')!;
    expect(danach.status).toBe('needs_review');
    expect(danach.confirmedAt).toBeUndefined();
    expect(danach.suggestionReason).toBe('accounting.reason.sourceChanged');
    expect(danach.taxTreatment).toBe('standard_7');
  });

  it('S3b: am Beleg geklärt (unklar → 19 % samt Beträgen) — die Kontierung folgt und ist bestätigbar', () => {
    hydrateExpenseStore([ausgabe({ taxStatus: 'unclear', netAmount: 119, taxAmount: 0, grossAmount: 119 })]);
    setAccountingStoreForTests([
      kontierung({ taxTreatment: 'unclear', status: 'needs_clarification', suggestionReason: 'accounting.reason.taxUnclear' }),
    ]);
    expect(updateExpense('exp-1', { taxStatus: 'standard_19', netAmount: 100, taxAmount: 19, grossAmount: 119 }).success).toBe(true);
    const danach = getAccountingAssignmentForSource('expense', 'exp-1')!;
    expect(danach).toMatchObject({ taxTreatment: 'standard_19', status: 'needs_review', suggestionReason: 'accounting.reason.sourceTaxChanged' });
    expect(confirmAccountingAssignment('k1', { sourceTaxTreatment: 'standard_19' }).success).toBe(true);
    // Und zurück auf „unklar": wieder in die Klärung, die Bestätigung fällt.
    expect(updateExpense('exp-1', { taxStatus: 'unclear', netAmount: 119, taxAmount: 0, grossAmount: 119 }).success).toBe(true);
    expect(getAccountingAssignmentForSource('expense', 'exp-1')).toMatchObject({
      taxTreatment: 'unclear',
      status: 'needs_clarification',
      suggestionReason: 'accounting.reason.taxUnclear',
      confirmedAt: undefined,
    });
  });

  it('S4: eine redaktionelle Änderung (Titel) lässt die Bestätigung stehen — gleicht aber Altbestand an', () => {
    hydrateExpenseStore([ausgabe()]);
    setAccountingStoreForTests([kontierung({ status: 'confirmed', confirmedAt: '2026-09-10T10:00:00.000Z' })]);
    expect(updateExpense('exp-1', { title: 'Material Baustelle Nord' }).success).toBe(true);
    expect(getAccountingAssignmentForSource('expense', 'exp-1')?.status).toBe('confirmed');
    // Ohne bestätigte Kontierung und ohne Steuerabweichung tut der Rückfall nichts.
    setAccountingStoreForTests([kontierung({ status: 'needs_review' })]);
    expect(requireAccountingReviewAfterSourceChange('expense', 'exp-1')).toBeNull();
    expect(requireAccountingReviewAfterSourceChange('expense', 'exp-1', { taxTreatment: 'standard_19' })).toBeNull();
    // Altbestand: bestätigt mit 7 %, der Beleg sagt 19 % — schon das Speichern gleicht an.
    setAccountingStoreForTests([
      kontierung({ status: 'confirmed', taxTreatment: 'standard_7', confirmedAt: '2026-09-10T10:00:00.000Z' }),
    ]);
    expect(updateExpense('exp-1', { title: 'Material Baustelle Süd' }).success).toBe(true);
    expect(getAccountingAssignmentForSource('expense', 'exp-1')).toMatchObject({
      taxTreatment: 'standard_19',
      status: 'needs_review',
      suggestionReason: 'accounting.reason.sourceTaxChanged',
    });
    // Eine andere offene Frage (Gutschrift) bleibt stehen, die Steuer folgt trotzdem.
    setAccountingStoreForTests([
      kontierung({ status: 'needs_clarification', taxTreatment: 'standard_7', suggestionReason: 'accounting.reason.expenseCreditNote' }),
    ]);
    expect(requireAccountingReviewAfterSourceChange('expense', 'exp-1', { taxTreatment: 'standard_19', changed: false })).toMatchObject({
      taxTreatment: 'standard_19',
      status: 'needs_clarification',
      suggestionReason: 'accounting.reason.expenseCreditNote',
    });
  });

  it('S5: Altbestand „bestätigt + unklar" — Übersicht, Export und Monatsabschluss sehen „zu prüfen"', () => {
    const alt = kontierung({ status: 'confirmed', taxTreatment: 'unclear', confirmedAt: '2026-09-10T10:00:00.000Z' });
    expect(effectiveAccountingStatus(alt)).toBe('needs_review');
    const liste = buildAccountingChecklist(modell(), [alt], 'SKR03');
    expect(liste.confirmedCount).toBe(0);
    expect(liste.needsReviewCount).toBe(1);
    expect(buildBookingExport(modell(), [alt], 'SKR03').rows).toHaveLength(0);
    const blocker = collectPeriodBlockers(buildPeriodManifest(modell(), [alt], 'SKR03'));
    expect(blocker.find((b) => b.code === 'needs_review')?.sourceIds).toEqual(['exp-1']);
    // Mit geklärter Steuer wird gebucht.
    const sauber = { ...alt, taxTreatment: 'standard_19' as const };
    expect(buildBookingExport(modell(), [sauber], 'SKR03').rows).toHaveLength(1);
  });

  it('S5b: „bestätigt" mit anderer Steuer als der Beleg — Übersicht, Export und Monatsabschluss sehen „zu prüfen"', () => {
    const bestaetigt = kontierung({ status: 'confirmed', confirmedAt: '2026-09-10T10:00:00.000Z' });
    for (const steuerstatus of ['unclear', 'standard_7'] as const) {
      const m = modell({ steuerstatus });
      expect(effectiveAccountingStatus(bestaetigt, steuerstatus)).toBe('needs_review');
      expect(buildAccountingChecklist(m, [bestaetigt], 'SKR03')).toMatchObject({ confirmedCount: 0, needsReviewCount: 1 });
      expect(buildBookingExport(m, [bestaetigt], 'SKR03').rows).toHaveLength(0);
      const zustand = buildAccountingPeriodState(m, [bestaetigt], 'SKR03', []);
      expect(zustand.blockers.find((b) => b.code === 'needs_review')?.sourceIds).toEqual(['exp-1']);
      expect(zustand.readiness).toBe('not_ready');
    }
    // Derselbe Steuerstatus: gebucht, bereit — und der Fingerprint hängt nicht am neuen Feld.
    const gleich = modell({ steuerstatus: 'standard_19' });
    expect(buildBookingExport(gleich, [bestaetigt], 'SKR03').rows).toHaveLength(1);
    expect(buildAccountingPeriodState(gleich, [bestaetigt], 'SKR03', []).readiness).toBe('ready');
    expect(buildAccountingPeriodState(gleich, [bestaetigt], 'SKR03', []).currentFingerprint).toBe(
      buildAccountingPeriodState(modell(), [bestaetigt], 'SKR03', []).currentFingerprint,
    );
  });

  it('S6: die Vorabprüfung sendet keine Bestätigung mit ungeklärter Steuer', () => {
    expect(
      findAccountingServerRuleViolation(kontierung({ status: 'confirmed', taxTreatment: 'unclear', confirmedAt: '2026-09-10T10:00:00.000Z' })),
    ).toBe('confirmed_without_tax');
    expect(
      findAccountingServerRuleViolation(kontierung({ status: 'confirmed', confirmedAt: '2026-09-10T10:00:00.000Z' })),
    ).toBeNull();
  });

  it('S9: die Monatsmappe trägt den Steuerstatus je Beleg — auch an Stornos', () => {
    const rechnung = {
      id: 'inv-s9',
      number: '2026-0901',
      type: 'rechnung',
      positions: [],
      subtotal: 100,
      taxStatus: 'reverse_charge_13b',
      amount: 100,
      status: 'versendet',
      date: '2026-09-10',
      issueDate: '2026-09-10',
      createdAt: '2026-09-10T10:00:00.000Z',
      customerSnapshot: { name: 'Muster GmbH', contactPerson: '', street: 'Weg 1', zip: '33602', city: 'Bielefeld', email: '', phone: '' },
      legalNotices: [],
      previousAbschlagDeductions: [],
      payments: [],
      paymentStatus: 'storniert',
      cancelledAt: '2026-09-20T10:00:00.000Z',
      cancellationKind: 'correction',
    } as unknown as VorgangInvoice;
    const storniert = ausgabe({
      id: 'exp-s9',
      invoiceNumber: 'RE-S9',
      taxStatus: 'standard_7',
      netAmount: 100,
      taxAmount: 7,
      grossAmount: 107,
      status: 'storniert',
      cancelledAt: '2026-09-25T10:00:00.000Z',
    });
    const m = buildMonatsmappeModel({
      monthKey: '2026-09',
      invoices: [{ invoice: rechnung, vorgangId: 'v-s9' }],
      expenses: [ausgabe(), storniert],
      documents: [],
      inboxItems: [],
      fileRefs: [],
    });
    const steuer = (liste: MonatsmappeBeleg[]) => liste.map((b) => [b.belegart, b.id, b.steuerstatus]);
    expect(steuer(m.ausgangsrechnungen)).toEqual([['ausgangsrechnung', 'inv-s9', 'reverse_charge_13b']]);
    expect(steuer(m.eingangsbelege)).toEqual(
      expect.arrayContaining([
        ['eingangsbeleg', 'exp-1', 'standard_19'],
        ['eingangsbeleg', 'exp-s9', 'standard_7'],
      ]),
    );
    expect(steuer(m.stornos)).toEqual(
      expect.arrayContaining([
        ['rechnungsstorno', 'inv-s9', 'reverse_charge_13b'],
        ['ausgabenstorno', 'exp-s9', 'standard_7'],
      ]),
    );
  });
});

describe('N09 W — eine Wahrheit je Beleg', () => {
  const syncMeta = (version: number) => ({
    updatedAt: '2026-09-20T10:00:00.000Z',
    version,
    deleted: false,
    deviceId: 'device-n09',
    workspaceId: 'ws-n09',
  });
  const LOKAL_BESTAETIGT = kontierung({
    id: 'k-lokal',
    status: 'confirmed',
    confirmedAt: '2026-09-21T10:00:00.000Z',
    updatedAt: '2026-09-21T10:00:00.000Z',
  });
  const CLOUD_ZU_PRUEFEN = kontierung({ id: 'k-cloud', status: 'needs_review', sync: syncMeta(1) });

  it('W1: Detail, Übersicht und Export wählen dieselbe Zeile — in beiden Reihenfolgen', () => {
    for (const reihenfolge of [
      [LOKAL_BESTAETIGT, CLOUD_ZU_PRUEFEN],
      [CLOUD_ZU_PRUEFEN, LOKAL_BESTAETIGT],
    ]) {
      setAccountingStoreForTests(reihenfolge);
      expect(getAccountingAssignmentForSource('expense', 'exp-1')?.id).toBe('k-cloud');
      const liste = buildAccountingChecklist(modell(), reihenfolge, 'SKR03');
      expect(liste.confirmedCount).toBe(0);
      expect(liste.needsReviewCount).toBe(1);
      // Der Export folgt derselben Wahl: „zu prüfen" bucht nicht — und das Detail zeigt das auch.
      expect(buildBookingExport(modell(), reihenfolge, 'SKR03').rows).toHaveLength(0);
    }
  });

  function zeile(a: AccountingAssignment, rowVersion: number, deleted = false) {
    const { sync: _sync, id, sourceType, sourceId, ...payload } = a;
    return {
      client_assignment_id: id,
      source_type: sourceType,
      source_id: sourceId,
      payload: { ...payload, id, sourceType, sourceId },
      row_version: rowVersion,
      deleted,
      updated_at: '2026-09-22T10:00:00.000Z',
    } as never;
  }

  it('W2: der Abgleich entfernt die nie übertragene Doppelung und meldet sie', () => {
    const merged = mergeAccountingFromPull([LOKAL_BESTAETIGT], { assignments: [zeile(CLOUD_ZU_PRUEFEN, 1)] }, new Set(['k-lokal']));
    expect(merged.assignments.map((a) => a.id)).toEqual(['k-cloud']);
    expect(merged.superseded).toEqual(['k-lokal']);
    expect(merged.conflicts).toContain('k-lokal');
  });

  it('W3: der Sendeauftrag der Doppelung wird im Kandidaten abgeschlossen', () => {
    const auftrag = {
      id: 'out-k-lokal',
      entityType: 'accounting_assignment',
      entityId: 'k-lokal',
      operation: 'create',
      version: 0,
      queuedAt: '2026-09-21T10:00:00.000Z',
      retryCount: 1,
      status: 'error',
    } as SyncOutboxEntry;
    const state = { ...buildPersistedStateSnapshot(), accountingAssignments: [LOKAL_BESTAETIGT], syncOutbox: [auftrag] };
    const applied = applyAccountingPullToState(
      state,
      { assignments: { assignments: [zeile(CLOUD_ZU_PRUEFEN, 1)] }, closures: { closures: [] } as never },
      { deviceId: 'device-n09', workspaceId: 'ws-n09', outbox: [auftrag] },
    );
    expect(applied.state.accountingAssignments?.map((a) => a.id)).toEqual(['k-cloud']);
    expect(applied.state.syncOutbox?.find((e) => e.id === 'out-k-lokal')?.status).toBe('completed');
    expect(applied.conflicts).toContain('accounting_assignment:k-lokal');
  });

  it('W4: dieselbe Kennung (verlorene Bestätigung) ist keine Doppelung', () => {
    const merged = mergeAccountingFromPull([LOKAL_BESTAETIGT], { assignments: [zeile(LOKAL_BESTAETIGT, 1)] }, new Set());
    expect(merged.superseded).toEqual([]);
    expect(merged.assignments.map((a) => a.id)).toEqual(['k-lokal']);
  });

  it('W5: ein Grabstein der Cloud-Zeile lässt eine neue lokale Kontierung stehen', () => {
    const merged = mergeAccountingFromPull(
      [LOKAL_BESTAETIGT],
      { assignments: [zeile(CLOUD_ZU_PRUEFEN, 2, true)] },
      new Set(['k-lokal']),
    );
    expect(merged.superseded).toEqual([]);
    expect(merged.assignments.map((a) => a.id)).toEqual(['k-lokal']);
  });
});

afterEach(() => {
  setAccountingStoreForTests([]);
});
