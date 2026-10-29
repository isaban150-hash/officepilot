/**
 * REAL-PRODUCT-TEST-01B — eine fachliche Wahrheit für die Monatsübersicht.
 *
 * Die sichtbaren Monatszahlen (Steuerberater-Seite, Heute-Karte, Hinweise)
 * kommen aus demselben Modell wie die tatsächliche Monatsmappe
 * (`collectMonatsmappeInput` → `buildMonatsmappeModel`): finalisierte
 * Ausgangsrechnungen, gebuchte Ausgaben, Stornos/Korrekturen — je im Monat
 * ihres kanonischen Datums. Vorher zählte diese Übersicht nur aktive
 * Eingangsposten; archivierte Belege und erzeugte Rechnungen fehlten, und
 * Vorschau und Export widersprachen einander.
 *
 * Der Eingang liefert nur noch das, was das Modell nicht kennt: steuerrelevante
 * Posten, die noch nicht verbucht sind (`unclear`).
 */
import { getClassificationForItem } from './documentClassificationService';
import { filterSyncActive } from './sync/syncMetaService';
import { getBusinessDay, toBusinessDay } from './businessDateService';
import { parseSafeDocumentDate } from '../utils/documentDateDisplay';
import type { InboxItem, Task } from '../types/models';
import { getAllTasksFromStore } from './taskStore';
import { isTaskOpen } from './taskNormalize';
import { collectMonatsmappeInput } from './steuerberater/monatsmappeInputService';
import {
  belegExportKey,
  buildMonatsmappeModel,
  type MonatsmappeBeleg,
  type MonatsmappeInput,
  type MonatsmappeModel,
} from './steuerberater/monatsmappeModelService';
import { evaluateAccountingExportReadiness, type AccountingExportReadiness } from './accounting/accountingExportGateService';
import {
  countHandoverOpenSteps,
  deriveSteuerberaterHandoverStatus,
  type SteuerberaterHandoverStatus,
} from './steuerberater/steuerberaterHandoverStatus';

const TAX_RELEVANT_KINDS = new Set([
  'eingangsrechnung',
  'rechnung',
  'ausgangsrechnung',
  'tankbeleg',
  'gutschrift',
  'kontoauszug',
  'quittung',
  'kassenbeleg',
  'ec_beleg',
  'kreditkartenbeleg',
]);

export interface SteuerberaterDocumentEntry {
  id: string;
  /**
   * BLOCK 2 — die **Renderidentität**, nicht die fachliche Kennung.
   *
   * Eine im selben Monat stornierte Rechnung steht zweimal in der Liste:
   * einmal als Beleg, einmal als Storno. Das ist fachlich gewollt — die
   * Monatsmappe führt beide Buchungen. Nur `id` war dafür als React-Key
   * zu wenig und kollidierte. Dieselbe Identität wie im Buchungsexport
   * (`belegart:id`), damit nicht zwei Begriffe von „derselbe Beleg"
   * entstehen.
   */
  entryKey: string;
  title: string;
  kind: string;
  monthKey: string;
  status: 'included' | 'unclear';
  /** Ziel in der App — Rechnung, Ausgabe oder Eingangsposten. */
  route: string;
}

/** Sichtbarer Monatsstatus — drei Fälle, nie „bereit" ohne Belege. */
export type SteuerberaterMonthState = 'empty' | 'open' | 'ready';

