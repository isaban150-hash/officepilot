/**
 * STEUERBERATER-06B — Bereitschaft, Abschluss und Wiederöffnung eines Monats.
 *
 * Die zentrale Zusage dieses Moduls: **Ein Abschluss behauptet nie mehr, als er
 * weiss.** Passt der gespeicherte Fingerprint nicht mehr zum heutigen Stand,
 * sagt `getAccountingPeriodState` das — es bleibt nicht bei „Abgeschlossen".
 *
 * Was hier **nicht** passiert: Es wird kein Beleg gesperrt. Der Betrieb kann
 * nach einem Abschluss weiterhin stornieren, korrigieren und zahlen; diese
 * Workflows gehören ihm. Der Abschluss erkennt die Folge, statt die Ursache zu
 * verbieten — ein Hard-Lock quer durch Rechnungs- und Ausgabendienste wäre eine
 * grosse, riskante Umbauaktion für einen kleineren Nutzen.
 *
 * Und es wird nichts versprochen, was die Software nicht hält: keine
 * Festschreibung, keine GoBD-Zusage, keine Rechtssicherheit.
 */
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { collectMonatsmappeInput } from '../steuerberater/monatsmappeInputService';
import { getAllAccountingAssignments } from './accountingStore';
import { getChartOfAccounts } from './accountingSettingsService';
import { isAccountingTaxInLineWithSource } from './accountingCanonical';
import {
  buildPeriodFingerprint,
  buildPeriodManifest,
  closureFingerprintVersion,
} from './accountingPeriodFingerprint';
import {
  appendAccountingPeriodClosure,
  getActiveClosureForMonth,
  getClosuresForMonth,
  markClosureReopened,
  revertUnsavedAccountingPeriodClosure,
} from './accountingPeriodStore';
import { buildClosureRevisionStatusMap, isActiveClosure, isClosureCloudMode } from './accountingPeriodRevisionStatus';
import { auditExpenseMoneyIntegrity } from '../expense/expenseMoneyIntegrity';
import { getAllExpensesFromStore } from '../expenseStore';
import { generateUuid } from '../sync/syncMetaService';
import { getLastPersistSuccess, persistAll } from '../persistenceService';
import { enqueueSyncOutbox, getSyncOutboxSnapshot, hydrateSyncOutbox } from '../sync/syncOutboxService';
import { listInvoiceEntries } from '../invoice/invoiceRegistryService';
import { getEmployeePaymentStoreSnapshot } from '../employee/employeeStore';
import { getUnconfirmedInvoicePaymentKeys } from '../invoice/invoicePaymentConfirmationStore';
import {
  collectUnconfirmedFinancialSources,
  type UnconfirmedFinancialSource,
  type UnconfirmedSourceInputs,
} from './unconfirmedFinancialSources';
import type { SyncOutboxEntry } from '../../types/sync';
import type { Expense } from '../../types/expense';
import type { MonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import type { AccountingAssignment } from '../../types/accounting';
import type {
  AccountingPeriodBlocker,
  AccountingPeriodBlockerCode,
  AccountingPeriodClosure,
  AccountingPeriodManifest,
  AccountingPeriodReadiness,
  AccountingPeriodState,
} from '../../types/accountingPeriod';

/* -------------------------------------------------------------------------- */
/* Bereitschaft                                                               */
/* -------------------------------------------------------------------------- */

function blocker(
  code: AccountingPeriodBlockerCode,
  sourceIds: readonly string[],
): AccountingPeriodBlocker | null {
  /*
   * 02B — je Quelle genau einmal. Original und Storno derselben Rechnung sind
   * zwei Manifest-Einträge, teilen sich aber eine Kontierung; ein fehlender
   * Kontierungsschritt ist ein offener Punkt, nicht zwei.
   */
  const unique = [...new Set(sourceIds)];
  if (unique.length === 0) return null;
  return { code, count: unique.length, sourceIds: unique };
}

/**
 * Was einen Abschluss verhindert.
 *
 * Blockiert wird, was die **Buchung** unvollständig oder widersprüchlich
 * macht: fehlende, ungeprüfte oder unklare Kontierungen, eine Bestätigung ohne
 * Sachkonto, und widersprüchliche Beträge (05B).
 *
 * Bewusst **nicht** dabei:
 *
 *   - **Fehlende Originaldokumente und Stornos ohne Stornodatum.** Beides
 *     kennt die Monatsmappe längst und führt es ausdrücklich als „sichtbar,
 *     nie still" — sie zeigt es an, blockiert den Export aber nicht. Daraus
 *     hier einen harten Blocker zu machen wäre eine strengere Regel, als das
 *     Produkt sie kennt; ein Stornodatum, das im Datenmodell fehlt, kann der
 *     Nutzer ausserdem gar nicht nachtragen. Ein Blocker, den niemand lösen
 *     kann, ist eine Sackgasse.
 *   - **Ein globaler Sync-Fehler ohne Bezug zu diesem Monat.** Ein Abschluss
 *     ist eine fachliche Feststellung über Belege; ihn an einer fremden
 *     Übertragungsstörung scheitern zu lassen, hiesse den Nutzer für etwas
 *     haftbar zu machen, das mit seinem September nichts zu tun hat. Die
 *     Cloud-Sicherung des Abschlusses selbst läuft über den normalen Sync und
 *     meldet sich dort.
 */
export function collectPeriodBlockers(
  manifest: AccountingPeriodManifest,
  /**
   * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — der Steuerstatus je Beleg (`sourceType:sourceId`),
   * soweit bekannt. Eine Bestätigung mit anderer Steuer als der Beleg ist noch zu prüfen.
   */
  sourceTaxBySource: ReadonlyMap<string, string> = new Map(),
  /**
   * FINANZ-CORE-01A (END18-R3, Bericht 20) — Quellen mit Finanzwirkung in diesem Monat, die der Server noch nicht
   * bestätigt hat (`collectUnconfirmedFinancialSources`). Sie sind vorläufig, nicht abschliessbar.
   */
  unconfirmedSourceIds: readonly string[] = [],
): AccountingPeriodBlocker[] {
  const unassigned: string[] = [];
  const needsReview: string[] = [];
  const needsClarification: string[] = [];
  const confirmedWithoutAccount: string[] = [];

  for (const entry of manifest.entries) {
    switch (entry.assignmentStatus) {
      case 'none':
        unassigned.push(entry.sourceId);
        break;
      case 'needs_review':
        needsReview.push(entry.sourceId);
        break;
      case 'needs_clarification':
        needsClarification.push(entry.sourceId);
        break;
      case 'confirmed':
        /*
         * Sollte es nicht geben — Dienst und Server weisen es ab (06A). Hier
         * steht es trotzdem, weil ein Altbestand oder ein fremder Schreibweg
         * so etwas hinterlassen könnte, und ein Abschluss darüber nicht
         * hinweggehen darf.
         */
        if (!entry.accountNumber.trim()) confirmedWithoutAccount.push(entry.sourceId);
        // FINANZ-CORE-01A (WEISS N06) — eine Bestätigung mit ungeklärter oder anderer Steuer als der Beleg ist noch zu prüfen.
        else if (
          !isAccountingTaxInLineWithSource(
            entry.taxTreatment,
            sourceTaxBySource.get(`${entry.sourceType}:${entry.sourceId}`),
          )
        ) {
          needsReview.push(entry.sourceId);
        }
        break;
      default:
        break;
    }
  }

  /*
   * Die Geldintegrität aus 05B — aber nur für Belege **dieses** Monats. Ein
   * widersprüchlicher Beleg aus dem Vorjahr blockiert den September nicht.
   */
  const monthExpenseIds = new Set(
    manifest.entries.filter((entry) => entry.sourceType === 'expense').map((entry) => entry.sourceId),
  );
  const audit = auditExpenseMoneyIntegrity(
    getAllExpensesFromStore().filter((expense) => monthExpenseIds.has(expense.id)),
  );

  return [
    blocker('unassigned_documents', unassigned),
    blocker('needs_review', needsReview),
    blocker('needs_clarification', needsClarification),
    blocker('confirmed_without_account', confirmedWithoutAccount),
    blocker('money_integrity', audit.invalid.map((entry) => entry.id)),
    blocker('unconfirmed_financial_changes', unconfirmedSourceIds),
  ].filter((item): item is AccountingPeriodBlocker => item !== null);
}

function resolveReadiness(
  manifest: AccountingPeriodManifest,
  blockers: readonly AccountingPeriodBlocker[],
  activeClosure: AccountingPeriodClosure | null,
  fingerprint: string,
): AccountingPeriodReadiness {
  if (activeClosure) {
    /*
     * Ein Abschluss, zu dem die Daten nicht mehr passen, bleibt nicht einfach
     * „abgeschlossen". Genau das ist der Punkt des Blocks.
     */
    return activeClosure.fingerprint === fingerprint ? 'closed' : 'changed_after_close';
  }
  if (blockers.length > 0) return 'not_ready';
  /*
   * Ein Monat ohne steuerlich relevante Belege ist nicht „bereit", sondern
   * schlicht leer. Er lässt sich abschliessen (siehe `closeAccountingPeriod`),
   * aber die Oberfläche soll ihn nicht als geprüften Stand anpreisen.
   */
  if (manifest.documentCount === 0) return 'open';
  return 'ready';
}

/* -------------------------------------------------------------------------- */
/* Zustand                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Der vollständige Stand eines Monats — die API für den DATEV-Block (06C).
 *
 * `model` und `assignments` sind überschreibbar, damit die Funktion rein
 * prüfbar bleibt; ohne Angabe kommen sie aus dem Bestand.
 */
export function buildAccountingPeriodState(
  model: MonatsmappeModel,
  assignments: readonly AccountingAssignment[] = getAllAccountingAssignments(),
  chartOfAccounts = getChartOfAccounts(),
  closures: readonly AccountingPeriodClosure[] = getClosuresForMonth(model.monthKey),
  outbox: readonly SyncOutboxEntry[] = getSyncOutboxSnapshot(),
  /** Bericht 20 — die ungefilterten Bestände für die Abschlusssperre; ohne Angabe aus dem Gerät. */
  sources: Partial<Omit<UnconfirmedSourceInputs, 'outbox' | 'assignments'>> = {},
  /** Systemische Gesamtnacharbeit (D1) — Betrieb mit Cloud? Ohne Angabe aus der Konfiguration. */
  cloudMode: boolean = isClosureCloudMode(),
): AccountingPeriodState {
  // Systemische Gesamtnacharbeit (D7) — eine vom Server abgewiesene Revision ist kein aktiver Abschluss.
  const activeClosure = closures.find(isActiveClosure) ?? null;
  /*
   * P0/P1-INTEGRITAET 01B / P2 — ein aktiver Abschluss wird nach dem
   * Algorithmus geprüft, mit dem er entstand. Ein alter Abschluss (Version 1,
   * ohne Zahlungen) bleibt so gültig, solange sich seine Belege nicht ändern;
   * jeder neue Abschluss entsteht mit Version 3 (P1 MITARBEITERZAHLUNGEN: samt
   * Mitarbeiterzahlungen); Abschlüsse der Version 2 bleiben nach Version 2 gültig.
   */
  const manifest = buildPeriodManifest(
    model,
    assignments,
    chartOfAccounts,
    // FINANZ-CORE-01A (Gesamtnacharbeit INV-04) — neue Abschlüsse mit Version 4 (Skonto und Zahlungsart gebunden).
    // Systemische Gesamtnacharbeit — neue Revisionen mit Fassung 5 (servervalidiert, inkl. kumulierter offener Posten).
    activeClosure ? closureFingerprintVersion(activeClosure) : 5,
  );
  const fingerprint = buildPeriodFingerprint(manifest);
  const unconfirmedSources = collectUnconfirmedFinancialSources(model.monthKey, {
    outbox,
    assignments,
    expenses: sources.expenses ?? getAllExpensesFromStore(),
    employeePayments: sources.employeePayments ?? getEmployeePaymentStoreSnapshot(),
    invoices: sources.invoices ?? listInvoiceEntries().map((entry) => entry.invoice),
    unconfirmedInvoicePayments: sources.unconfirmedInvoicePayments ?? getUnconfirmedInvoicePaymentKeys(),
    // Systemische Gesamtnacharbeit (SYS-02 / D4) — im Cloudbetrieb nur positive Serverbestätigung.
    cloudMode,
  });
  const blockers = [
    ...collectPeriodBlockers(manifest, sourceTaxOf(model), unconfirmedSources.map((source) => source.sourceId)),
    /*
     * Systemische Gesamtnacharbeit (SYS-02 / D5) — das letzte Speichern ist gescheitert: Der Bestand im Speicher ist
     * dann weder gesichert noch eingereiht (die Persistenz nimmt den Sendeauftrag zurück). Darauf wird weder
     * abgeschlossen noch übergeben, bis wieder erfolgreich gespeichert wurde.
     */
    ...(getLastPersistSuccess() ? [] : [{ code: 'persist_failed' as const, count: 1, sourceIds: [] as string[] }]),
  ];
  const revisionStatus = buildClosureRevisionStatusMap(closures, { cloudMode, outbox });

  return {
    monthKey: model.monthKey,
    unconfirmedSources,
    readiness: resolveReadiness(manifest, blockers, activeClosure, fingerprint),
    blockers,
    currentFingerprint: fingerprint,
    currentManifest: manifest,
    activeClosure,
    isCurrentClosureValid: activeClosure !== null && activeClosure.fingerprint === fingerprint,
    revisionHistory: [...closures].sort((a, b) => b.revision - a.revision),
    activeClosureStatus: activeClosure ? revisionStatus[activeClosure.id] ?? null : null,
    revisionStatus,
  };
}

/**
 * FINANZ-CORE-01A (END18-R3) — Ausgaben dieses Monats, deren Finanzstand der Server noch nicht bestätigt hat.
 *
 * Bericht 20 (END19-R1/R2): Die Zugehörigkeit kam früher aus dem Manifest — also aus der bereits gefilterten
 * Monatsmappe, in der ein lokaler Grabstein oder eine nie angenommene Zahlung schon fehlte. Jetzt nur noch eine
 * Sicht auf den zentralen Vertrag `collectUnconfirmedFinancialSources` (ungefilterte Ausgaben, Monate aus Fakten
 * und Aufträgen, Rechteabweisungen eingeschlossen), beschränkt auf Ausgaben.
 */
export function collectUnconfirmedExpenseSources(
  manifest: AccountingPeriodManifest,
  outbox: readonly SyncOutboxEntry[] = getSyncOutboxSnapshot(),
  expenses: readonly Expense[] = getAllExpensesFromStore(),
): string[] {
  const quellen = collectUnconfirmedFinancialSources(manifest.monthKey, {
    outbox,
    expenses,
    employeePayments: [],
    assignments: [],
    invoices: [],
    unconfirmedInvoicePayments: new Set(),
  });
  return [...new Set(quellen.filter((quelle) => quelle.sourceType === 'expense').map((quelle) => quelle.sourceId))];
}

export type { UnconfirmedFinancialSource };

/** FINANZ-CORE-01A (WEISS-Nacharbeit N06) — der Steuerstatus je Beleg des Monats. */
function sourceTaxOf(model: MonatsmappeModel): Map<string, string> {
  const bySource = new Map<string, string>();
  for (const beleg of [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos]) {
    if (!beleg.steuerstatus) continue;
    const sourceType =
      beleg.belegart === 'ausgangsrechnung' || beleg.belegart === 'rechnungsstorno' ? 'invoice' : 'expense';
    bySource.set(`${sourceType}:${beleg.id}`, beleg.steuerstatus);
  }
  return bySource;
}

/** Bequemer Zugriff über den Monatsschlüssel (`YYYY-MM`). */
export function getAccountingPeriodState(monthKey: string): AccountingPeriodState {
  const model = buildMonatsmappeModel(collectMonatsmappeInput(monthKey));
  return buildAccountingPeriodState(model);
}

/* -------------------------------------------------------------------------- */
/* Abschliessen und wieder öffnen                                             */
/* -------------------------------------------------------------------------- */

export type AccountingPeriodResult =
  | { success: true; closure: AccountingPeriodClosure; noop: boolean }
  | { success: false; errorKey: string; blockers?: readonly AccountingPeriodBlocker[] };

export interface CloseAccountingPeriodOptions {
  closedBy?: string;
}

function enqueue(closure: AccountingPeriodClosure, operation: 'create' | 'update'): void {
  enqueueSyncOutbox({
    entityType: 'accounting_period_closure',
    entityId: closure.id,
    operation,
    version: 1,
  });
}

/**
 * Schliesst einen Monat ab.
 *
 * Abgewiesen wird, was blockiert — die Bereitschaft ist abgeleitet und lässt
 * sich nicht von Hand setzen. Ein bereits offener Abschluss mit **demselben**
 * Stand ist ein Replay und erzeugt keine zweite Revision; ein anderer Stand
 * verlangt erst eine bewusste Wiederöffnung. Beides prüft der Server ebenso.
 */
export function closeAccountingPeriod(
  monthKey: string,
  options: CloseAccountingPeriodOptions = {},
): AccountingPeriodResult {
  const state = getAccountingPeriodState(monthKey);

  if (state.blockers.length > 0) {
    return { success: false, errorKey: 'accountingPeriod.notReady', blockers: state.blockers };
  }

  const active = getActiveClosureForMonth(monthKey);
  if (active) {
    if (active.fingerprint === state.currentFingerprint) {
      // Derselbe Stand — nichts Neues festzuhalten.
      return { success: true, closure: active, noop: true };
    }
    return { success: false, errorKey: 'accountingPeriod.alreadyClosed' };
  }

  const timestamp = new Date().toISOString();
  const revision =
    getClosuresForMonth(monthKey).reduce((max, item) => Math.max(max, item.revision), 0) + 1;

  const closure: AccountingPeriodClosure = {
    id: generateUuid(),
    monthKey,
    revision,
    closedAt: timestamp,
    closedBy: options.closedBy,
    fingerprint: state.currentFingerprint,
    manifest: state.currentManifest,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const postausgangVorher = getSyncOutboxSnapshot();
  const stored = appendAccountingPeriodClosure(closure);
  enqueue(stored, 'create');
  /*
   * Systemische Gesamtnacharbeit (SYS-02 / D5) — gilt nur, was gespeichert ist. Scheitert das Speichern, nimmt die
   * Persistenz den Sendeauftrag zurück; hier geht die ungespeicherte Revision mit. Kein Abschluss, der nur im
   * Arbeitsspeicher stünde und nie gesendet würde.
   */
  if (!persistAll().success) {
    revertUnsavedAccountingPeriodClosure(stored.id, null);
    // Die Persistenz setzt den Postausgang nur auf den Stand vor ihrem Aufruf zurück — der Auftrag kam davor.
    hydrateSyncOutbox(postausgangVorher);
    return { success: false, errorKey: 'accountingPeriod.persistFailed' };
  }
  return { success: true, closure: stored, noop: false };
}

export interface ReopenAccountingPeriodOptions {
  reopenedBy?: string;
  reason?: string;
}

/**
 * Öffnet einen abgeschlossenen Monat wieder.
 *
 * Der bisherige Abschluss bleibt vollständig erhalten — Fingerprint, Manifest,
 * Zeitpunkt und Revisionsnummer. Er bekommt nur eine Öffnungsspur. Ein
 * erneuter Abschluss entsteht als **neue** Revision daneben.
 */
export function reopenAccountingPeriod(
  monthKey: string,
  options: ReopenAccountingPeriodOptions = {},
): AccountingPeriodResult {
  const active = getActiveClosureForMonth(monthKey);
  if (!active) {
    return { success: false, errorKey: 'accountingPeriod.notClosed' };
  }

  const timestamp = new Date().toISOString();
  const postausgangVorher = getSyncOutboxSnapshot();
  const reopened = markClosureReopened(
    active.id,
    timestamp,
    options.reopenedBy,
    options.reason?.trim() || undefined,
  );
  if (!reopened) return { success: false, errorKey: 'accountingPeriod.notClosed' };

  enqueue(reopened, 'update');
  // Systemische Gesamtnacharbeit (SYS-02 / D5) — ungespeichert ist die Wiederöffnung nicht geschehen.
  if (!persistAll().success) {
    revertUnsavedAccountingPeriodClosure(active.id, active);
    hydrateSyncOutbox(postausgangVorher);
    return { success: false, errorKey: 'accountingPeriod.persistFailed' };
  }
  return { success: true, closure: reopened, noop: false };
}
