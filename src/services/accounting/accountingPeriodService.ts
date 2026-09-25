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
import { buildPeriodFingerprint, buildPeriodManifest } from './accountingPeriodFingerprint';
import {
  appendAccountingPeriodClosure,
  getActiveClosureForMonth,
  getClosuresForMonth,
  markClosureReopened,
} from './accountingPeriodStore';
import { auditExpenseMoneyIntegrity } from '../expense/expenseMoneyIntegrity';
import { getAllExpensesFromStore } from '../expenseStore';
import { generateUuid } from '../sync/syncMetaService';
import { persistAll } from '../persistenceService';
import { enqueueSyncOutbox } from '../sync/syncOutboxService';
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
  if (sourceIds.length === 0) return null;
  return { code, count: sourceIds.length, sourceIds: [...sourceIds] };
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
): AccountingPeriodState {
  const manifest = buildPeriodManifest(model, assignments, chartOfAccounts);
  const fingerprint = buildPeriodFingerprint(manifest);
  const blockers = collectPeriodBlockers(manifest);
  const activeClosure = closures.find((item) => !item.reopenedAt) ?? null;

  return {
    monthKey: model.monthKey,
    readiness: resolveReadiness(manifest, blockers, activeClosure, fingerprint),
    blockers,
    currentFingerprint: fingerprint,
    currentManifest: manifest,
    activeClosure,
    isCurrentClosureValid: activeClosure !== null && activeClosure.fingerprint === fingerprint,
    revisionHistory: [...closures].sort((a, b) => b.revision - a.revision),
  };
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

  const stored = appendAccountingPeriodClosure(closure);
  enqueue(stored, 'create');
  persistAll();
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
  const reopened = markClosureReopened(
    active.id,
    timestamp,
    options.reopenedBy,
    options.reason?.trim() || undefined,
  );
  if (!reopened) return { success: false, errorKey: 'accountingPeriod.notClosed' };

  enqueue(reopened, 'update');
  persistAll();
  return { success: true, closure: reopened, noop: false };
}