export interface SteuerberaterMonthOverview {
  year: number;
  month: number;
  monthKey: string;
  monthLabel: string;
  documentCount: number;
  documents: SteuerberaterDocumentEntry[];
  unclearDocuments: SteuerberaterDocumentEntry[];
  missingItems: { id: string; title: string }[];
  missingCount: number;
  isComplete: boolean;
  isDefaultMonth: boolean;
  completenessPercent: number;
  /**
   * `empty`: keine Belege; `ready`: Übergabe vollständig (gültig
   * abgeschlossen, keine fehlenden Nachweise, keine unklaren Fälle); sonst
   * `open`. 02B: dieselbe Quelle wie das 06C-Gate.
   */
  state: SteuerberaterMonthState;
  /** 02B — der gemeinsame Übergabestatus (Abschluss, Gate, Lücken, Bank). */
  handover: SteuerberaterHandoverStatus;
  invoiceCount: number;
  expenseCount: number;
  stornoCount: number;
  /**
   * BLOCK 2 — Zahlungen dieses Monats (Zahlungsdatum, nicht Belegdatum).
   *
   * Sie sind **keine** Belege und werden nirgends zu welchen erklärt. Sie
   * gehen aber als eigene Zeilen in `zahlungen.csv` und gehören damit zur
   * Übergabe. Ein Monat ohne Beleg, aber mit Zahlung, darf deshalb nicht
   * aussehen, als gäbe es nichts zu übergeben.
   */
  paymentCount: number;
  /**
   * FINANZ-CORE-01A (WEISS-Nacharbeit N11) — Zahlungen an Mitarbeiter dieses Monats. Sie
   * gehören zur Übergabe; ein Monat mit Mitarbeiterzahlung ist nicht „leer".
   */
  employeePaymentCount: number;
  /**
   * FINANZ-CORE-01A (WEISS-Nacharbeit N10) — offene Steueraufgaben ohne Monatsbezug (keine
   * Fälligkeit, kein verknüpfter Beleg). Sie sind ein allgemeiner Hinweis und sperren
   * keinen einzelnen Monat; vorher stand jede in jeder Monatsmappe als „fehlt".
   */
  generalTaxTasks: { id: string; title: string }[];
  /** Offene Schritte bis zur vollständigen Übergabe (Abschluss, Lücken, unklare Fälle). */
  openCount: number;
}

/** 02B — die Befunde eines Monats, die Übersicht und Steuerberater-Paket gemeinsam nutzen. */
export interface SteuerberaterMonthFindings {
  input: MonatsmappeInput;
  model: MonatsmappeModel;
  unclearDocuments: SteuerberaterDocumentEntry[];
  missingItems: { id: string; title: string }[];
  /** FINANZ-CORE-01A (WEISS-Nacharbeit N10) — Steueraufgaben ohne Monatsbezug. */
  generalTaxTasks: { id: string; title: string }[];
}

function monthKeyFromDate(iso: string): string {
  return iso.slice(0, 7);
}

function monthKeyFromParts(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N07) — der Belegmonat eines Eingangspostens.
 *
 * Maßgeblich ist das erkannte Belegdatum — dasselbe, das beim Buchen zum Datum der
 * Ausgabe wird (`officeActionService`) und damit über ihren Monat in der Monatsmappe
 * entscheidet. Bisher zählte der Upload-Tag: ein Beleg vom 30.09., am 02.10. eingegangen,
 * fehlte in der Septemberübergabe und stand im Oktober. Ohne lesbares Belegdatum gilt der
 * Eingangstag als Geschäftstag (Europe/Berlin), nie eine Handlungsfrist.
 */
function resolveItemMonth(item: Pick<InboxItem, 'receivedAt' | 'recognizedData'>): string {
  const recognized = item.recognizedData ?? {};
  const belegdatum = parseSafeDocumentDate(recognized.Datum ?? recognized.datum ?? null);
  if (belegdatum) return monthKeyFromParts(belegdatum.getFullYear(), belegdatum.getMonth() + 1);
  const eingang = toBusinessDay(item.receivedAt);
  return /^\d{4}-\d{2}/.test(eingang) ? eingang.slice(0, 7) : getBusinessDay().slice(0, 7);
}

function formatMonthLabel(monthKey: string, locale = 'de-DE'): string {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(year, month - 1, 1);
  return date.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}

