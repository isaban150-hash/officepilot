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
import { filterActiveItems, getInboxItems } from './inboxService';
import { getAllTasksFromStore } from './taskStore';
import { isTaskOpen } from './taskNormalize';
import { collectMonatsmappeInput } from './steuerberater/monatsmappeInputService';
import {
  buildMonatsmappeModel,
  type MonatsmappeBeleg,
  type MonatsmappeInput,
  type MonatsmappeModel,
} from './steuerberater/monatsmappeModelService';
import { evaluateAccountingExportReadiness } from './accounting/accountingExportGateService';
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
  /** Offene Schritte bis zur vollständigen Übergabe (Abschluss, Lücken, unklare Fälle). */
  openCount: number;
}

/** 02B — die Befunde eines Monats, die Übersicht und Steuerberater-Paket gemeinsam nutzen. */
export interface SteuerberaterMonthFindings {
  input: MonatsmappeInput;
  model: MonatsmappeModel;
  unclearDocuments: SteuerberaterDocumentEntry[];
  missingItems: { id: string; title: string }[];
}

function monthKeyFromDate(iso: string): string {
  return iso.slice(0, 7);
}

function monthKeyFromParts(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function resolveItemMonth(item: { receivedAt?: string; deadline?: string | null }): string {
  const raw = item.receivedAt ?? item.deadline ?? new Date().toISOString();
  return monthKeyFromDate(raw);
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
 */
function collectUnclearInboxEntries(bookedIds: ReadonlySet<string>): SteuerberaterDocumentEntry[] {
  const entries: SteuerberaterDocumentEntry[] = [];
  for (const item of filterActiveItems(getInboxItems())) {
    if (bookedIds.has(item.id)) continue;
    const classification = getClassificationForItem(item);
    const kind = classification.classifiedKind;
    const isTaxRelevant =
      TAX_RELEVANT_KINDS.has(kind) ||
      item.recommendedAction === 'steuerberater_vorbereiten' ||
      item.documentType === 'eingangsrechnung';
    if (!isTaxRelevant) continue;
    entries.push({
      id: item.id,
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
  return { id: beleg.id, title, kind: beleg.belegart, monthKey, status: 'included', route: belegRoute(beleg) };
}

/** Eingangsposten, die bereits als Ausgabe im Modell stehen — nie doppelt zählen. */
function bookedInboxIds(model: MonatsmappeModel, input: MonatsmappeInput): Set<string> {
  const belegIds = new Set([...model.eingangsbelege, ...model.stornos].map((beleg) => beleg.id));
  const ids = new Set<string>();
  for (const expense of input.expenses) {
    if (belegIds.has(expense.id) && expense.linkedInboxId) ids.add(expense.linkedInboxId);
  }
  return ids;
}

function collectMissingForMonth(monthKey: string, model: MonatsmappeModel): { id: string; title: string }[] {
  /* Belege ohne verfügbares Dokument zählen als fehlend — wie im Export sichtbar. */
  const missing: { id: string; title: string }[] = model.fehlendeDokumente.map((entry) => ({
    id: entry.id,
    title: `Dokument fehlt: ${entry.belegnummer || entry.id}`,
  }));
  for (const task of getAllTasksFromStore()) {
    if (!isTaskOpen(task)) continue;
    if (task.type !== 'steuerberater_export' && task.category !== 'steuern') continue;
    if (task.dueDate && monthKeyFromDate(task.dueDate) !== monthKey) continue;
    missing.push({ id: task.id, title: task.title });
  }
  return missing;
}

export function collectSteuerberaterMonthFindings(monthKey: string): SteuerberaterMonthFindings {
  const input = collectMonatsmappeInput(monthKey);
  const model = buildMonatsmappeModel(input);
  const unclearDocuments = collectUnclearInboxEntries(bookedInboxIds(model, input)).filter(
    (doc) => doc.monthKey === monthKey,
  );
  return { input, model, unclearDocuments, missingItems: collectMissingForMonth(monthKey, model) };
}

/**
 * 02B — der Übergabestatus eines Monats. Unklar sind nicht gebuchte
 * steuerrelevante Eingangsposten und Stornos ohne Datum; fehlend sind Belege
 * ohne Original und offene Steuerberater-Unterlagen.
 */
export function getSteuerberaterHandoverStatus(
  monthKey: string,
  findings: SteuerberaterMonthFindings = collectSteuerberaterMonthFindings(monthKey),
): SteuerberaterHandoverStatus {
  return deriveSteuerberaterHandoverStatus({
    readiness: evaluateAccountingExportReadiness(monthKey),
    unclearCases: findings.unclearDocuments.length + findings.model.stornosOhneDatum.length,
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
  const state: SteuerberaterMonthState = documentCount === 0 ? 'empty' : isComplete ? 'ready' : 'open';
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
    openCount,
  };
}
