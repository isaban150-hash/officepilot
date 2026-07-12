import { getClassificationForItem } from './documentClassificationService';
import { filterActiveItems, getInboxItems } from './inboxService';
import { getAllTasksFromStore } from './taskStore';
import { isTaskOpen } from './taskNormalize';

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
}

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

function collectTaxDocuments(): SteuerberaterDocumentEntry[] {
  const entries: SteuerberaterDocumentEntry[] = [];
  for (const item of filterActiveItems(getInboxItems())) {
    const classification = getClassificationForItem(item);
    const kind = classification.classifiedKind;
    const isTaxRelevant =
      TAX_RELEVANT_KINDS.has(kind) ||
      item.recommendedAction === 'steuerberater_vorbereiten' ||
      item.documentType === 'eingangsrechnung';
    if (!isTaxRelevant) continue;
    const monthKey = resolveItemMonth(item);
    const unclear =
      item.recommendedAction === 'steuerberater_vorbereiten' ||
      !TAX_RELEVANT_KINDS.has(kind);
    entries.push({
      id: item.id,
      title: item.title,
      kind,
      monthKey,
      status: unclear ? 'unclear' : 'included',
    });
  }
  return entries;
}

function collectMissingForMonth(monthKey: string): { id: string; title: string }[] {
  const missing: { id: string; title: string }[] = [];
  for (const task of getAllTasksFromStore()) {
    if (!isTaskOpen(task)) continue;
    if (task.type !== 'steuerberater_export' && task.category !== 'steuern') continue;
    if (task.dueDate && monthKeyFromDate(task.dueDate) !== monthKey) continue;
    missing.push({ id: task.id, title: task.title });
  }
  return missing;
}

export function getSteuerberaterMonthOverview(
  referenceDate: Date | string = new Date(),
  locale = 'de-DE',
  monthKeyOverride?: string,
): SteuerberaterMonthOverview {
  const defaultMonthKey = getDefaultSteuerberaterMonthKey(referenceDate);
  const monthKey = monthKeyOverride ?? defaultMonthKey;
  const [year, month] = monthKey.split('-').map(Number);
  const allDocs = collectTaxDocuments().filter((doc) => doc.monthKey === monthKey);
  const documents = allDocs.filter((doc) => doc.status === 'included');
  const unclearDocuments = allDocs.filter((doc) => doc.status === 'unclear');
  const missingItems = collectMissingForMonth(monthKey);
  const missingCount = missingItems.length;
  const isComplete = allDocs.length > 0 && missingCount === 0 && unclearDocuments.length === 0;
  const totalExpected = Math.max(allDocs.length + missingCount, allDocs.length > 0 ? allDocs.length : 1);
  const completenessPercent = Math.min(
    100,
    Math.round(((allDocs.length - unclearDocuments.length) / totalExpected) * 100),
  );

  return {
    year,
    month,
    monthKey,
    monthLabel: formatMonthLabel(monthKey, locale),
    documentCount: allDocs.length,
    documents,
    unclearDocuments,
    missingItems,
    missingCount,
    isComplete,
    isDefaultMonth: monthKey === defaultMonthKey,
    completenessPercent,
  };
}