/** Am 2. oder 3. des Monats den Vormonat hervorheben. */
export function getDefaultSteuerberaterMonthKey(referenceDate: Date | string = new Date()): string {
  const ref = typeof referenceDate === 'string' ? new Date(referenceDate) : referenceDate;
  const day = ref.getDate();
  if (day === 2 || day === 3) {
    const prev = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
    return monthKeyFromParts(prev.getFullYear(), prev.getMonth() + 1);
  }
  return monthKeyFromParts(ref.getFullYear(), ref.getMonth() + 1);
}

export function buildMonthKeyOptions(count = 6, referenceDate: Date | string = new Date()): string[] {
  const ref = typeof referenceDate === 'string' ? new Date(referenceDate) : referenceDate;
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
    keys.push(monthKeyFromParts(d.getFullYear(), d.getMonth() + 1));
  }
  return keys;
}

/**
 * Steuerrelevante Eingangsposten, die das Monatsmodell noch nicht als Beleg
 * führt (nicht als Ausgabe gebucht) — sie sind „unklar", nicht „enthalten".
 *
 * FINANZ-CORE-01A (WEISS-Nacharbeit N08) — auch abgelegte Posten: Ablegen ist keine
 * Buchung. Bisher verschwand ein ungebuchter Beleg aus der Übergabe, sobald er abgelegt
 * war. Erledigt ist ein Posten erst, wenn er gebucht ist (Ausgabe, in jedem Monat) oder
 * ausdrücklich mit einer Ausgabe oder Rechnung verbunden wurde.
 */
function collectUnclearInboxEntries(
  items: readonly InboxItem[],
  bookedIds: ReadonlySet<string>,
): SteuerberaterDocumentEntry[] {
  const entries: SteuerberaterDocumentEntry[] = [];
  for (const item of filterSyncActive([...items])) {
    if (bookedIds.has(item.id)) continue;
    if (item.financeReference?.confirmedAt) continue;
    const classification = getClassificationForItem(item);
    const kind = classification.classifiedKind;
    const isTaxRelevant =
      TAX_RELEVANT_KINDS.has(kind) ||
      item.recommendedAction === 'steuerberater_vorbereiten' ||
      item.documentType === 'eingangsrechnung';
    if (!isTaxRelevant) continue;
    entries.push({
      id: item.id,
      /* Ein Eingangsposten steht hier nur einmal — Kennung und Renderidentität fallen zusammen. */
      entryKey: `inbox:${item.id}`,
      title: item.title,
      kind,
      monthKey: resolveItemMonth(item),
      status: 'unclear',
      route: `/ablage/${item.id}`,
    });
  }
  return entries;
}

function belegRoute(beleg: MonatsmappeBeleg): string {
  return beleg.belegart === 'eingangsbeleg' || beleg.belegart === 'ausgabenstorno'
    ? `/ausgaben/${beleg.id}`
    : `/rechnungen/${beleg.id}`;
}

function belegEntry(beleg: MonatsmappeBeleg, monthKey: string): SteuerberaterDocumentEntry {
  const title = beleg.belegnummer ? `${beleg.belegnummer} · ${beleg.gegenpartei}` : beleg.gegenpartei;
  return {
    id: beleg.id,
    entryKey: belegExportKey(beleg),
    title,
    kind: beleg.belegart,
    monthKey,
    status: 'included',
    route: belegRoute(beleg),
  };
}

/**
 * Eingangsposten, die bereits als Ausgabe gebucht sind — nie doppelt zählen.
 *
 * FINANZ-CORE-01A (WEISS-Nacharbeit N07) — über Monatsgrenzen: Eine Buchung im
 * Belegmonat erledigt den Posten auch in jedem anderen Monat. Bisher zählten nur die
 * Ausgaben des betrachteten Monats.
 */
function bookedInboxIds(input: MonatsmappeInput): Set<string> {
  const ids = new Set<string>();
  for (const expense of input.expenses) {
    if (expense.sync?.deleted) continue;
    if (expense.linkedInboxId) ids.add(expense.linkedInboxId);
  }
  return ids;
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N10) — der Monat einer Steueraufgabe: ihre Fälligkeit,
 * sonst der Belegmonat ihres verknüpften Eingangspostens. Ohne beides hat sie keinen
 * Monatsbezug (`null`) und erscheint als allgemeiner Hinweis.
 */
function resolveTaskMonth(task: Task, inboxById: ReadonlyMap<string, InboxItem>): string | null {
  if (task.dueDate) return toBusinessDay(task.dueDate).slice(0, 7) || monthKeyFromDate(task.dueDate);
  const linked = task.linkedInboxId ? inboxById.get(task.linkedInboxId) : undefined;
  return linked ? resolveItemMonth(linked) : null;
}

function isOpenTaxTask(task: Task): boolean {
  return isTaskOpen(task) && (task.type === 'steuerberater_export' || task.category === 'steuern');
}

/** FINANZ-CORE-01A (WEISS-Nacharbeit N10) — offene Steueraufgaben ohne Monatsbezug. */
function collectGeneralTaxTasks(inboxItems: readonly InboxItem[]): { id: string; title: string }[] {
  const inboxById = new Map(inboxItems.map((item) => [item.id, item]));
  return getAllTasksFromStore()
    .filter((task) => isOpenTaxTask(task) && resolveTaskMonth(task, inboxById) === null)
    .map((task) => ({ id: task.id, title: task.title }));
}

function collectMissingForMonth(
  monthKey: string,
  model: MonatsmappeModel,
  inboxItems: readonly InboxItem[],
): { id: string; title: string }[] {
  /* Belege ohne verfügbares Dokument zählen als fehlend — wie im Export sichtbar. */
  const missing: { id: string; title: string }[] = model.fehlendeDokumente.map((entry) => ({
    id: entry.id,
    title: `Dokument fehlt: ${entry.belegnummer || entry.id}`,
  }));
  const inboxById = new Map(inboxItems.map((item) => [item.id, item]));
  for (const task of getAllTasksFromStore()) {
    if (!isOpenTaxTask(task)) continue;
    // FINANZ-CORE-01A (WEISS N10) — nur mit Monatsbezug; ohne ihn ein allgemeiner Hinweis.
    if (resolveTaskMonth(task, inboxById) !== monthKey) continue;
    missing.push({ id: task.id, title: task.title });
  }
  return missing;
}

export function collectSteuerberaterMonthFindings(monthKey: string): SteuerberaterMonthFindings {
  const input = collectMonatsmappeInput(monthKey);
  const model = buildMonatsmappeModel(input);
  const unclearDocuments = collectUnclearInboxEntries(input.inboxItems, bookedInboxIds(input)).filter(
    (doc) => doc.monthKey === monthKey,
  );
  return {
    input,
    model,
    unclearDocuments,
    missingItems: collectMissingForMonth(monthKey, model, input.inboxItems),
    generalTaxTasks: collectGeneralTaxTasks(input.inboxItems),
  };
}

/**
 * 02B — der Übergabestatus eines Monats. Unklar sind nicht gebuchte
 * steuerrelevante Eingangsposten und Stornos ohne Datum; fehlend sind Belege
 * ohne Original und offene Steuerberater-Unterlagen.
 */
export function getSteuerberaterHandoverStatus(
  monthKey: string,
  findings: SteuerberaterMonthFindings = collectSteuerberaterMonthFindings(monthKey),
  /** Systemische Gesamtnacharbeit (D9) — die Bewertung desselben Datenstands, sonst frisch. */
  readiness: AccountingExportReadiness = evaluateAccountingExportReadiness(monthKey),
): SteuerberaterHandoverStatus {
  return deriveSteuerberaterHandoverStatus({
    readiness,
    // P1-KORREKTURBLOCK A-04 — Eingangsbelege mit offener Steueraufteilung sind unklare Fälle der Übergabe.
    // A04-WEISS-R1 — ebenso ungeprüfter Altbestand (dieselbe Zählung wie das Steuerberaterpaket).
    unclearCases:
      findings.unclearDocuments.length +
      findings.model.stornosOhneDatum.length +
      (findings.model.offeneSteueraufteilung?.length ?? 0) +
      (findings.model.altbestandPruefen?.length ?? 0),
    missingProofs: findings.missingItems.length,
  });
}

export function getSteuerberaterMonthOverview(
  referenceDate: Date | string = new Date(),
  locale = 'de-DE',
  monthKeyOverride?: string,
): SteuerberaterMonthOverview {
  const defaultMonthKey = getDefaultSteuerberaterMonthKey(referenceDate);
  const monthKey = monthKeyOverride ?? defaultMonthKey;
  const [year, month] = monthKey.split('-').map(Number);
  const findings = collectSteuerberaterMonthFindings(monthKey);
  const { model } = findings;

  /* Belege = exakt das, was die Monatsmappe enthält. */
  const documents = [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos].map((beleg) =>
    belegEntry(beleg, monthKey),
  );
  const { unclearDocuments, missingItems } = findings;
  const missingCount = missingItems.length;
  const documentCount = documents.length;
  /*
   * 02B — „vollständig“ heisst: gültig abgeschlossen, Paket erlaubt, keine
   * Lücken. Vorher genügten Belege ohne Lücken; das Badge sagte dann
   * „vollständig“, während das Gate die Übergabe noch sperrte.
   */
  const handover = getSteuerberaterHandoverStatus(monthKey, findings);
  const openCount = countHandoverOpenSteps(handover);
  const isComplete = documentCount > 0 && handover.packageComplete;
  const paymentCount = model.zahlungenAusgang.length + model.zahlungenEingang.length;
  const employeePaymentCount = model.mitarbeiterZahlungen?.length ?? 0;
  /*
   * BLOCK 2 — `empty` heisst jetzt „wirklich nichts da".
   *
   * Vorher entschied allein die Belegzahl. In der Abnahme stand dadurch
   * „Noch keine Belege" über einem Monat, dessen `zahlungen.csv` eine
   * echte Zeile enthielt — der Nutzer hätte die Übergabe übersprungen.
   * Eine Zahlung macht den Monat nicht „bereit" (dafür braucht es
   * weiterhin Belege und ein offenes Gate), aber sie macht ihn auch nicht
   * leer.
   */
  /*
   * FINANZ-CORE-01A (WEISS-Nacharbeit N11) — „leer" nur, wenn keine Übergabequelle etwas
   * trägt: keine Belege, keine Zahlungen, keine Mitarbeiterzahlungen, keine ungeklärten
   * Belege, keine Stornos ohne Datum, nichts Fehlendes. Bisher hiess ein Monat mit einer
   * Mitarbeiterzahlung oder einem ungeklärten Beleg „Noch keine Belege".
   */
  const hasHandoverContent =
    documentCount > 0 ||
    paymentCount > 0 ||
    employeePaymentCount > 0 ||
    unclearDocuments.length > 0 ||
    model.stornosOhneDatum.length > 0 ||
    missingCount > 0;
  const state: SteuerberaterMonthState = !hasHandoverContent ? 'empty' : isComplete ? 'ready' : 'open';
  const completenessPercent =
    documentCount === 0 ? 0 : Math.min(100, Math.round((documentCount / (documentCount + openCount)) * 100));

  return {
    year,
    month,
    monthKey,
    monthLabel: formatMonthLabel(monthKey, locale),
    documentCount,
    documents,
    unclearDocuments,
    missingItems,
    missingCount,
    isComplete,
    isDefaultMonth: monthKey === defaultMonthKey,
    completenessPercent,
    state,
    handover,
    invoiceCount: model.ausgangsrechnungen.length,
    expenseCount: model.eingangsbelege.length,
    stornoCount: model.stornos.length,
    paymentCount,
    employeePaymentCount,
    generalTaxTasks: findings.generalTaxTasks,
    openCount,
  };
}
